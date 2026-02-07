import * as vscode from "vscode";
import { DeploymentStore } from "../core/deploymentStore";
import { DeploymentSummary, HostedProject, ProjectScope, ProviderStatus } from "../core/types";
import { ProjectLinkService } from "../workspace/projectLinkService";

export type DeploymentsTreeNode =
  | { kind: "workspace-root" }
  | { kind: "all-root" }
  | { kind: "providers-root" }
  | { kind: "provider"; provider: ProviderStatus }
  | { kind: "project"; project: HostedProject; source: "workspace-root" | "all-root" }
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

export class DeploymentsTreeProvider implements vscode.TreeDataProvider<DeploymentsTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DeploymentsTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly store: DeploymentStore;
  private readonly projectLinkService: ProjectLinkService;
  private readonly getScope: () => ProjectScope;

  public constructor(store: DeploymentStore, projectLinkService: ProjectLinkService, getScope: () => ProjectScope) {
    this.store = store;
    this.projectLinkService = projectLinkService;
    this.getScope = getScope;
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(node: DeploymentsTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "workspace-root": {
        const item = new vscode.TreeItem("Workspace Projects", vscode.TreeItemCollapsibleState.Expanded);
        item.id = "deployify.workspaceRoot";
        item.contextValue = "deployify.scopeRoot";
        item.iconPath = new vscode.ThemeIcon("folder-library");
        item.description = this.getScope().mode === "workspace-linked" ? "Active" : "Inactive";
        return item;
      }
      case "all-root": {
        const item = new vscode.TreeItem("All Projects", vscode.TreeItemCollapsibleState.Collapsed);
        item.id = "deployify.allRoot";
        item.contextValue = "deployify.scopeRoot";
        item.iconPath = new vscode.ThemeIcon("organization");
        item.description = this.getScope().mode === "all-account" ? "Active" : "Inactive";
        return item;
      }
      case "providers-root": {
        const item = new vscode.TreeItem("Providers", vscode.TreeItemCollapsibleState.Expanded);
        item.id = "deployify.providersRoot";
        item.contextValue = "deployify.providersRoot";
        item.iconPath = new vscode.ThemeIcon("plug");
        return item;
      }
      case "provider": {
        const item = new vscode.TreeItem(node.provider.displayName, vscode.TreeItemCollapsibleState.None);
        item.id = `deployify.provider.${node.provider.provider}`;
        item.contextValue = "deployify.provider";
        item.iconPath = providerIcon(node.provider.connected);
        item.description = node.provider.connected ? "Connected" : "Disconnected";

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
        item.description = this.buildProjectDescription(node.project);
        item.command = {
          title: "Open Project Dashboard",
          command: "deployify.openProject",
          arguments: [node]
        };
        item.tooltip = `${node.project.provider} • ${node.project.projectId}`;
        return item;
      }
      case "deployment": {
        const item = new vscode.TreeItem(
          `${node.deployment.environment}: ${node.deployment.state}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.id = `deployify.deployment.${node.deployment.provider}.${node.deployment.projectId}.${node.deployment.environment}`;
        item.contextValue = "deployify.deployment";
        item.iconPath = stateIcon(node.deployment.state);
        item.description = node.deployment.url ? formatAge(node.deployment.updatedAt) : undefined;
        item.tooltip = [
          `State: ${node.deployment.state}`,
          node.deployment.url ? `URL: ${node.deployment.url}` : "",
          node.deployment.commitSha ? `Commit: ${node.deployment.commitSha.slice(0, 8)}` : "",
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
    const scope = this.getScope();

    if (!node) {
      return [{ kind: "workspace-root" }, { kind: "all-root" }, { kind: "providers-root" }];
    }

    if (node.kind === "workspace-root") {
      if (scope.mode !== "workspace-linked") {
        return [{ kind: "info", source: node.kind, message: "Use Deployify: Toggle Scope to activate." }];
      }

      const filtered = await this.projectLinkService.filterProjectsForScope(snapshot.projects, { mode: "workspace-linked" });
      if (filtered.length === 0) {
        return [{ kind: "info", source: node.kind, message: "No workspace-linked projects. Use Link Workspace Project." }];
      }

      return filtered.map((project) => ({ kind: "project", project, source: "workspace-root" }));
    }

    if (node.kind === "all-root") {
      if (scope.mode !== "all-account") {
        return [{ kind: "info", source: node.kind, message: "Use Deployify: Toggle Scope to activate." }];
      }

      if (snapshot.projects.length === 0) {
        return [{ kind: "info", source: node.kind, message: "No projects loaded. Connect a provider and refresh." }];
      }

      return snapshot.projects.map((project) => ({ kind: "project", project, source: "all-root" }));
    }

    if (node.kind === "providers-root") {
      return snapshot.providers.map((provider) => ({ kind: "provider", provider }));
    }

    if (node.kind === "project") {
      const deployments = snapshot.deployments
        .filter((deployment) => deployment.provider === node.project.provider && deployment.projectId === node.project.projectId)
        .sort((a, b) => a.environment.localeCompare(b.environment));

      if (deployments.length === 0) {
        return [{ kind: "info", source: node.kind, message: "No deployments found for this project." }];
      }

      return deployments.map((deployment) => ({ kind: "deployment", project: node.project, deployment }));
    }

    return [];
  }

  private buildProjectDescription(project: HostedProject): string {
    const deployments = this.store.getDeploymentsForProject(project.provider, project.projectId);

    const stateByEnvironment = new Map<string, string>();
    for (const deployment of deployments) {
      stateByEnvironment.set(deployment.environment, deployment.state);
    }

    const statusTokens = [...stateByEnvironment.entries()].map(([environment, state]) => `${environment}: ${state}`);
    return [project.provider, ...statusTokens].join(" • ");
  }
}
