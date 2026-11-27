"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoStripeEventStore } = require("../src/aws/dynamoStripeEventStore");

class Command { constructor(input) { this.input = input; } }
const commands = { GetCommand: Command, UpdateCommand: Command };
function fixture(send) {
  const calls = [];
  const store = createDynamoStripeEventStore({
    documentClient: { send: async command => { calls.push(command.input); return send(command.input); } },
    commands, tableName: "JoyInboxMessages",
    now: () => new Date("2026-11-27T12:00:00.000Z"),
    tokenFactory: () => "lease-token-1"
  });
  return { store, calls };
}

test("claims Stripe event atomically with a bounded lease and attempt counter", async () => {
  const { store, calls } = fixture(async () => ({}));
  const result = await store.claim("evt_123456789");
  assert.equal(result.claimed, true);
  assert.equal(result.leaseToken, "lease-token-1");
  assert.equal(result.leaseUntil, "2026-11-27T12:02:00.000Z");
  assert.equal(calls[0].Key.PK, "STRIPE_EVENT#evt_123456789");
  assert.match(calls[0].UpdateExpression, /ADD attempts :one/);
  assert.match(calls[0].ConditionExpression, /<> :processed/);
});

test("returns duplicate or in-progress state when another worker owns the event", async () => {
  const duplicate = fixture(async input => {
    if (input.UpdateExpression) { const error = new Error("conditional"); error.name = "ConditionalCheckFailedException"; throw error; }
    if (input.Key) return { Item: { status: "processed" } };
    const error = new Error("conditional"); error.name = "ConditionalCheckFailedException"; throw error;
  });
  assert.deepEqual(await duplicate.store.claim("evt_123456789"), {
    claimed: false, duplicate: true, inProgress: false, eventId: "evt_123456789"
  });

  const busy = fixture(async input => {
    if (input.UpdateExpression) { const error = new Error("conditional"); error.name = "ConditionalCheckFailedException"; throw error; }
    if (input.Key) return { Item: { status: "processing", leaseUntil: "2026-11-27T12:01:00.000Z" } };
    const error = new Error("conditional"); error.name = "ConditionalCheckFailedException"; throw error;
  });
  const result = await busy.store.claim("evt_123456789");
  assert.equal(result.claimed, false);
  assert.equal(result.inProgress, true);
});

test("finishes only with the current lease token and records processed event type", async () => {
  const { store, calls } = fixture(async () => ({}));
  await store.finish("evt_123456789", "lease-token-1", { status: "processed", eventType: "customer.subscription.updated" });
  assert.match(calls[0].ConditionExpression, /leaseToken = :leaseToken/);
  assert.match(calls[0].UpdateExpression, /processedAt = :now/);
  assert.equal(calls[0].ExpressionAttributeValues[":eventType"], "customer.subscription.updated");
});

test("rejects stale worker completion and records bounded failure details", async () => {
  const stale = fixture(async () => { const error = new Error("conditional"); error.name = "ConditionalCheckFailedException"; throw error; });
  await assert.rejects(() => stale.store.finish("evt_123456789", "old-token", { status: "processed" }), { statusCode: 409 });

  const { store, calls } = fixture(async () => ({}));
  await store.finish("evt_123456789", "lease-token-1", { status: "failed", error: "temporary Stripe timeout" });
  assert.equal(calls[0].ExpressionAttributeValues[":lastError"], "temporary Stripe timeout");
});

test("rejects malformed Stripe event IDs and missing lease tokens", async () => {
  const { store } = fixture(async () => ({}));
  await assert.rejects(() => store.claim("not-an-event"), { statusCode: 400 });
  await assert.rejects(() => store.finish("evt_123456789", "", { status: "processed" }), { statusCode: 409 });
});
