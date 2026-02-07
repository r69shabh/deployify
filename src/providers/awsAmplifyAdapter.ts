import * as vscode from "vscode";
import {
  AmplifyClient,
  GetJobCommand,
  ListAppsCommand,
  ListAppsCommandOutput,
  ListBranchesCommand,
  ListJobsCommand
} from "@aws-sdk/client-amplify";
import { fromIni } from "@aws-sdk/credential-providers";
import { AuthManager } from "../auth/authManager";
import {
  DeploymentDetails,
  DeploymentProviderAdapter,
  DeploymentSummary,
  HostedProject,
  ProjectScope
} from "../core/types";

function toIso(value: Date | string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function mapState(status: string | undefined): "queued" | "building" | "ready" | "failed" | "canceled" {
  const normalized = (status ?? "").toUpperCase();

  if (normalized.includes("SUCCEED") || normalized.includes("SUCCESS")) {
    return "ready";
  }

  if (normalized.includes("FAIL") || normalized.includes("ERROR")) {
    return "failed";
  }

  if (normalized.includes("CANCEL")) {
    return "canceled";
  }

  if (normalized.includes("PENDING") || normalized.includes("PROVISIONING")) {
    return "queued";
  }

  return "building";
}

function mapEnvironment(branchName: string, stage?: string): "production" | "preview" | "staging" | string {
  const normalizedStage = (stage ?? "").toUpperCase();

  if (normalizedStage === "PRODUCTION") {
    return "production";
  }

  if (normalizedStage === "BETA" || branchName.toLowerCase().includes("stage")) {
    return "staging";
  }

  return branchName || "preview";
}

function historyId(appId: string, branchName: string, jobId: string): string {
  return `${appId}|${branchName}|${jobId}`;
}

function parseHistoryId(encoded: string): { appId: string; branchName: string; jobId: string } | undefined {
  const [appId, branchName, jobId] = encoded.split("|");
  if (!appId || !branchName || !jobId) {
    return undefined;
  }

  return { appId, branchName, jobId };
}

interface AmplifyJobLike {
  jobId?: string;
  status?: string;
  commitId?: string;
  commitMessage?: string;
  startTime?: Date | string;
  endTime?: Date | string;
}

function mapJobSummary(
  appId: string,
  branchName: string,
  stage: string | undefined,
  webUrl: string | undefined,
  job: AmplifyJobLike
): DeploymentSummary {
  const jobId = job.jobId ?? `${Date.now()}`;

  return {
    provider: "awsAmplify",
    projectId: appId,
    environment: mapEnvironment(branchName, stage),
    deploymentId: historyId(appId, branchName, jobId),
    state: mapState(job.status),
    url: webUrl,
    commitSha: job.commitId,
    commitMessage: job.commitMessage,
    author: branchName,
    createdAt: toIso(job.startTime),
    updatedAt: toIso(job.endTime ?? job.startTime),
  };
}

export class AwsAmplifyAdapter implements DeploymentProviderAdapter {
  public readonly id = "awsAmplify";
  public readonly displayName = "AWS Amplify";

  private readonly authManager: AuthManager;

  public constructor(authManager: AuthManager) {
    this.authManager = authManager;
  }

  public async authenticate() {
    const client = this.createClient();

    try {
      await client.send(new ListAppsCommand({ maxResults: 1 }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to access AWS Amplify API.";
      throw new Error(
        `AWS Amplify auth failed. Configure AWS credentials (for example via AWS CLI/SAML/SSO) and retry. ${message}`
      );
    }

    const session = {
      provider: this.id,
      accessToken: "aws-credentials",
      createdAt: new Date().toISOString(),
      accountLabel: this.getConfiguredProfile() || "default"
    };

    await this.authManager.setSession(session);
    return session;
  }

  public async logout(): Promise<void> {
    await this.authManager.clearSession(this.id);
  }

  public async getProjects(_scope: ProjectScope): Promise<HostedProject[]> {
    const client = this.createClient();
    const output = await client.send(new ListAppsCommand({ maxResults: 100 }));

    const apps = output.apps ?? [];
    const projects: HostedProject[] = [];

    for (const app of apps) {
      const appId = app.appId;
      const appName = app.name;

      if (!appId || !appName) {
        continue;
      }

      let branchesOutput;
      try {
        branchesOutput = await client.send(new ListBranchesCommand({ appId, maxResults: 25 }));
      } catch {
        branchesOutput = undefined;
      }

      const environments = (branchesOutput?.branches ?? []).map((branch) => ({
        id: branch.branchName ?? "unknown",
        name: branch.displayName ?? branch.branchName ?? "Branch",
        type: mapEnvironment(branch.branchName ?? "preview", branch.stage)
      }));

      projects.push({
        provider: this.id,
        projectId: appId,
        name: appName,
        environments: environments.length > 0 ? environments : [{ id: "production", name: "Production", type: "production" }],
        repo: app.repository ? this.parseRepo(app.repository) : undefined
      });
    }

    return projects;
  }

  public async getLatestDeployments(projectIds: string[]): Promise<DeploymentSummary[]> {
    const client = this.createClient();

    const appMap = await this.getAppMap(client);

    const allDeployments = await Promise.all(
      projectIds.map(async (appId) => {
        const appInfo = appMap.get(appId);
        const appDefaultDomain = appInfo?.defaultDomain;
        const branchResult = await client.send(new ListBranchesCommand({ appId, maxResults: 25 }));

        const branchDeployments = await Promise.all(
          (branchResult.branches ?? []).map(async (branch) => {
            const branchName = branch.branchName;
            if (!branchName) {
              return [] as DeploymentSummary[];
            }

            const jobs = await client.send(new ListJobsCommand({ appId, branchName, maxResults: 10 }));
            const webUrl = appDefaultDomain ? `https://${branchName}.${appDefaultDomain}` : undefined;

            return (jobs.jobSummaries ?? []).map((job) =>
              mapJobSummary(appId, branchName, branch.stage, webUrl, job)
            );
          })
        );

        return branchDeployments.flat();
      })
    );

    return allDeployments.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async getDeploymentDetails(deploymentId: string): Promise<DeploymentDetails> {
    const parsed = parseHistoryId(deploymentId);

    if (!parsed) {
      throw new Error("Invalid AWS Amplify deployment identifier.");
    }

    const client = this.createClient();
    const job = await client.send(
      new GetJobCommand({
        appId: parsed.appId,
        branchName: parsed.branchName,
        jobId: parsed.jobId
      })
    );

    const summary = mapJobSummary(
      parsed.appId,
      parsed.branchName,
      undefined,
      undefined,
      job.job?.summary ?? { jobId: parsed.jobId, status: "PENDING" }
    );

    const diagnostics = [job.job?.summary?.status, job.job?.summary?.sourceUrl].filter(Boolean) as string[];

    const logUrl = job.job?.steps?.find((step) => Boolean(step.logUrl))?.logUrl;

    return {
      ...summary,
      diagnostics,
      logsUrl: logUrl,
      projectUrl: this.projectConsoleUrl(parsed.appId),
      raw: job
    };
  }

  public async openInBrowser(target: "deployment" | "project", id: string): Promise<void> {
    if (target === "project") {
      await vscode.env.openExternal(vscode.Uri.parse(this.projectConsoleUrl(id)));
      return;
    }

    const parsed = parseHistoryId(id);
    if (parsed) {
      const detailsUrl = `${this.projectConsoleUrl(parsed.appId)}/branches/${encodeURIComponent(parsed.branchName)}/deployments/${encodeURIComponent(parsed.jobId)}`;
      await vscode.env.openExternal(vscode.Uri.parse(detailsUrl));
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(this.baseConsoleUrl()));
  }

  private createClient(): AmplifyClient {
    const region = this.getConfiguredRegion();
    const profile = this.getConfiguredProfile();

    if (profile) {
      return new AmplifyClient({
        region,
        credentials: fromIni({ profile })
      });
    }

    return new AmplifyClient({ region });
  }

  private getConfiguredRegion(): string {
    return vscode.workspace.getConfiguration("deployify.providers.awsAmplify").get<string>("region", "us-east-1").trim() || "us-east-1";
  }

  private getConfiguredProfile(): string {
    return vscode.workspace.getConfiguration("deployify.providers.awsAmplify").get<string>("profile", "").trim();
  }

  private async getAppMap(client: AmplifyClient): Promise<Map<string, { name: string; defaultDomain?: string }>> {
    const output: ListAppsCommandOutput = await client.send(new ListAppsCommand({ maxResults: 100 }));
    const map = new Map<string, { name: string; defaultDomain?: string }>();

    for (const app of output.apps ?? []) {
      if (app.appId && app.name) {
        map.set(app.appId, {
          name: app.name,
          defaultDomain: app.defaultDomain
        });
      }
    }

    return map;
  }

  private parseRepo(repository: string): HostedProject["repo"] | undefined {
    const segments = repository.replace(/\.git$/, "").split("/").filter(Boolean);
    if (segments.length < 2) {
      return undefined;
    }

    return {
      owner: segments[segments.length - 2],
      name: segments[segments.length - 1]
    };
  }

  private baseConsoleUrl(): string {
    const region = this.getConfiguredRegion();
    return `https://${region}.console.aws.amazon.com/amplify/home?region=${region}`;
  }

  private projectConsoleUrl(appId: string): string {
    const region = this.getConfiguredRegion();
    return `https://${region}.console.aws.amazon.com/amplify/home?region=${region}#/d2h/${encodeURIComponent(appId)}`;
  }
}
