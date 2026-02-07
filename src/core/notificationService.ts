import * as vscode from "vscode";
import { DeploymentStoreUpdate } from "./types";
import { findNewlyFailedDeployments } from "./failureTransitions";

export class NotificationService {
  private hasPrimed = false;

  public handleStoreUpdate(update: DeploymentStoreUpdate): void {
    const notifyOnFailure = vscode.workspace.getConfiguration("deployify").get<boolean>("notifyOnFailure", true);

    if (!notifyOnFailure) {
      return;
    }

    // Do not emit alerts for historical failures on first sync.
    if (!this.hasPrimed) {
      this.hasPrimed = true;
      return;
    }

    const failures = findNewlyFailedDeployments(update.previous.deployments, update.current.deployments);

    for (const deployment of failures) {
      const failedAt = new Date(deployment.updatedAt);
      const localTime = Number.isNaN(failedAt.valueOf())
        ? deployment.updatedAt
        : failedAt.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "short"
          });

      void vscode.window.showWarningMessage(
        `Deployify: ${deployment.provider} ${deployment.projectId} (${deployment.environment}) failed at ${localTime}.`,
        "Open Deployment"
      ).then((selection) => {
        if (selection === "Open Deployment" && deployment.url) {
          void vscode.env.openExternal(vscode.Uri.parse(deployment.url));
        }
      });
    }
  }
}
