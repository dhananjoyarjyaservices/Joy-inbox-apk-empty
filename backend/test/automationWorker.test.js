"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { retryDelayMs, timestampMillis, MAX_JOBS_PER_INVOCATION, MAX_ATTEMPTS } = require("../src/automationWorker");

test("uses bounded exponential backoff for retryable queue jobs", () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(2), 2000);
  assert.equal(retryDelayMs(5), 16000);
  assert.equal(retryDelayMs(99), 16000);
  assert.equal(MAX_ATTEMPTS, 5);
});

test("normalizes Firestore timestamps and ordinary dates", () => {
  assert.equal(timestampMillis({ toMillis: () => 1234 }), 1234);
  assert.equal(timestampMillis(new Date(5678)), 5678);
  assert.equal(timestampMillis("invalid-date"), 0);
  assert.equal(timestampMillis(null), 0);
});

test("keeps worker batch size bounded", () => {
  assert.equal(MAX_JOBS_PER_INVOCATION, 25);
});

test("claims a due queue job with a sending status and an expiring lease", async () => {
  const now = new Date("2026-11-23T12:00:00.000Z");
  const updates = [];
  const job = { status: "queued", dueAt: new Date(now.getTime() - 1), attempts: 2 };
  const jobRef = { id: "run_1", path: "organizations/org_1/automationQueue/run_1" };
  const db = {
    async runTransaction(callback) {
      return callback({
        async get() {
          return { exists: true, data: () => job };
        },
        update(reference, patch) {
          updates.push({ reference, patch });
        }
      });
    }
  };

  const { claimQueueJob } = require("../src/automationWorker");
  const claimed = await claimQueueJob(db, jobRef, now);

  assert.equal(claimed.status, "queued");
  assert.equal(claimed.attempts, 3);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.status, "sending");
  assert.equal(updates[0].patch.attempts, 3);
  assert.equal(updates[0].patch.leaseUntil.getTime(), now.getTime() + 2 * 60 * 1000);
});

test("does not claim a job that is not queued or is not due", async () => {
  const now = new Date("2026-11-23T12:00:00.000Z");
  for (const job of [
    { status: "sent", dueAt: new Date(now.getTime() - 1) },
    { status: "queued", dueAt: new Date(now.getTime() + 60_000) }
  ]) {
    const db = {
      async runTransaction(callback) {
        return callback({
          async get() { return { exists: true, data: () => job }; },
          update() { assert.fail("A non-claimable job must not be updated."); }
        });
      }
    };
    const { claimQueueJob } = require("../src/automationWorker");
    assert.equal(await claimQueueJob(db, { id: "job" }, now), null);
  }
});
