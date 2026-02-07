import * as vscode from "vscode";
import { DeploymentStore } from "../core/deploymentStore";
import { DeploymentSummary, HostedProject, ProviderStatus } from "../core/types";
import { ProjectLinkService } from "../workspace/projectLinkService";

type RootNodeKind = "workspace-root" | "all-root" | "providers-root";

export type DeploymentsTreeNode =
  | { kind: "workspace-root" }
  | { kind: "all-root" }
  | { kind: "providers-root" }
  | { kind: "provider"; provider: ProviderStatus }
  | { kind: "project"; project: HostedProject; source: "workspace-root" | "all-root" }
  | { kind: "environment"; project: HostedProject; environment: string; deployments: DeploymentSummary[] }
  | { kind: "deployment"; project: HostedProject; deployment: DeploymentSummary }
  | { kind: "info"; message: string; source: string };

function stateIcon(state: DeploymentSummary["state"]): vscode.ThemeIcon {
  switch (state) {
    case "ready":
      return new vscode.ThemeIcon("testing-passed", new vscode.ThemeColor("testing.iconPassed"));
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "queued":
      return new vscode.ThemeIcon("clock", new vscode.ThemeColor("charts.yellow"));
    case "canceled":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
    case "building":
    default:
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue"));
  }
}

function providerIcon(connected: boolean): vscode.ThemeIcon {
  return connected
    ? new vscode.ThemeIcon("plug", new vscode.ThemeColor("charts.green"))
    : new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("disabledForeground"));
}

function formatAge(isoDate: string): string {
  const ageMs = Date.now() - new Date(isoDate).getTime();

  if (ageMs < 60_000) {
    return "now";
  }

  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

function formatTimestamp(isoDate: string): string {
  const date = new Date(isoDate);

  if (Number.isNaN(date.valueOf())) {
    return isoDate;
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  });
}

function sortEnvironmentName(a: string, b: string): number {
  const rank = (name: string): number => {
    const normalized = name.toLowerCase();
    if (normalized === "production") {
      return 0;
    }

    if (normalized === "staging") {
      return 1;
    }

    if (normalized === "preview") {
      return 2;
    }

    return 3;
  };

  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  return a.localeCompare(b);
}

export class DeploymentsTreeProvider implements vscode.TreeDataProvider<DeploymentsTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DeploymentsTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly store: DeploymentStore;
  private readonly projectLinkService: ProjectLinkService;
  private expandedRoot: RootNodeKind | undefined;

  public constructor(store: DeploymentStore, projectLinkService: ProjectLinkService) {
    this.store = store;
    this.projectLinkService = projectLinkService;
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public setExpandedRoot(root: RootNodeKind): void {
    if (this.expandedRoot !== root) {
      this.expandedRoot = root;
      this.refresh();
    }
  }

  public clearExpandedRoot(root: RootNodeKind): void {
    if (this.expandedRoot === root) {
      this.expandedRoot = undefined;
      this.refresh();
    }
  }

  public getTreeItem(node: DeploymentsTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "workspace-root": {
        const item = new vscode.TreeItem(
          "Workspace Projects",
          this.expandedRoot === "workspace-root" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.contextValue = "deployify.scopeRoot";
        item.iconPath = new vscode.ThemeIcon("folder-library");
        return item;
      }
      case "all-root": {
        const item = new vscode.TreeItem(
          "All Projects",
          this.expandedRoot === "all-root" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.contextValue = "deployify.scopeRoot";
        item.iconPath = new vscode.ThemeIcon("organization");
        return item;
      }
      case "providers-root": {
        const item = new vscode.TreeItem(
          "Providers",
          this.expandedRoot === "providers-root" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.contextValue = "deployify.providersRoot";
        item.iconPath = new vscode.ThemeIcon("plug");
        return item;
      }
      case "provider": {
        const item = new vscode.TreeItem(node.provider.displayName, vscode.TreeItemCollapsibleState.None);
        item.id = `deployify.provider.${node.provider.provider}`;
        item.contextValue = node.provider.connected ? "deployify.provider.connected" : "deployify.provider.disconnected";
        item.iconPath = providerIcon(node.provider.connected);
        item.description = node.provider.connected ? "Connected" : "Disconnected";
        item.command = node.provider.connected
          ? {
              title: "Disconnect Provider",
              command: "deployify.disconnectProvider",
              arguments: [node]
            }
          : {
              title: "Connect Provider",
              command: "deployify.connectProvider",
              arguments: [node]
            };

        const details: string[] = [];
        if (node.provider.error) {
          details.push(node.provider.error);
        }
        if (node.provider.lastSuccessAt) {
          details.push(`last success ${formatAge(node.provider.lastSuccessAt)} ago`);
        }
        item.tooltip = details.join("\n");

        return item;
      }
      case "project": {
        const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `deployify.project.${node.project.provider}.${node.project.projectId}.${node.source}`;
        item.contextValue = "deployify.project";
        item.iconPath = new vscode.ThemeIcon("project");
        item.description = node.project.provider;
        item.command = {
          title: "Open Project Dashboard",
          command: "deployify.openProject",
          arguments: [node]
        };
        item.tooltip = `${node.project.provider} • ${node.project.projectId}`;
        return item;
      }
      case "environment": {
        const latest = node.deployments[0];
        const item = new vscode.TreeItem(node.environment, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `deployify.environment.${node.project.provider}.${node.project.projectId}.${node.environment}`;
        item.contextValue = "deployify.environment";
        item.iconPath = latest ? stateIcon(latest.state) : new vscode.ThemeIcon("symbol-property");
        item.description = latest ? `${latest.state} ${formatAge(latest.updatedAt)}` : undefined;
        return item;
      }
      case "deployment": {
        const item = new vscode.TreeItem(
          `${node.deployment.state} • ${formatAge(node.deployment.updatedAt)}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.id = `deployify.deployment.${node.deployment.provider}.${node.deployment.projectId}.${node.deployment.deploymentId}`;
        item.contextValue = "deployify.deployment";
        item.iconPath = stateIcon(node.deployment.state);
        item.description = node.deployment.commitSha ? node.deployment.commitSha.slice(0, 8) : undefined;
        item.tooltip = [
          `Environment: ${node.deployment.environment}`,
          `State: ${node.deployment.state}`,
          `Updated: ${formatTimestamp(node.deployment.updatedAt)}`,
          node.deployment.url ? `URL: ${node.deployment.url}` : "",
          node.deployment.commitSha ? `Commit: ${node.deployment.commitSha}` : "",
          node.deployment.commitMessage ? `Message: ${node.deployment.commitMessage}` : ""
        ]
          .filter(Boolean)
          .join("\n");
        item.command = {
          title: "View Deployment Details",
          command: "deployify.viewDetails",
          arguments: [node]
        };
        return item;
      }
      case "info": {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.id = `deployify.info.${node.source}.${node.message}`;
        item.contextValue = "deployify.info";
        item.iconPath = new vscode.ThemeIcon("info", new vscode.ThemeColor("descriptionForeground"));
        return item;
      }
    }
  }

  public async getChildren(node?: DeploymentsTreeNode): Promise<DeploymentsTreeNode[]> {
    const snapshot = this.store.getSnapshot();

    if (!node) {
      const hasConnectedProvider = snapshot.providers.some((provider) => provider.connected);
      const hasAnyProjects = snapshot.projects.length > 0;

      if (!hasConnectedProvider && !hasAnyProjects) {
        return [];
      }

      return [{ kind: "workspace-root" }, { kind: "all-root" }, { kind: "providers-root" }];
    }

    if (node.kind === "workspace-root") {
      const hasConnectedProvider = snapshot.providers.some((provider) => provider.connected);

      if (!hasConnectedProvider) {
        return [{ kind: "info", source: node.kind, message: "Connect Vercel, Netlify, or AWS Amplify to get started." }];
      }

      const filtered = await this.projectLinkService.filterProjectsForScope(snapshot.projects, { mode: "workspace-linked" });
      if (filtered.length === 0) {
        return [{ kind: "info", source: node.kind, message: "No workspace-linked projects yet. Use Link Workspace Project." }];
      }

      return filtered.map((project) => ({ kind: "project", project, source: "workspace-root" }));
    }

    if (node.kind === "all-root") {
      const hasConnectedProvider = snapshot.providers.some((provider) => provider.connected);

      if (!hasConnectedProvider) {
        return [{ kind: "info", source: node.kind, message: "Connect a provider to load projects." }];
      }

      if (snapshot.projects.length === 0) {
        return [{ kind: "info", source: node.kind, message: "No projects found in connected providers yet." }];
      }

      return snapshot.projects.map((project) => ({ kind: "project", project, source: "all-root" }));
    }

    if (node.kind === "providers-root") {
      return snapshot.providers.map((provider) => ({ kind: "provider", provider }));
    }

    if (node.kind === "project") {
      const deployments = this.store
        .getDeploymentsForProject(node.project.provider, node.project.projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      if (deployments.length === 0) {
        return [{ kind: "info", source: node.kind, message: "No deployments found for this project." }];
      }

      const grouped = new Map<string, DeploymentSummary[]>();
      for (const deployment of deployments) {
        const current = grouped.get(deployment.environment) ?? [];
        current.push(deployment);
        grouped.set(deployment.environment, current);
      }

      return [...grouped.entries()]
        .sort(([left], [right]) => sortEnvironmentName(left, right))
        .map(([environment, environmentDeployments]) => ({
          kind: "environment",
          project: node.project,
          environment,
          deployments: environmentDeployments
        }));
    }

    if (node.kind === "environment") {
      return node.deployments.map((deployment) => ({ kind: "deployment", project: node.project, deployment }));
    }

    return [];
  }
}
