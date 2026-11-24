"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("Lambda entry points export the configured HTTP and scheduled handlers", () => {
  const api = require("../src/index");
  const automation = require("../src/automationWorker");

  for (const name of ["handler", "slaScheduledHandler", "historyRetentionScheduledHandler", "campaignScheduledHandler"]) {
    assert.equal(typeof api[name], "function", `src/index.${name} must be an exported Lambda handler`);
  }
  assert.equal(typeof automation.handler, "function", "src/automationWorker.handler must be an exported Lambda handler");
});
