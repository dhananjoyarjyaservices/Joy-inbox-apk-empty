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

test("marks an expired sending job uncertain without making it retryable", async () => {
  const { markExpiredQueueJobUncertain } = require("../src/automationWorker");
  const now = new Date("2026-11-23T12:00:00.000Z");
  const writes = [];
  const runRef = { path: "organizations/org_1/automationRuns/run_1" };
  const organizationRef = {
    collection(name) {
      assert.equal(name, "automationRuns");
      return { doc(id) { assert.equal(id, "run_1"); return runRef; } };
    }
  };
  const jobRef = {
    parent: { parent: organizationRef }
  };
  const stale = {
    ref: jobRef,
    data() { return { runId: "run_1", stepIndex: 1 }; }
  };
  const db = {
    async runTransaction(callback) {
      return callback({
        async get() {
          return {
            exists: true,
            data() { return { status: "sending", leaseUntil: new Date(now.getTime() - 1) }; }
          };
        },
        update(reference, patch) { writes.push({ type: "update", reference, patch }); },
        set(reference, patch, options) { writes.push({ type: "set", reference, patch, options }); }
      });
    }
  };

  assert.equal(await markExpiredQueueJobUncertain(db, stale, now), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].patch.status, "uncertain");
  assert.equal(writes[0].patch.leaseUntil, null);
  assert.match(writes[0].patch.error, /automatic resend was prevented/i);
  assert.equal(writes[1].reference, runRef);
  assert.equal(writes[1].patch.status, "partially_failed");
});

test("does not alter a job whose lease has not expired", async () => {
  const { markExpiredQueueJobUncertain } = require("../src/automationWorker");
  const now = new Date("2026-11-23T12:00:00.000Z");
  const stale = {
    data() { return { runId: "run_1" }; },
    ref: { parent: { parent: { collection() { return { doc() { return {}; } }; } } } }
  };
  const db = {
    async runTransaction(callback) {
      return callback({
        async get() {
          return {
            exists: true,
            data() { return { status: "sending", leaseUntil: new Date(now.getTime() + 60_000) }; }
          };
        },
        update() { assert.fail("A live lease must not be changed."); },
        set() { assert.fail("A live lease must not update its run."); }
      });
    }
  };
  assert.equal(await markExpiredQueueJobUncertain(db, stale, now), false);
});

test("classifies ambiguous send outcomes as uncertain to prevent duplicate delivery", () => {
  const { getFailureDisposition } = require("../src/automationWorker");
  assert.equal(getFailureDisposition(new Error("network timeout"), true, 1), "uncertain");
  assert.equal(getFailureDisposition(new Error("Firestore write failed"), true, 4), "uncertain");
});

test("keeps definitive send rejections failed and safe retryable rate limits queued", () => {
  const { getFailureDisposition } = require("../src/automationWorker");
  assert.equal(getFailureDisposition(Object.assign(new Error("invalid recipient"), { definitive: true }), true, 1), "failed");
  assert.equal(getFailureDisposition(Object.assign(new Error("rate limited"), { metaStatusCode: 429 }), true, 1), "queued");
  assert.equal(getFailureDisposition(Object.assign(new Error("rate limited"), { metaStatusCode: 429 }), true, 5), "failed");
  assert.equal(getFailureDisposition(Object.assign(new Error("temporary issue"), { retryable: true }), false, 1), "queued");
});


test("automation queue continues only while its source rule remains enabled", () => {
  const { automationRuleAllowsQueue } = require("../src/automationWorker");
  assert.equal(automationRuleAllowsQueue({ exists: true, data: () => ({ enabled: true }) }), true);
  assert.equal(automationRuleAllowsQueue({ exists: true, data: () => ({ enabled: false }) }), false);
  assert.equal(automationRuleAllowsQueue({ exists: false, data: () => ({ enabled: true }) }), false);
  assert.equal(automationRuleAllowsQueue(null), false);
});


test("does not send delayed automation steps after their rule is disabled or deleted", async () => {
  const { processClaimedJob } = require("../src/automationWorker");
  const writes = [];
  const runRef = {
    async get() { return { exists: true, data: () => ({ completedSteps: 0, status: "sending" }) }; },
    async set(patch, options) { writes.push({ type: "run", patch, options }); }
  };
  const ruleRef = {
    async get() { return { exists: true, data: () => ({ enabled: false }) }; }
  };
  const organizationRef = {
    collection(name) {
      return { doc(id) {
        if (name === "automationRuns" && id === "run_1") return runRef;
        if (name === "automationRules" && id === "rule_1") return ruleRef;
        if (name === "chats" && id === "919876543210") return { collection(child) { assert.equal(child, "messages"); return {}; } };
        throw new Error("Unexpected automation reference " + name + "/" + id);
      } };
    }
  };
  const jobRef = {
    id: "job_1",
    async update(patch) { writes.push({ type: "job", patch }); }
  };
  let sendCalls = 0;
  const outcome = await processClaimedJob({}, jobRef, {
    runId: "run_1", ruleId: "rule_1", organizationId: "org_1",
    customerPhone: "919876543210", text: "Delayed reply", stepIndex: 1, totalSteps: 2
  }, organizationRef, {
    now: () => new Date("2026-11-24T12:00:00.000Z"),
    getWhatsAppCredentials: async () => { throw new Error("Credentials must not be loaded."); },
    sendWhatsAppText: async () => { sendCalls += 1; throw new Error("Message must not be sent."); }
  });
  assert.equal(outcome, "skipped");
  assert.equal(sendCalls, 0);
  assert.equal(writes[0].patch.status, "skipped");
  assert.equal(writes[0].patch.reason, "automation_rule_disabled_or_deleted");
  assert.equal(writes[1].patch.status, "skipped");
});
