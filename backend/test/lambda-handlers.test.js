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
    ["GET", "/organizations/crm/report"],
    ["GET", "/organizations/crm/leads"],
    ["POST", "/organizations/crm/leads"],
    ["POST", "/organizations/crm/leads/import"],
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


test("webhook delivery history and replay routes require workspace authentication", async () => {
  const { handler } = require("../src/index");
  const getResponse = await handler({
    httpMethod: "GET",
    path: "/organizations/developer/webhook-deliveries",
    headers: {},
    queryStringParameters: { organizationId: "org_a" }
  });
  const rotateResponse = await handler({
    httpMethod: "PUT",
    path: "/organizations/developer/webhooks",
    headers: {},
    body: JSON.stringify({ organizationId: "org_a", webhookId: "webhook_a" })
  });
  const postResponse = await handler({
    httpMethod: "POST",
    path: "/organizations/developer/webhook-deliveries",
    headers: {},
    body: JSON.stringify({ organizationId: "org_a", deliveryId: "a".repeat(64) })
  });
  assert.equal(getResponse.statusCode, 401);
  assert.equal(rotateResponse.statusCode, 401);
  assert.equal(postResponse.statusCode, 401);
});
