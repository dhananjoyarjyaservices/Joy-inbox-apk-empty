"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoSubscriptionStore } = require("../src/aws/dynamoSubscriptionStore");

class Command { constructor(input) { this.input = input; } }
const commands = { GetCommand: Command, PutCommand: Command };
function fixture(item = null) {
  const sent = [];
  const store = createDynamoSubscriptionStore({
    documentClient: { send: async command => {
      sent.push(command.input);
      return command.input.Key ? { Item: item } : {};
    } },
    commands, tableName: "JoyInboxMessages"
  });
  return { store, sent };
}
const active = {
  plan: "starter", status: "active", stripeCustomerId: "cus_123",
  stripeSubscriptionId: "sub_123",
  currentPeriodStart: "2026-11-01T00:00:00.000Z",
  currentPeriodEnd: "2026-12-01T00:00:00.000Z"
};

test("requires verified webhook provenance before persisting subscription state", async () => {
  const { store, sent } = fixture();
  await assert.rejects(() => store.putVerifiedSubscription("org_1", active), { statusCode: 403 });
  assert.equal(sent.length, 0);
});

test("persists verified subscription under organization billing partition", async () => {
  const { store, sent } = fixture();
  const result = await store.putVerifiedSubscription("org_1", active, { verified: true });
  assert.equal(result.PK, "ORG#org_1");
  assert.equal(result.SK, "BILLING#SUBSCRIPTION");
  assert.equal(result.plan, "starter");
  assert.equal(sent[0].TableName, "JoyInboxMessages");
});

test("resolves seats from active verified subscription and trusted plan catalog", async () => {
  const item = {
    ...active, PK: "ORG#org_1", SK: "BILLING#SUBSCRIPTION",
    currentPeriodStart: "2026-11-01T00:00:00.000Z",
    currentPeriodEnd: "2026-12-01T00:00:00.000Z"
  };
  const { store, sent } = fixture(item);
  assert.equal(await store.getSeatLimit("org_1", new Date("2026-11-27T00:00:00Z")), 2);
  assert.equal(sent[0].ConsistentRead, true);
  assert.equal(sent[0].Key.PK, "ORG#org_1");
});

test("blocks inactive, unknown-plan and expired subscriptions", async () => {
  const inactive = fixture({ ...active, status: "past_due" });
  await assert.rejects(() => inactive.store.getSeatLimit("org_1"), { statusCode: 402 });
  const unknown = fixture({ ...active, plan: "unknown" });
  await assert.rejects(() => unknown.store.getSeatLimit("org_1"), { statusCode: 503 });
  const expired = fixture({ ...active, currentPeriodEnd: "2026-11-01T00:00:00Z" });
  await assert.rejects(() => expired.store.getSeatLimit("org_1", new Date("2026-11-27T00:00:00Z")), { statusCode: 402 });
});

test("rejects invalid plan, Stripe IDs and billing dates before persistence", async () => {
  const { store, sent } = fixture();
  await assert.rejects(() => store.putVerifiedSubscription("org_1", { ...active, plan: "unknown" }, { verified: true }), { statusCode: 400 });
  await assert.rejects(() => store.putVerifiedSubscription("org_1", { ...active, stripeSubscriptionId: "fake" }, { verified: true }), { statusCode: 400 });
  await assert.rejects(() => store.putVerifiedSubscription("org_1", { ...active, currentPeriodEnd: "bad-date" }, { verified: true }), { statusCode: 400 });
  assert.equal(sent.length, 0);
});
