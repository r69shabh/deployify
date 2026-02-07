import test from "node:test";
import assert from "node:assert/strict";
import { findNewlyFailedDeployments } from "../src/core/failureTransitions";
import { DeploymentSummary } from "../src/core/types";

function deployment(overrides: Partial<DeploymentSummary>): DeploymentSummary {
  return {
    provider: "vercel",
    projectId: "project-1",
    environment: "production",
    deploymentId: "dep-1",
    state: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("findNewlyFailedDeployments returns only fresh failures", () => {
  const previous = [
    deployment({ state: "building" }),
    deployment({ projectId: "project-2", environment: "preview", state: "failed" })
  ];

  const current = [
    deployment({ state: "failed", updatedAt: "2026-01-01T00:01:00.000Z" }),
    deployment({ projectId: "project-2", environment: "preview", state: "failed" }),
    deployment({ projectId: "project-3", environment: "production", state: "ready" })
  ];

  const failed = findNewlyFailedDeployments(previous, current);

  assert.equal(failed.length, 1);
  assert.equal(failed[0].projectId, "project-1");
});
