"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoAuditStore } = require("../src/aws/dynamoAuditStore");

class Command { constructor(input) { this.input = input; } }
const commands = { PutCommand: Command, QueryCommand: Command };
function fixture() {
  const sent = [];
  const store = createDynamoAuditStore({
    documentClient: { send: async command => { sent.push(command.input); return { Items: [], LastEvaluatedKey: null }; } },
    commands, tableName: "JoyInboxMessages", idFactory: () => "event_123"
  });
  return { store, sent };
}
const validEvent = {
  organizationId: "org_1", actorUid: "owner_1", actorRole: "owner",
  action: "member.added", targetUid: "agent_1", details: { role: "agent" },
  createdAt: "2026-11-27T12:00:00.000Z"
};

test("writes audit events to the organization partition with conditional create", async () => {
  const { store, sent } = fixture();
  const item = await store.record(validEvent);
  assert.equal(item.PK, "ORG#org_1");
  assert.equal(item.SK, "AUDIT#2026-11-27T12:00:00.000Z#event_123");
  assert.equal(item.entityType, "AUDIT_EVENT");
  assert.equal(sent[0].TableName, "JoyInboxMessages");
  assert.equal(sent[0].ConditionExpression, "attribute_not_exists(PK) AND attribute_not_exists(SK)");
});

test("rejects malformed or oversized audit data before writing", async () => {
  const { store, sent } = fixture();
  await assert.rejects(() => store.record({ ...validEvent, organizationId: "other/org" }), { statusCode: 400 });
  await assert.rejects(() => store.record({ ...validEvent, actorRole: "superadmin" }), { statusCode: 400 });
  await assert.rejects(() => store.record({ ...validEvent, details: { payload: "x".repeat(9000) } }), { statusCode: 400 });
  assert.equal(sent.length, 0);
});

test("lists only audit rows in the requested tenant partition and validates cursors", async () => {
  const { store, sent } = fixture();
  await store.list("org_1", { limit: 20 });
  assert.equal(sent[0].ExpressionAttributeValues[":organization"], "ORG#org_1");
  assert.equal(sent[0].ExpressionAttributeValues[":audit"], "AUDIT#");
  assert.equal(sent[0].ScanIndexForward, false);
  await assert.rejects(() => store.list("org_1", { exclusiveStartKey: { PK: "ORG#org_2", SK: "AUDIT#x" } }), { statusCode: 400 });
  await assert.rejects(() => store.list("org_1", { limit: 101 }), { statusCode: 400 });
});

test("rejects invalid event IDs", async () => {
  const store = createDynamoAuditStore({
    documentClient: { send: async () => ({}) }, commands, tableName: "JoyInboxMessages",
    idFactory: () => "invalid/id"
  });
  await assert.rejects(() => store.record(validEvent), /invalid ID/);
});
