import * as vscode from "vscode";
import { AuthManager, createPkcePair } from "../auth/authManager";
import {
  DeploymentDetails,
  DeploymentProviderAdapter,
  DeploymentSummary,
  HostedProject,
  ProjectScope
} from "../core/types";
import { HttpError, isRateLimitedOrServerError, requestJson, withRetry } from "../core/http";

interface NetlifySite {
  id?: string;
  name?: string;
  repo?: {
    provider?: string;
    owner?: string;
    repo?: string;
    branch?: string;
  };
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseEnvironment(context: unknown): "production" | "preview" | "staging" | string {
  const value = toText(context)?.toLowerCase();

  if (value === "production") {
    return "production";
  }

  if (value === "branch-deploy") {
    return "staging";
  }

  return "preview";
}

function parseState(raw: unknown): "queued" | "building" | "ready" | "failed" | "canceled" {
  const value = toText(raw)?.toLowerCase() ?? "";

  if (value.includes("error") || value.includes("fail")) {
    return "failed";
  }

  if (value.includes("ready") || value.includes("published") || value.includes("success")) {
    return "ready";
  }

  if (value.includes("cancel")) {
    return "canceled";
  }

  if (value.includes("queue") || value.includes("new")) {
    return "queued";
  }

  return "building";
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

function mapDeploy(siteId: string, raw: Record<string, unknown>): DeploymentSummary {
  const deploymentId = toText(raw.id) ?? `${siteId}-${Date.now()}`;
  const updatedAt = toText(raw.updated_at) ?? toText(raw.published_at) ?? new Date().toISOString();
  const createdAt = toText(raw.created_at) ?? updatedAt;

  return {
    provider: "netlify",
    projectId: siteId,
    environment: parseEnvironment(raw.context),
    deploymentId,
    state: parseState(raw.state),
    url: toText(raw.ssl_url) ?? toText(raw.deploy_ssl_url) ?? toText(raw.url),
    commitSha: toText(raw.commit_ref),
    commitMessage: toText(raw.title) ?? toText(raw.message),
    author: toText(raw.branch),
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString()
  };
}

export class NetlifyAdapter implements DeploymentProviderAdapter {
  public readonly id = "netlify";
  public readonly displayName = "Netlify";

  private readonly authManager: AuthManager;

  public constructor(authManager: AuthManager) {
    this.authManager = authManager;
  }

  public async authenticate() {
    const configuration = vscode.workspace.getConfiguration("deployify.providers.netlify");
    const authMode = configuration.get<"oauth" | "token">("authMode", "oauth");

    if (authMode === "token") {
      return this.authManager.beginDeviceLikeLogin(
        this.id,
        "https://app.netlify.com/user/applications#personal-access-tokens",
        "Paste your Netlify personal access token"
      );
    }

    const clientId = configuration.get<string>("oauthClientId", "").trim();
    const clientSecret = configuration.get<string>("oauthClientSecret", "").trim();
    const scope = configuration.get<string>("oauthScopes", "read_site").trim();
    const grantType = configuration.get<"implicit" | "authorization_code">("oauthGrantType", "implicit");
    const tokenEndpoint = configuration.get<string>("oauthTokenEndpoint", "https://api.netlify.com/oauth/token").trim();

    if (!clientId) {
      throw new Error(
        "Set deployify.providers.netlify.oauthClientId in settings before connecting Netlify with OAuth."
      );
    }

    const pkce = grantType === "authorization_code" ? createPkcePair() : undefined;
    const callback = await this.authManager.beginOAuthFlow({
      provider: this.id,
      authorizeEndpoint: "https://app.netlify.com/authorize",
      authorizeQuery: {
        response_type: grantType === "authorization_code" ? "code" : "token",
        client_id: clientId,
        scope: scope || undefined,
        code_challenge: pkce?.challenge,
        code_challenge_method: pkce?.method
      }
    });

    let accessToken = callback.fragmentParams.get("access_token") ?? callback.queryParams.get("access_token");
    let expiresInRaw = callback.fragmentParams.get("expires_in") ?? callback.queryParams.get("expires_in");

    if (!accessToken && grantType === "authorization_code") {
      const code = callback.queryParams.get("code");
      if (!code) {
        throw new Error("Netlify OAuth callback did not return an access token or authorization code.");
      }

      if (!clientSecret) {
        throw new Error(
          "Set deployify.providers.netlify.oauthClientSecret for authorization_code flow, or switch oauthGrantType to implicit."
        );
      }

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callback.redirectUri
      });

      if (pkce?.verifier) {
        body.set("code_verifier", pkce.verifier);
      }

      const tokenResponse = await requestJson<{
        access_token?: string;
        expires_in?: number | string;
      }>(tokenEndpoint, {
        method: "POST",
        rawBody: body.toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        }
      });

      accessToken = tokenResponse.access_token ?? null;
      expiresInRaw =
        tokenResponse.expires_in === undefined ? null : String(tokenResponse.expires_in);
    }

    if (!accessToken) {
      throw new Error("Netlify OAuth did not return an access token.");
    }

    const expiresIn = expiresInRaw ? Number.parseInt(expiresInRaw, 10) : Number.NaN;
    const createdAt = new Date();
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

  public async logout(): Promise<void> {
    await this.authManager.clearSession(this.id);
  }

  public async getProjects(_scope: ProjectScope): Promise<HostedProject[]> {
    const token = await this.getTokenOrThrow();
    const response = await safeApiRequest<NetlifySite[]>("https://api.netlify.com/api/v1/sites?per_page=100", token);

    return response
      .filter((site) => Boolean(site.id && site.name))
      .map((site) => ({
        provider: this.id,
        projectId: site.id!,
        name: site.name!,
        environments: [
          { id: "production", name: "Production", type: "production" },
          { id: "preview", name: "Preview", type: "preview" },
          { id: "staging", name: "Branch Deploy", type: "staging" }
        ],
        repo: site.repo?.owner && site.repo.repo
          ? {
              owner: site.repo.owner,
              name: site.repo.repo,
              branch: site.repo.branch
            }
          : undefined
      }));
  }

  public async getLatestDeployments(projectIds: string[]): Promise<DeploymentSummary[]> {
    const token = await this.getTokenOrThrow();

    const all = await Promise.all(
      projectIds.map(async (projectId) => {
        const endpoint = `https://api.netlify.com/api/v1/sites/${encodeURIComponent(projectId)}/deploys?per_page=8`;
        const response = await safeApiRequest<Array<Record<string, unknown>>>(endpoint, token);
        const mapped = response.map((deploy) => mapDeploy(projectId, deploy));

        const byEnvironment = new Map<string, DeploymentSummary>();
        for (const deployment of mapped) {
          const existing = byEnvironment.get(deployment.environment);
          if (!existing || existing.updatedAt < deployment.updatedAt) {
            byEnvironment.set(deployment.environment, deployment);
          }
        }

        return [...byEnvironment.values()];
      })
    );

    return all.flat();
  }

  public async getDeploymentDetails(deploymentId: string): Promise<DeploymentDetails> {
    const token = await this.getTokenOrThrow();

    try {
      const raw = await safeApiRequest<Record<string, unknown>>(
        `https://api.netlify.com/api/v1/deploys/${encodeURIComponent(deploymentId)}`,
        token
      );
      const projectId = toText(raw.site_id) ?? "unknown-project";
      const summary = mapDeploy(projectId, raw);

      return {
        ...summary,
        projectUrl: toText(raw.admin_url) ?? "https://app.netlify.com/sites",
        logsUrl: toText(raw.logs) ?? toText(raw.deploy_log_url),
        diagnostics: [toText(raw.error_message), toText(raw.state)].filter(Boolean) as string[],
        raw
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
          diagnostics: ["Deployment details were not found. It may have been deleted."],
          projectUrl: "https://app.netlify.com/sites"
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
      await vscode.env.openExternal(vscode.Uri.parse(`https://app.netlify.com/sites/*/deploys/${encodeURIComponent(id)}`));
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse("https://app.netlify.com/sites"));
  }

  private async getTokenOrThrow(): Promise<string> {
    const token = await this.authManager.getAccessToken(this.id);

    if (!token) {
      throw new Error("Netlify is not connected.");
    }

    return token;
  }
}
