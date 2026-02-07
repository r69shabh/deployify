import * as vscode from "vscode";
import {
  DeploymentStoreSnapshot,
  DeploymentStoreUpdate,
  DeploymentSummary,
  HostedProject,
  ProviderFetchResult,
  ProviderId,
  ProviderStatus
} from "./types";

function projectKey(provider: ProviderId, projectId: string): string {
  return `${provider}:${projectId}`;
}

function deploymentKey(summary: DeploymentSummary): string {
  return `${summary.provider}:${summary.projectId}:${summary.deploymentId}`;
}

export class DeploymentStore {
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<DeploymentStoreUpdate>();
  public readonly onDidUpdate = this.onDidUpdateEmitter.event;

  private readonly providerStatus = new Map<ProviderId, ProviderStatus>();
  private readonly projects = new Map<string, HostedProject>();
  private readonly deployments = new Map<string, DeploymentSummary>();
  private fetchedAt?: string;

  public constructor(seedProviders: Array<{ provider: ProviderId; displayName: string }>) {
    for (const provider of seedProviders) {
      this.providerStatus.set(provider.provider, {
        provider: provider.provider,
        displayName: provider.displayName,
        connected: false
      });
    }
  }

  public initializeProvider(provider: ProviderId, displayName: string): void {
    if (this.providerStatus.has(provider)) {
      return;
    }

    this.providerStatus.set(provider, {
      provider,
      displayName,
      connected: false
    });
  }

  public applyProviderResult(result: ProviderFetchResult): void {
    const previous = this.getSnapshot();
    const status = this.providerStatus.get(result.provider);

    const nextStatus: ProviderStatus = {
      provider: result.provider,
      displayName: status?.displayName ?? result.provider,
      connected: result.connected,
      lastAttemptAt: result.fetchedAt,
      lastSuccessAt: result.error ? status?.lastSuccessAt : result.fetchedAt,
      staleSince: result.error ? (status?.staleSince ?? result.fetchedAt) : undefined,
      error: result.error
    };

    this.providerStatus.set(result.provider, nextStatus);

    if (!result.error) {
      this.replaceProviderProjects(result.provider, result.projects);
      this.replaceProviderDeployments(result.provider, result.deployments);
      this.fetchedAt = result.fetchedAt;
    }

    this.emitUpdate(previous);
  }

  public markProviderDisconnected(provider: ProviderId, message?: string): void {
    const previous = this.getSnapshot();
    const status = this.providerStatus.get(provider);

    if (!status) {
      return;
    }

    this.providerStatus.set(provider, {
      ...status,
      connected: false,
      error: message,
      lastAttemptAt: new Date().toISOString(),
      staleSince: undefined
    });

    this.clearProviderData(provider);
    this.emitUpdate(previous);
  }

  public getSnapshot(): DeploymentStoreSnapshot {
    const projects = [...this.projects.values()].sort((a, b) => {
      const providerCompare = a.provider.localeCompare(b.provider);
      if (providerCompare !== 0) {
        return providerCompare;
      }

      return a.name.localeCompare(b.name);
    });

    const deployments = [...this.deployments.values()].sort((a, b) => {
      const providerCompare = a.provider.localeCompare(b.provider);
      if (providerCompare !== 0) {
        return providerCompare;
      }

      const projectCompare = a.projectId.localeCompare(b.projectId);
      if (projectCompare !== 0) {
        return projectCompare;
      }

      const environmentCompare = a.environment.localeCompare(b.environment);
      if (environmentCompare !== 0) {
        return environmentCompare;
      }

      return b.updatedAt.localeCompare(a.updatedAt);
    });

    const providers = [...this.providerStatus.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      projects,
      deployments,
      providers,
      fetchedAt: this.fetchedAt
    };
  }

  public getProject(provider: ProviderId, projectId: string): HostedProject | undefined {
    return this.projects.get(projectKey(provider, projectId));
  }

  public getDeploymentsForProject(provider: ProviderId, projectId: string): DeploymentSummary[] {
    return [...this.deployments.values()]
      .filter((summary) => summary.provider === provider && summary.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private replaceProviderProjects(provider: ProviderId, projects: HostedProject[]): void {
    for (const [key, value] of this.projects.entries()) {
      if (value.provider === provider) {
        this.projects.delete(key);
      }
    }

    for (const project of projects) {
      this.projects.set(projectKey(project.provider, project.projectId), project);
    }
  }

  private replaceProviderDeployments(provider: ProviderId, deployments: DeploymentSummary[]): void {
    for (const [key, value] of this.deployments.entries()) {
      if (value.provider === provider) {
        this.deployments.delete(key);
      }
    }

    for (const summary of deployments) {
      const key = deploymentKey(summary);
      const existing = this.deployments.get(key);
      if (!existing || existing.updatedAt < summary.updatedAt) {
        this.deployments.set(key, summary);
      }
    }
  }

  private clearProviderData(provider: ProviderId): void {
    for (const [key, value] of this.projects.entries()) {
      if (value.provider === provider) {
        this.projects.delete(key);
      }
    }

    for (const [key, value] of this.deployments.entries()) {
      if (value.provider === provider) {
        this.deployments.delete(key);
      }
    }
  }

  private emitUpdate(previous: DeploymentStoreSnapshot): void {
    this.onDidUpdateEmitter.fire({
      previous,
      current: this.getSnapshot()
    });
  }
}
