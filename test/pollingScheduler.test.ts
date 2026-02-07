import test from "node:test";
import assert from "node:assert/strict";
import { PollingScheduler } from "../src/core/pollingScheduler";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("triggerNow executes task immediately", async () => {
  let count = 0;
  const scheduler = new PollingScheduler(async () => {
    count += 1;
  }, 1, 0);

  await scheduler.triggerNow();
  scheduler.stop();

  assert.equal(count, 1);
});

test("start schedules repeated executions", async () => {
  let count = 0;

  const scheduler = new PollingScheduler(async () => {
    count += 1;
    if (count >= 3) {
      scheduler.stop();
    }
  }, 0.02, 0.01);

  scheduler.start();
  await sleep(140);

  assert.ok(count >= 3);
});

test("failure triggers retry with backoff", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;

  let count = 0;
  const scheduler = new PollingScheduler(async () => {
    count += 1;
    if (count === 1) {
      throw new Error("first failure");
    }

    scheduler.stop();
  }, 0.01, 0.01);

  scheduler.start();
  await sleep(180);
  scheduler.stop();

  Math.random = originalRandom;
  assert.ok(count >= 2);
});
