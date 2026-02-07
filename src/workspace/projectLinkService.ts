import * as vscode from "vscode";
import { HostedProject, ProjectScope, ProviderId, WorkspaceLinkMap, WorkspaceProjectLink } from "../core/types";

const WORKSPACE_LINK_KEY = "deployify.workspaceLinks";

function composeProjectKey(provider: ProviderId, projectId: string): string {
  return `${provider}:${projectId}`;
}

export class ProjectLinkService {
  private readonly globalState: vscode.Memento;

  public constructor(globalState: vscode.Memento) {
    this.globalState = globalState;
  }

  public async filterProjectsForScope(projects: HostedProject[], scope: ProjectScope): Promise<HostedProject[]> {
    if (scope.mode === "all-account") {
      return projects;
    }

    const linked = this.getLinksForCurrentWorkspace();
    const linkedKeys = new Set(linked.map((item) => composeProjectKey(item.provider, item.projectId)));

    if (linkedKeys.size > 0) {
      return projects.filter((project) => linkedKeys.has(composeProjectKey(project.provider, project.projectId)));
    }

    const inferredKeys = await this.inferWorkspaceProjectKeys(projects);
    return projects.filter((project) => inferredKeys.has(composeProjectKey(project.provider, project.projectId)));
  }

  public getLinksForCurrentWorkspace(): WorkspaceProjectLink[] {
    const map = this.globalState.get<WorkspaceLinkMap>(WORKSPACE_LINK_KEY) ?? {};
    const workspaceKey = this.getWorkspaceKey();
    return map[workspaceKey] ?? [];
  }

  public async linkProject(link: WorkspaceProjectLink): Promise<void> {
    const map = this.globalState.get<WorkspaceLinkMap>(WORKSPACE_LINK_KEY) ?? {};
    const workspaceKey = this.getWorkspaceKey();
    const current = map[workspaceKey] ?? [];

    const exists = current.some((item) => item.provider === link.provider && item.projectId === link.projectId);
    if (!exists) {
      map[workspaceKey] = [...current, link];
      await this.globalState.update(WORKSPACE_LINK_KEY, map);
    }
  }

  public async unlinkProject(provider: ProviderId, projectId: string): Promise<void> {
    const map = this.globalState.get<WorkspaceLinkMap>(WORKSPACE_LINK_KEY) ?? {};
    const workspaceKey = this.getWorkspaceKey();
    const current = map[workspaceKey] ?? [];

    map[workspaceKey] = current.filter((item) => !(item.provider === provider && item.projectId === projectId));
    await this.globalState.update(WORKSPACE_LINK_KEY, map);
  }

  private getWorkspaceKey(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return "__single_window__";
    }

    return folders.map((folder) => folder.uri.toString()).sort().join("|");
  }

  private async inferWorkspaceProjectKeys(projects: HostedProject[]): Promise<Set<string>> {
    const candidateNames = await this.getWorkspaceCandidateNames();
    const inferred = new Set<string>();

    for (const project of projects) {
      const normalizedName = project.name.toLowerCase();
      const repoName = project.repo?.name?.toLowerCase();
      if (candidateNames.has(normalizedName) || (repoName && candidateNames.has(repoName))) {
        inferred.add(composeProjectKey(project.provider, project.projectId));
      }
    }

    return inferred;
  }

  private async getWorkspaceCandidateNames(): Promise<Set<string>> {
    const names = new Set<string>();
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
      names.add(folder.name.toLowerCase());

      const packageJsonUri = vscode.Uri.joinPath(folder.uri, "package.json");
      try {
        const packageJson = await vscode.workspace.fs.readFile(packageJsonUri);
        const parsed = JSON.parse(Buffer.from(packageJson).toString("utf8")) as { name?: string };
        if (parsed.name) {
          names.add(parsed.name.toLowerCase());
        }
      } catch {
        // Ignore missing or invalid package.json files.
      }
    }

    return names;
  }
}
