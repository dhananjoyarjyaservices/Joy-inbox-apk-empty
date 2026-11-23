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
