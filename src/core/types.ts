export type ProviderId = "vercel" | "netlify" | string;

export type DeploymentState = "queued" | "building" | "ready" | "failed" | "canceled";

export interface AuthSession {
  provider: ProviderId;
  accessToken: string;
  accountLabel?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface EnvironmentRef {
  id: string;
  name: string;
  type: "production" | "preview" | "staging" | string;
}

export interface HostedProject {
  provider: ProviderId;
  projectId: string;
  name: string;
  environments: EnvironmentRef[];
  repo?: {
    owner: string;
    name: string;
    branch?: string;
  };
}

export interface DeploymentSummary {
  provider: ProviderId;
  projectId: string;
  environment: "production" | "preview" | "staging" | string;
  deploymentId: string;
  state: DeploymentState;
  url?: string;
  commitSha?: string;
  commitMessage?: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentDetails extends DeploymentSummary {
  projectUrl?: string;
  logsUrl?: string;
  diagnostics?: string[];
  history?: DeploymentSummary[];
  raw?: unknown;
}

export interface ProjectScope {
  mode: "workspace-linked" | "all-account";
}

export interface ProviderFetchResult {
  provider: ProviderId;
  connected: boolean;
  projects: HostedProject[];
  deployments: DeploymentSummary[];
  error?: string;
  fetchedAt: string;
}

export interface ProviderStatus {
  provider: ProviderId;
  displayName: string;
  connected: boolean;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  staleSince?: string;
  error?: string;
}

export interface DeploymentStoreSnapshot {
  projects: HostedProject[];
  deployments: DeploymentSummary[];
  providers: ProviderStatus[];
  fetchedAt?: string;
}

export interface DeploymentStoreUpdate {
  previous: DeploymentStoreSnapshot;
  current: DeploymentStoreSnapshot;
}

export interface DeploymentProviderAdapter {
  id: ProviderId;
  displayName: string;
  authenticate(): Promise<AuthSession>;
  logout(): Promise<void>;
  getProjects(scope: ProjectScope): Promise<HostedProject[]>;
  getLatestDeployments(projectIds: string[]): Promise<DeploymentSummary[]>;
  getDeploymentDetails(deploymentId: string): Promise<DeploymentDetails>;
  openInBrowser(target: "deployment" | "project", id: string): Promise<void>;
}

export interface WorkspaceProjectLink {
  provider: ProviderId;
  projectId: string;
  projectName: string;
}

export interface WorkspaceLinkMap {
  [workspaceKey: string]: WorkspaceProjectLink[];
}
