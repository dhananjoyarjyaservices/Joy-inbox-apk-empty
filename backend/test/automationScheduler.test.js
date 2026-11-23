const test = require("node:test");
const assert = require("node:assert/strict");
const { runScheduledAutomationSteps } = require("../src/automationScheduler");

function emptyQueueDb() {
  return {
    collectionGroup() {
      const query = {
        where() { return query; },
        orderBy() { return query; },
        limit() { return query; },
        async get() { return { docs: [], size: 0 }; }
      };
      return query;
    }
  };
}

test("scheduled automation delegates to the lease-aware queue worker", async () => {
  const result = await runScheduledAutomationSteps({
    db: emptyQueueDb(),
    now: new Date("2026-11-23T00:00:00.000Z")
  });
  assert.deepEqual(result, {
    scanned: 0,
    due: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    retried: 0,
    claimed: 0,
    uncertain: 0
  });
});
