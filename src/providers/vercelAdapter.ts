import * as vscode from "vscode";
import { AuthManager, createPkcePair } from "../auth/authManager";
import { ResolvedOAuthConfig, resolveOAuthConfig } from "../auth/oauthClientRegistry";
import {
  DeploymentDetails,
  DeploymentProviderAdapter,
  DeploymentSummary,
  HostedProject,
  ProjectScope
} from "../core/types";
import { HttpError, isRateLimitedOrServerError, requestJson, withRetry } from "../core/http";

interface VercelProjectResponse {
  projects?: Array<{
    id?: string;
    name?: string;
    link?: {
      repo?: string;
      org?: string;
      repoId?: number;
      projectSlug?: string;
    };
  }>;
}

interface VercelDeploymentsResponse {
  deployments?: Array<Record<string, unknown>>;
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseEnvironment(raw: unknown): "production" | "preview" | "staging" | string {
  const value = toText(raw)?.toLowerCase();
  if (value === "production") {
    return "production";
  }

  if (value === "staging") {
    return "staging";
  }

  return "preview";
}

function parseState(raw: unknown): "queued" | "building" | "ready" | "failed" | "canceled" {
  const value = toText(raw)?.toLowerCase() ?? "";

  if (value.includes("error") || value.includes("fail")) {
    return "failed";
  }

  if (value.includes("ready") || value.includes("success")) {
    return "ready";
  }

  if (value.includes("cancel")) {
    return "canceled";
  }

  if (value.includes("queue") || value.includes("pending")) {
    return "queued";
  }

  return "building";
}

function mapDeployment(projectId: string, raw: Record<string, unknown>): DeploymentSummary {
  const deploymentId = toText(raw.uid) ?? toText(raw.id) ?? `${projectId}-${Date.now()}`;
  const domain = toText(raw.url);
  const createdAt = Number(raw.createdAt ?? Date.now());
  const updatedAt = Number(raw.ready ?? raw.createdAt ?? Date.now());
  const meta = (raw.meta ?? {}) as Record<string, unknown>;

  return {
    provider: "vercel",
    projectId,
    environment: parseEnvironment(raw.target),
    deploymentId,
    state: parseState(raw.readyState ?? raw.state),
    url: domain ? `https://${domain.replace(/^https?:\/\//, "")}` : undefined,
    commitSha: toText(meta.githubCommitSha) ?? toText(meta.gitlabCommitSha) ?? toText(meta.bitbucketCommitSha),
    commitMessage: toText(meta.githubCommitMessage) ?? toText(meta.gitlabCommitMessage),
    author: toText(meta.githubCommitAuthorName) ?? toText(meta.gitlabCommitAuthorName),
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString()
  };
}

async function safeApiRequest<T>(url: string, token: string): Promise<T> {
  return withRetry(
    async () =>
      requestJson<T>(url, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }),
    3,
    500,
    isRateLimitedOrServerError
  );
}

export class VercelAdapter implements DeploymentProviderAdapter {
  public readonly id = "vercel";
  public readonly displayName = "Vercel";

  private readonly authManager: AuthManager;
  private readonly extensionId: string;

  public constructor(authManager: AuthManager, extensionId: string) {
    this.authManager = authManager;
    this.extensionId = extensionId;
  }

  public async authenticate() {
    const oauth = resolveOAuthConfig(this.extensionId, this.id);
    if (!oauth) {
      throw new Error("Vercel sign-in is not enabled in this build yet.");
    }

    if (oauth.strategy === "broker") {
      return this.authenticateViaBroker(oauth);
    }

    return this.authenticateDirect(oauth);
  }

  private async authenticateViaBroker(oauth: Extract<ResolvedOAuthConfig, { strategy: "broker" }>) {
    const callback = await this.authManager.beginOAuthFlow({
      provider: this.id,
      authorizeEndpoint: oauth.startEndpoint,
      authorizeQuery: {
        provider: this.id,
        extension_id: this.extensionId
      }
    });

    const directToken = callback.fragmentParams.get("access_token") ?? callback.queryParams.get("access_token");
    const expiresRaw = callback.fragmentParams.get("expires_in") ?? callback.queryParams.get("expires_in");

    let accessToken = directToken;
    let expiresInRaw = expiresRaw;

    if (!accessToken) {
      const brokerCode = callback.queryParams.get("broker_code") ?? callback.queryParams.get("code");
      if (!brokerCode) {
        throw new Error("Vercel broker auth callback did not return an access token or broker code.");
      }

      const exchange = await requestJson<{
        access_token?: string;
        expires_in?: number | string;
        account_label?: string;
      }>(oauth.exchangeEndpoint, {
        method: "POST",
        body: {
          provider: this.id,
          broker_code: brokerCode,
          code: brokerCode,
          redirect_uri: callback.redirectUri,
          extension_id: this.extensionId
        }
      });

      accessToken = exchange.access_token ?? null;
      expiresInRaw = exchange.expires_in === undefined ? null : String(exchange.expires_in);
    }

    if (!accessToken) {
      throw new Error("Vercel broker auth did not return an access token.");
    }

    const createdAt = new Date();
    const expiresIn = expiresInRaw ? Number.parseInt(expiresInRaw, 10) : Number.NaN;
    const session = {
      provider: this.id,
      accessToken,
      createdAt: createdAt.toISOString(),
      expiresAt: Number.isFinite(expiresIn)
        ? new Date(createdAt.getTime() + expiresIn * 1000).toISOString()
        : undefined
    };

    await this.authManager.setSession(session);
    return session;
  }

  private async authenticateDirect(oauth: Extract<ResolvedOAuthConfig, { strategy: "direct" }>) {

    const pkce = oauth.usePkce ? createPkcePair() : undefined;
    const callback = await this.authManager.beginOAuthFlow({
      provider: this.id,
      authorizeEndpoint: oauth.authorizeEndpoint,
      authorizeQuery: {
        response_type: oauth.responseType,
        client_id: oauth.clientId,
        scope: oauth.scope || undefined,
        code_challenge: pkce?.challenge,
        code_challenge_method: pkce?.method
      }
    });

    const code = callback.queryParams.get("code");
    if (!code) {
      throw new Error("Vercel OAuth callback did not return an authorization code.");
    }

    if (!oauth.tokenEndpoint) {
      throw new Error("Vercel OAuth token endpoint is not configured in this build.");
    }

    const tokenResponse = await requestJson<{
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
    }>(oauth.tokenEndpoint, {
      method: "POST",
      body: {
        code,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret || undefined,
        redirect_uri: callback.redirectUri,
        grant_type: "authorization_code",
        code_verifier: pkce?.verifier
      }
    });

    const accessToken = tokenResponse.access_token;
    if (!accessToken) {
      throw new Error("Vercel OAuth token exchange did not return an access token.");
    }

    const createdAt = new Date();
    const session = {
      provider: this.id,
      accessToken,
      createdAt: createdAt.toISOString(),
      expiresAt:
        typeof tokenResponse.expires_in === "number"
          ? new Date(createdAt.getTime() + tokenResponse.expires_in * 1000).toISOString()
          : undefined
    };

    await this.authManager.setSession(session);
    return session;
  }

  public async logout(): Promise<void> {
    await this.authManager.clearSession(this.id);
  }

  public async getProjects(_scope: ProjectScope): Promise<HostedProject[]> {
    const token = await this.getTokenOrThrow();
    const response = await safeApiRequest<VercelProjectResponse>("https://api.vercel.com/v9/projects?limit=100", token);
    const projects = response.projects ?? [];

    return projects
      .filter((project) => Boolean(project.id && project.name))
      .map((project) => {
        const repo = project.link?.repo;
        const repoParts = repo?.split("/") ?? [];

        return {
          provider: this.id,
          projectId: project.id!,
          name: project.name!,
          environments: [
            { id: "production", name: "Production", type: "production" },
            { id: "preview", name: "Preview", type: "preview" }
          ],
          repo:
            repoParts.length >= 2
              ? {
                  owner: repoParts[0],
                  name: repoParts[1]
                }
              : undefined
        };
      });
  }

  public async getLatestDeployments(projectIds: string[]): Promise<DeploymentSummary[]> {
    const token = await this.getTokenOrThrow();

    const results = await Promise.all(
      projectIds.map(async (projectId) => {
        const endpoint = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=8`;
        const response = await safeApiRequest<VercelDeploymentsResponse>(endpoint, token);
        return (response.deployments ?? []).map((deployment) => mapDeployment(projectId, deployment));
      })
    );

    return results.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async getDeploymentDetails(deploymentId: string): Promise<DeploymentDetails> {
    const token = await this.getTokenOrThrow();

    try {
      const details = await safeApiRequest<Record<string, unknown>>(
        `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}`,
        token
      );
      const projectId = toText(details.projectId) ?? "unknown-project";
      const summary = mapDeployment(projectId, details);

      return {
        ...summary,
        projectUrl: `https://vercel.com/dashboard`,
        logsUrl: `https://vercel.com/dashboard/deployments/${encodeURIComponent(deploymentId)}`,
        diagnostics: [toText(details.errorCode), toText(details.errorMessage)].filter(Boolean) as string[],
        raw: details
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) {
        return {
          provider: this.id,
          projectId: "unknown-project",
          environment: "preview",
          deploymentId,
          state: "failed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          diagnostics: ["Deployment details were not found. It may no longer exist."],
          projectUrl: "https://vercel.com/dashboard"
        };
      }

      throw error;
    }
  }

  public async openInBrowser(target: "deployment" | "project", id: string): Promise<void> {
    if (id.startsWith("http://") || id.startsWith("https://")) {
      await vscode.env.openExternal(vscode.Uri.parse(id));
      return;
    }

    if (target === "deployment") {
      await vscode.env.openExternal(vscode.Uri.parse(`https://vercel.com/dashboard/deployments/${encodeURIComponent(id)}`));
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse("https://vercel.com/dashboard"));
  }

  private async getTokenOrThrow(): Promise<string> {
    const token = await this.authManager.getAccessToken(this.id);

    if (!token) {
      throw new Error("Vercel is not connected.");
    }

    return token;
  }
}
