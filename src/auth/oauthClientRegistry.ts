import { ProviderId } from "../core/types";

export type SupportedProviderId = "vercel" | "netlify";

type OAuthResponseType = "code" | "token";

type TokenRequestContentType = "json" | "form";

interface DirectOAuthClientEntry {
  strategy?: "direct";
  clientId: string;
  clientSecret?: string;
  scope?: string;
  responseType?: OAuthResponseType;
  usePkce?: boolean;
  tokenEndpoint?: string;
}

interface BrokerOAuthClientEntry {
  strategy: "broker";
  brokerBaseUrl: string;
  startPath?: string;
  exchangePath?: string;
}

type OAuthClientEntry = DirectOAuthClientEntry | BrokerOAuthClientEntry;

interface BrokerOAuthConfig {
  strategy: "broker";
  providerId: SupportedProviderId;
  brokerBaseUrl: string;
  startEndpoint: string;
  exchangeEndpoint: string;
}

interface DirectOAuthConfig {
  strategy: "direct";
  providerId: SupportedProviderId;
  clientId: string;
  clientSecret?: string;
  authorizeEndpoint: string;
  tokenEndpoint?: string;
  scope: string;
  responseType: OAuthResponseType;
  usePkce: boolean;
  tokenRequestContentType?: TokenRequestContentType;
}

interface ProviderOAuthDefaults {
  authorizeEndpoint: string;
  tokenEndpoint?: string;
  scope: string;
  responseType: OAuthResponseType;
  usePkce: boolean;
  tokenRequestContentType?: TokenRequestContentType;
}

export type ResolvedOAuthConfig = DirectOAuthConfig | BrokerOAuthConfig;

export interface TokenFallbackConfig {
  providerId: SupportedProviderId;
  verificationUrl: string;
  tokenHint: string;
}

const PROVIDER_DEFAULTS: Record<SupportedProviderId, ProviderOAuthDefaults> = {
  vercel: {
    authorizeEndpoint: "https://vercel.com/oauth/authorize",
    tokenEndpoint: "https://api.vercel.com/v2/oauth/access_token",
    scope: "project.read deployments.read",
    responseType: "code",
    usePkce: true,
    tokenRequestContentType: "json"
  },
  netlify: {
    authorizeEndpoint: "https://app.netlify.com/authorize",
    tokenEndpoint: "https://api.netlify.com/oauth/token",
    scope: "read_site",
    responseType: "token",
    usePkce: false,
    tokenRequestContentType: "form"
  }
};

const TOKEN_FALLBACKS: Record<SupportedProviderId, TokenFallbackConfig> = {
  vercel: {
    providerId: "vercel",
    verificationUrl: "https://vercel.com/account/tokens",
    tokenHint: "Paste your Vercel token"
  },
  netlify: {
    providerId: "netlify",
    verificationUrl: "https://app.netlify.com/user/applications#personal-access-tokens",
    tokenHint: "Paste your Netlify personal access token"
  }
};

const brokerBaseUrlFromEnv = (process.env.DEPLOYIFY_AUTH_BROKER_URL ?? "").trim();

const defaultAuthEntries: Partial<Record<SupportedProviderId, OAuthClientEntry>> = brokerBaseUrlFromEnv
  ? {
      vercel: {
        strategy: "broker",
        brokerBaseUrl: brokerBaseUrlFromEnv
      },
      netlify: {
        strategy: "broker",
        brokerBaseUrl: brokerBaseUrlFromEnv
      }
    }
  : {
      vercel: {
        strategy: "direct",
        clientId: process.env.DEPLOYIFY_VERCEL_CLIENT_ID ?? ""
      },
      netlify: {
        strategy: "direct",
        clientId: process.env.DEPLOYIFY_NETLIFY_CLIENT_ID ?? ""
      }
    };

// Configure OAuth clients once here for each published extension ID.
// End users should never need to edit settings for OAuth.
const OAUTH_CLIENTS_BY_EXTENSION_ID: Record<string, Partial<Record<SupportedProviderId, OAuthClientEntry>>> = {
  "r69shabh.deployify": defaultAuthEntries,
  "rishabh.deployify": defaultAuthEntries,
  default: defaultAuthEntries
};

export function isSupportedProviderId(providerId: ProviderId): providerId is SupportedProviderId {
  return providerId === "vercel" || providerId === "netlify";
}

export function resolveOAuthConfig(
  extensionId: string,
  providerId: SupportedProviderId
): ResolvedOAuthConfig | undefined {
  const fromExtension = OAUTH_CLIENTS_BY_EXTENSION_ID[extensionId]?.[providerId];
  const fallback = OAUTH_CLIENTS_BY_EXTENSION_ID.default?.[providerId];
  const client = fromExtension ?? fallback;

  const defaults = PROVIDER_DEFAULTS[providerId];

  if (!client) {
    return undefined;
  }

  if (client.strategy === "broker") {
    const baseUrl = client.brokerBaseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      return undefined;
    }

    const startPath = client.startPath ?? "/oauth/start";
    const exchangePath = client.exchangePath ?? "/oauth/exchange";

    return {
      strategy: "broker",
      providerId,
      brokerBaseUrl: baseUrl,
      startEndpoint: `${baseUrl}${startPath}`,
      exchangeEndpoint: `${baseUrl}${exchangePath}`
    };
  }

  if (!client.clientId) {
    return undefined;
  }

  return {
    strategy: "direct",
    providerId,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    authorizeEndpoint: defaults.authorizeEndpoint,
    tokenEndpoint: client.tokenEndpoint ?? defaults.tokenEndpoint,
    scope: client.scope ?? defaults.scope,
    responseType: client.responseType ?? defaults.responseType,
    usePkce: client.usePkce ?? defaults.usePkce,
    tokenRequestContentType: defaults.tokenRequestContentType
  };
}

export function getTokenFallbackConfig(providerId: ProviderId): TokenFallbackConfig | undefined {
  if (!isSupportedProviderId(providerId)) {
    return undefined;
  }

  return TOKEN_FALLBACKS[providerId];
}
