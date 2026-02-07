import * as vscode from "vscode";
import { DeploymentStoreUpdate } from "./types";
import { findNewlyFailedDeployments } from "./failureTransitions";

export class NotificationService {
  public handleStoreUpdate(update: DeploymentStoreUpdate): void {
    const notifyOnFailure = vscode.workspace.getConfiguration("deployify").get<boolean>("notifyOnFailure", true);

    if (!notifyOnFailure) {
      return;
    }

    const failures = findNewlyFailedDeployments(update.previous.deployments, update.current.deployments);

    for (const deployment of failures) {
      const age = new Date(deployment.updatedAt).toLocaleTimeString();
      void vscode.window.showWarningMessage(
        `Deployify: ${deployment.provider} ${deployment.projectId} (${deployment.environment}) failed at ${age}.`,
        "Open Deployment"
      ).then((selection) => {
        if (selection === "Open Deployment" && deployment.url) {
          void vscode.env.openExternal(vscode.Uri.parse(deployment.url));
        }
      });
    }
  }
}
