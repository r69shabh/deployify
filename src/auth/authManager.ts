import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { AuthSession, ProviderId } from "../core/types";

function keyForProvider(provider: ProviderId): string {
  return `deployify.auth.${provider}`;
}

interface PendingOAuthFlow {
  provider: ProviderId;
  state: string;
  redirectUri: string;
  timeout: NodeJS.Timeout;
  resolve: (result: OAuthCallbackResult) => void;
  reject: (error: unknown) => void;
}

export interface OAuthFlowOptions {
  provider: ProviderId;
  authorizeEndpoint: string;
  authorizeQuery?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface OAuthCallbackResult {
  provider: ProviderId;
  redirectUri: string;
  state: string;
  queryParams: URLSearchParams;
  fragmentParams: URLSearchParams;
  callbackUri: vscode.Uri;
}

function randomHex(size: number): string {
  return crypto.randomBytes(size).toString("hex");
}

function parseProviderFromPath(pathname: string): ProviderId | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && segments[0] === "deployify-auth") {
    return segments[1];
  }

  return undefined;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64UrlEncode(crypto.randomBytes(48));
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export class AuthManager implements vscode.Disposable {
  private readonly secretStorage: vscode.SecretStorage;
  private readonly extensionId: string;
  private readonly uriHandler: vscode.Disposable;
  private readonly pendingFlowsByState = new Map<string, PendingOAuthFlow>();

  public constructor(secretStorage: vscode.SecretStorage, extensionId: string) {
    this.secretStorage = secretStorage;
    this.extensionId = extensionId;

    this.uriHandler = vscode.window.registerUriHandler({
      handleUri: (uri) => this.handleUri(uri)
    });
  }

  public dispose(): void {
    for (const flow of this.pendingFlowsByState.values()) {
      clearTimeout(flow.timeout);
      flow.reject(new Error("OAuth request canceled because the extension was disposed."));
    }

    this.pendingFlowsByState.clear();
    this.uriHandler.dispose();
  }

  public async getSession(provider: ProviderId): Promise<AuthSession | undefined> {
    const raw = await this.secretStorage.get(keyForProvider(provider));
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as AuthSession;
      if (!parsed.accessToken) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  public async getAccessToken(provider: ProviderId): Promise<string | undefined> {
    const session = await this.getSession(provider);
    return session?.accessToken;
  }

  public async isAuthenticated(provider: ProviderId): Promise<boolean> {
    const session = await this.getSession(provider);
    return Boolean(session?.accessToken);
  }

  public async setSession(session: AuthSession): Promise<void> {
    await this.secretStorage.store(keyForProvider(session.provider), JSON.stringify(session));
  }

  public async clearSession(provider: ProviderId): Promise<void> {
    await this.secretStorage.delete(keyForProvider(provider));
  }

  public async getConnectedProviderIds(providerIds: ProviderId[]): Promise<Set<ProviderId>> {
    const connected = new Set<ProviderId>();

    for (const providerId of providerIds) {
      if (await this.isAuthenticated(providerId)) {
        connected.add(providerId);
      }
    }

    return connected;
  }

  public async beginOAuthFlow(options: OAuthFlowOptions): Promise<OAuthCallbackResult> {
    const state = randomHex(16);
    const callbackUri = vscode.Uri.parse(`${vscode.env.uriScheme}://${this.extensionId}/deployify-auth/${options.provider}`);
    const redirectUri = await vscode.env.asExternalUri(callbackUri);

    const authorizeUrl = new URL(options.authorizeEndpoint);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri.toString());

    for (const [key, value] of Object.entries(options.authorizeQuery ?? {})) {
      if (value) {
        authorizeUrl.searchParams.set(key, value);
      }
    }

    const timeoutMs = options.timeoutMs ?? 180_000;

    const resultPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingFlowsByState.delete(state);
        reject(new Error(`Timed out waiting for ${options.provider} OAuth callback.`));
      }, timeoutMs);

      this.pendingFlowsByState.set(state, {
        provider: options.provider,
        state,
        redirectUri: redirectUri.toString(),
        timeout,
        resolve,
        reject
      });
    });

    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
    if (!opened) {
      const flow = this.pendingFlowsByState.get(state);
      if (flow) {
        clearTimeout(flow.timeout);
        this.pendingFlowsByState.delete(state);
      }
      throw new Error(`Unable to open ${options.provider} OAuth URL in browser.`);
    }

    const result = await resultPromise;

    const oauthError = result.queryParams.get("error") ?? result.fragmentParams.get("error");
    if (oauthError) {
      const description =
        result.queryParams.get("error_description") ??
        result.fragmentParams.get("error_description") ??
        "Unknown OAuth error";
      throw new Error(`${options.provider} OAuth error: ${oauthError} (${description})`);
    }

    return result;
  }

  public async beginDeviceLikeLogin(
    provider: ProviderId,
    verificationUrl: string,
    tokenHint: string
  ): Promise<AuthSession> {
    await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));

    const token = await vscode.window.showInputBox({
      title: `Connect ${provider}`,
      placeHolder: tokenHint,
      prompt: `Paste the ${provider} API token after completing login in the opened browser.`,
      ignoreFocusOut: true,
      password: true,
      validateInput: (value) => {
        if (!value.trim()) {
          return "Token is required.";
        }

        return undefined;
      }
    });

    if (!token) {
      throw new Error(`${provider} login was cancelled.`);
    }

    const session: AuthSession = {
      provider,
      accessToken: token.trim(),
      createdAt: new Date().toISOString()
    };

    await this.setSession(session);
    return session;
  }

  private handleUri(uri: vscode.Uri): void {
    const queryParams = new URLSearchParams(uri.query);
    const fragmentParams = new URLSearchParams(uri.fragment);

    const state = queryParams.get("state") ?? fragmentParams.get("state");
    const providerFromPath = parseProviderFromPath(uri.path);

    let flow: PendingOAuthFlow | undefined;

    if (state) {
      flow = this.pendingFlowsByState.get(state);
    }

    if (!flow && providerFromPath) {
      const matches = [...this.pendingFlowsByState.values()].filter((pending) => pending.provider === providerFromPath);
      if (matches.length === 1) {
        flow = matches[0];
      }
    }

    if (!flow) {
      return;
    }

    clearTimeout(flow.timeout);
    this.pendingFlowsByState.delete(flow.state);

    flow.resolve({
      provider: flow.provider,
      redirectUri: flow.redirectUri,
      state: flow.state,
      queryParams,
      fragmentParams,
      callbackUri: uri
    });
  }
}
