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

test("CRM API endpoints require Firebase authentication before workspace data access", async () => {
  const { handler } = require("../src/index");
  for (const [method, path] of [
    ["GET", "/organizations/crm/fields"],
    ["POST", "/organizations/crm/fields"],
    ["GET", "/organizations/crm/stages"],
    ["POST", "/organizations/crm/stages"],
    ["GET", "/organizations/crm/leads"],
    ["POST", "/organizations/crm/leads"],
    ["DELETE", "/organizations/crm/leads"]
  ]) {
    const response = await handler({
      httpMethod: method,
      path,
      headers: {},
      queryStringParameters: { organizationId: "org_a" },
      body: method === "GET" ? undefined : JSON.stringify({ organizationId: "org_a", data: {} })
    });
    assert.equal(response.statusCode, 401, `${method} ${path} must reject anonymous requests`);
  }
});
