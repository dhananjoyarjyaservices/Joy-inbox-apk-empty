"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoUsageStore } = require("../src/aws/dynamoUsageStore");

class Command { constructor(input) { this.input = input; } }
const commands = { GetCommand: Command, TransactWriteCommand: Command };
const plans = [{ key: "lite", limits: { messages: 10, agents: 1, mediaTransferGb: 1, historyMonths: 3 } }];
const at = new Date("2026-11-27T12:00:00.000Z");
const subscription = {
  status: "active", plan: "lite",
  currentPeriodStart: "2026-11-01T00:00:00.000Z",
  currentPeriodEnd: "2026-12-01T00:00:00.000Z"
};
function fixture(send = async () => ({})) {
  const calls = [];
  const client = { send: async command => { calls.push(command.input); return send(command.input); } };
  const store = createDynamoUsageStore({
    documentClient: client, commands, tableName: "JoyInboxMessages",
    subscriptions: { getSubscription: async () => subscription },
    plans, now: () => at
  });
  return { store, calls };
}

test("reserves an outbound message atomically with a hard quota condition", async () => {
  const f = fixture();
  const result = await f.store.reserveOutboundMessage("org_1", "client_msg_1");
  assert.equal(result.enforced, true);
  assert.equal(result.duplicate, false);
  const transaction = f.calls.at(-1).TransactItems;
  assert.equal(transaction.length, 2);
  assert.match(transaction[0].Update.ConditionExpression, /messagesCount/);
  assert.match(transaction[0].Update.UpdateExpression, /messagesCount :one/);
  assert.match(transaction[0].Update.UpdateExpression, /messagesReserved :one/);
  assert.equal(transaction[1].Put.Item.state, "reserved");
  assert.equal(transaction[0].Update.Key.SK, "USAGE#month_1793491200000");
});

test("returns idempotent duplicate for an existing reservation", async () => {
  const f = fixture(input => input.Key?.SK.startsWith("USAGE_RESERVATION#")
    ? { Item: { state: "committed" } } : { Item: subscription });
  const result = await f.store.reserveOutboundMessage("org_1", "client_msg_1");
  assert.equal(result.duplicate, true);
  assert.equal(f.calls.some(input => input.TransactItems), false);
});

test("finishes sent reservation by atomically moving reserved to used", async () => {
  const f = fixture();
  const result = await f.store.finishOutboundReservation({
    enforced: true, duplicate: false, organizationId: "org_1",
    clientMessageId: "client_msg_1", periodKey: "month_1793491200000"
  }, "sent");
  assert.equal(result, true);
  const transaction = f.calls.at(-1).TransactItems;
  assert.match(transaction[0].Update.UpdateExpression, /messagesUsed :one/);
  assert.match(transaction[1].Update.ConditionExpression, /reserved/);
});

test("releases failed reservation without incrementing used count", async () => {
  const f = fixture();
  await f.store.finishOutboundReservation({
    enforced: true, organizationId: "org_1",
    clientMessageId: "client_msg_2", periodKey: "month_1793491200000"
  }, "failed");
  assert.doesNotMatch(f.calls.at(-1).TransactItems[0].Update.UpdateExpression, /messagesUsed :one/);
  assert.match(f.calls.at(-1).TransactItems[0].Update.UpdateExpression, /messagesCount :minus/);
});

test("records inbound provider message idempotently", async () => {
  const f = fixture();
  assert.equal(await f.store.recordInboundMessageUsage("org_1", "wamid.123"), true);
  const tx = f.calls.at(-1).TransactItems;
  assert.equal(tx[1].Put.Item.entityType, "INBOUND_USAGE_EVENT");
  assert.equal(tx[0].Update.ExpressionAttributeValues[":one"], 1);
});

test("reports usage counters and thresholds", async () => {
  const f = fixture(input => input.Key?.SK.startsWith("USAGE#")
    ? { Item: { messagesUsed: 8, messagesReserved: 1 } } : { Item: subscription });
  const usage = await f.store.getUsage("org_1");
  assert.equal(usage.percent, 90);
  assert.deepEqual(usage.thresholdsReached, [80]);
});

test("rejects invalid workspace and inactive subscription", async () => {
  const f = fixture();
  await assert.rejects(() => f.store.reserveOutboundMessage("bad id", "msg"), { statusCode: 400 });
  const inactive = createDynamoUsageStore({
    documentClient: { send: async () => ({}) }, commands, tableName: "JoyInboxMessages",
    subscriptions: { getSubscription: async () => ({ ...subscription, status: "canceled" }) },
    plans, now: () => at
  });
  await assert.rejects(() => inactive.reserveOutboundMessage("org_1", "msg"), { statusCode: 402 });
});
