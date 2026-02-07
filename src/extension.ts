import * as vscode from "vscode";
import { AuthManager } from "./auth/authManager";
import { DeploymentStore } from "./core/deploymentStore";
import { NotificationService } from "./core/notificationService";
import { PollingScheduler } from "./core/pollingScheduler";
import { ProviderRegistry } from "./core/providerRegistry";
import { DeploymentProviderAdapter, DeploymentSummary, HostedProject, ProjectScope, ProviderFetchResult } from "./core/types";
import { NetlifyAdapter } from "./providers/netlifyAdapter";
import { VercelAdapter } from "./providers/vercelAdapter";
import { DeploymentsTreeNode, DeploymentsTreeProvider } from "./ui/deploymentsTreeProvider";
import { DetailsWebview } from "./ui/detailsWebview";
import { DeploymentsStatusBar } from "./ui/statusBar";
import { ProjectLinkService } from "./workspace/projectLinkService";

const SCOPE_STATE_KEY = "deployify.scopeMode";

function getConfiguredScopeMode(): ProjectScope["mode"] {
  return vscode.workspace.getConfiguration("deployify").get<ProjectScope["mode"]>("defaultScope", "workspace-linked");
}

function getPollIntervalSeconds(): number {
  return vscode.workspace.getConfiguration("deployify").get<number>("pollIntervalSeconds", 45);
}

async function pickAdapter(adapters: DeploymentProviderAdapter[], title: string): Promise<DeploymentProviderAdapter | undefined> {
  if (adapters.length === 0) {
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    adapters.map((adapter) => ({
      label: adapter.displayName,
      description: adapter.id,
      adapter
    })),
    { title }
  );

  return selected?.adapter;
}

async function pickProject(projects: HostedProject[], title: string): Promise<HostedProject | undefined> {
  if (projects.length === 0) {
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.name,
      description: `${project.provider} • ${project.projectId}`,
      project
    })),
    { title }
  );

  return selected?.project;
}

async function pickDeployment(deployments: DeploymentSummary[], title: string): Promise<DeploymentSummary | undefined> {
  if (deployments.length === 0) {
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    deployments.map((deployment) => ({
      label: `${deployment.provider} • ${deployment.projectId} • ${deployment.environment}`,
      description: `${deployment.state} • ${deployment.url ?? "no url"}`,
      deployment
    })),
    { title }
  );

  return selected?.deployment;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const authManager = new AuthManager(context.secrets, context.extension.id);
  context.subscriptions.push(authManager);
  const providerRegistry = new ProviderRegistry();
  const projectLinkService = new ProjectLinkService(context.globalState);
  const notificationService = new NotificationService();
  const detailsWebview = new DetailsWebview();

  const vercelAdapter = new VercelAdapter(authManager);
  const netlifyAdapter = new NetlifyAdapter(authManager);

  providerRegistry.register(vercelAdapter);
  providerRegistry.register(netlifyAdapter);

  const store = new DeploymentStore(
    providerRegistry.getAll().map((adapter) => ({ provider: adapter.id, displayName: adapter.displayName }))
  );

  const initialScopeMode = context.workspaceState.get<ProjectScope["mode"]>(SCOPE_STATE_KEY) ?? getConfiguredScopeMode();
  let scope: ProjectScope = { mode: initialScopeMode };

  const treeProvider = new DeploymentsTreeProvider(store, projectLinkService, () => scope);
  const statusBar = new DeploymentsStatusBar();

  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.window.registerTreeDataProvider("deployify.deployments", treeProvider)
  );

  store.onDidUpdate((update) => {
    treeProvider.refresh();
    statusBar.update(update.current);
    notificationService.handleStoreUpdate(update);
  });

  const refreshProviders = async (): Promise<void> => {
    const enabledAdapters = providerRegistry.getEnabled();
    let hadError = false;

    await Promise.all(
      enabledAdapters.map(async (adapter) => {
        const fetchedAt = new Date().toISOString();
        const isConnected = await authManager.isAuthenticated(adapter.id);

        if (!isConnected) {
          store.markProviderDisconnected(adapter.id, "Not connected");
          return;
        }

        try {
          const projects = await adapter.getProjects({ mode: "all-account" });
          const deployments = projects.length > 0 ? await adapter.getLatestDeployments(projects.map((project) => project.projectId)) : [];

          const result: ProviderFetchResult = {
            provider: adapter.id,
            connected: true,
            projects,
            deployments,
            fetchedAt
          };

          store.applyProviderResult(result);
        } catch (error) {
          hadError = true;

          const message = error instanceof Error ? error.message : "Unknown provider error";
          const result: ProviderFetchResult = {
            provider: adapter.id,
            connected: true,
            projects: [],
            deployments: [],
            error: message,
            fetchedAt
          };

          store.applyProviderResult(result);
        }
      })
    );

    if (enabledAdapters.length === 0) {
      vscode.window.setStatusBarMessage("Deployify: no providers enabled.", 4000);
    }

    if (hadError) {
      throw new Error("One or more providers failed while refreshing deployments.");
    }
  };

  const scheduler = new PollingScheduler(refreshProviders, getPollIntervalSeconds());
  scheduler.start();

  context.subscriptions.push({
    dispose: () => scheduler.stop()
  });

  const register = (command: string, callback: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register("deployify.connectProvider", async () => {
    const adapter = await pickAdapter(providerRegistry.getEnabled(), "Connect provider");
    if (!adapter) {
      vscode.window.showInformationMessage("Deployify: no provider selected.");
      return;
    }

    try {
      await adapter.authenticate();
      vscode.window.showInformationMessage(`Deployify: connected ${adapter.displayName}.`);
      await scheduler.triggerNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect provider.";
      vscode.window.showErrorMessage(`Deployify: ${message}`);
    }
  });

  register("deployify.disconnectProvider", async () => {
    const connectedIds = await authManager.getConnectedProviderIds(providerRegistry.getAll().map((adapter) => adapter.id));
    const adapter = await pickAdapter(providerRegistry.getConnected(connectedIds), "Disconnect provider");

    if (!adapter) {
      vscode.window.showInformationMessage("Deployify: no connected provider selected.");
      return;
    }

    await adapter.logout();
    store.markProviderDisconnected(adapter.id, "Disconnected");
    vscode.window.showInformationMessage(`Deployify: disconnected ${adapter.displayName}.`);
  });

  register("deployify.refresh", async () => {
    try {
      await scheduler.triggerNow();
      vscode.window.setStatusBarMessage("Deployify: refreshed.", 2500);
    } catch {
      vscode.window.showWarningMessage("Deployify refreshed with provider errors. See Providers node for details.");
    }
  });

  register("deployify.toggleScope", async () => {
    scope = {
      mode: scope.mode === "workspace-linked" ? "all-account" : "workspace-linked"
    };

    await context.workspaceState.update(SCOPE_STATE_KEY, scope.mode);
    treeProvider.refresh();

    vscode.window.setStatusBarMessage(`Deployify scope: ${scope.mode}`, 3000);
  });

  register("deployify.openDeployment", async (node?: DeploymentsTreeNode) => {
    const summary = node?.kind === "deployment"
      ? node.deployment
      : await pickDeployment(store.getSnapshot().deployments, "Open deployment");

    if (!summary) {
      return;
    }

    if (summary.url) {
      await vscode.env.openExternal(vscode.Uri.parse(summary.url));
      return;
    }

    const adapter = providerRegistry.get(summary.provider);
    if (!adapter) {
      vscode.window.showWarningMessage(`Deployify: provider ${summary.provider} is not registered.`);
      return;
    }

    await adapter.openInBrowser("deployment", summary.deploymentId);
  });

  register("deployify.openProject", async (node?: DeploymentsTreeNode) => {
    const project = node?.kind === "project"
      ? node.project
      : await pickProject(store.getSnapshot().projects, "Open project dashboard");

    if (!project) {
      return;
    }

    const adapter = providerRegistry.get(project.provider);
    if (!adapter) {
      vscode.window.showWarningMessage(`Deployify: provider ${project.provider} is not registered.`);
      return;
    }

    await adapter.openInBrowser("project", project.projectId);
  });

  register("deployify.viewDetails", async (node?: DeploymentsTreeNode) => {
    const summary = node?.kind === "deployment"
      ? node.deployment
      : await pickDeployment(store.getSnapshot().deployments, "View deployment details");

    if (!summary) {
      return;
    }

    const adapter = providerRegistry.get(summary.provider);
    if (!adapter) {
      vscode.window.showWarningMessage(`Deployify: provider ${summary.provider} is not registered.`);
      return;
    }

    try {
      const details = await adapter.getDeploymentDetails(summary.deploymentId);
      const project = store.getProject(summary.provider, summary.projectId);
      const history = store.getDeploymentsForProject(summary.provider, summary.projectId);
      const providerError = store.getSnapshot().providers.find((provider) => provider.provider === summary.provider)?.error;

      detailsWebview.show(details, project, history, providerError);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load deployment details.";
      vscode.window.showErrorMessage(`Deployify: ${message}`);
    }
  });

  register("deployify.linkWorkspaceProject", async () => {
    const project = await pickProject(store.getSnapshot().projects, "Link workspace project");

    if (!project) {
      return;
    }

    await projectLinkService.linkProject({
      provider: project.provider,
      projectId: project.projectId,
      projectName: project.name
    });

    treeProvider.refresh();
    vscode.window.showInformationMessage(`Deployify: linked ${project.name}.`);
  });

  register("deployify.unlinkWorkspaceProject", async () => {
    const links = projectLinkService.getLinksForCurrentWorkspace();

    if (links.length === 0) {
      vscode.window.showInformationMessage("Deployify: no linked workspace projects.");
      return;
    }

    const selection = await vscode.window.showQuickPick(
      links.map((link) => ({
        label: link.projectName,
        description: `${link.provider} • ${link.projectId}`,
        link
      })),
      { title: "Unlink workspace project" }
    );

    if (!selection) {
      return;
    }

    await projectLinkService.unlinkProject(selection.link.provider, selection.link.projectId);
    treeProvider.refresh();
    vscode.window.showInformationMessage(`Deployify: unlinked ${selection.link.projectName}.`);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("deployify.pollIntervalSeconds")) {
        scheduler.setPollIntervalSeconds(getPollIntervalSeconds());
      }

      if (
        event.affectsConfiguration("deployify.providers.vercel.enabled") ||
        event.affectsConfiguration("deployify.providers.netlify.enabled")
      ) {
        void scheduler.triggerNow();
      }

      if (event.affectsConfiguration("deployify.notifyOnFailure")) {
        treeProvider.refresh();
      }
    })
  );

  try {
    await scheduler.triggerNow();
  } catch {
    // Initial refresh errors are represented in provider nodes.
  }
}

export function deactivate(): void {
  // resources are disposed through context subscriptions
}
