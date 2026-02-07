import { DeploymentSummary } from "./types";

function keyForDeployment(summary: DeploymentSummary): string {
  return `${summary.provider}:${summary.projectId}:${summary.environment}`;
}

export function findNewlyFailedDeployments(
  previous: DeploymentSummary[],
  current: DeploymentSummary[]
): DeploymentSummary[] {
  const previousMap = new Map(previous.map((deployment) => [keyForDeployment(deployment), deployment.state]));

  return current.filter((deployment) => {
    if (deployment.state !== "failed") {
      return false;
    }

    const previousState = previousMap.get(keyForDeployment(deployment));
    return previousState !== "failed";
  });
}
