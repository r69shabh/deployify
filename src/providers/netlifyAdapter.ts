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
  private readonly extensionId: string;

  public constructor(authManager: AuthManager, extensionId: string) {
    this.authManager = authManager;
    this.extensionId = extensionId;
  }

  public async authenticate() {
    const oauth = resolveOAuthConfig(this.extensionId, this.id);
    if (!oauth) {
      throw new Error("Netlify sign-in is not enabled in this build yet.");
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
        throw new Error("Netlify broker auth callback did not return an access token or broker code.");
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
      throw new Error("Netlify broker auth did not return an access token.");
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

    let accessToken = callback.fragmentParams.get("access_token") ?? callback.queryParams.get("access_token");
    let expiresInRaw = callback.fragmentParams.get("expires_in") ?? callback.queryParams.get("expires_in");

    if (!accessToken && oauth.responseType === "code") {
      const code = callback.queryParams.get("code");
      if (!code) {
        throw new Error("Netlify OAuth callback did not return an access token or authorization code.");
      }

      if (!oauth.tokenEndpoint) {
        throw new Error("Netlify OAuth token endpoint is not configured in this build.");
      }

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: oauth.clientId,
        redirect_uri: callback.redirectUri
      });

      if (oauth.clientSecret) {
        body.set("client_secret", oauth.clientSecret);
      }

      if (pkce?.verifier) {
        body.set("code_verifier", pkce.verifier);
      }

      const tokenResponse = await requestJson<{
        access_token?: string;
        expires_in?: number | string;
      }>(oauth.tokenEndpoint, {
        method: "POST",
        rawBody: body.toString()
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
        return response.map((deploy) => mapDeploy(projectId, deploy));
      })
    );

    return all.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
