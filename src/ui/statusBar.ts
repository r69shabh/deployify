import * as vscode from "vscode";
import { DeploymentStoreSnapshot } from "../core/types";

export class DeploymentsStatusBar {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "Deployify Status";
    this.item.command = "workbench.view.extension.deployify";
  }

  public show(): void {
    this.item.show();
  }

  public hide(): void {
    this.item.hide();
  }

  public dispose(): void {
    this.item.dispose();
  }

  public update(snapshot: DeploymentStoreSnapshot): void {
    const building = snapshot.deployments.filter((deployment) => deployment.state === "building" || deployment.state === "queued").length;
    const failed = snapshot.deployments.filter((deployment) => deployment.state === "failed").length;

    this.item.text = `$(rocket) Deployments: ${building} building, ${failed} failed`;

    const providerState = snapshot.providers
      .map((provider) => `${provider.displayName}: ${provider.connected ? "connected" : "disconnected"}`)
      .join("\n");

    this.item.tooltip = `Deployify\n${providerState || "No providers connected."}`;
  }
}
