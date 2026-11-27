"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoOrganizationStore } = require("../src/aws/dynamoOrganizationStore");

class Command { constructor(input) { this.input = input; } }
const commands = { GetCommand: Command, PutCommand: Command, QueryCommand: Command, TransactWriteCommand: Command };

test("creates organization and first owner membership atomically with conditional puts", async () => {
  let sent;
  const store = createDynamoOrganizationStore({
    documentClient: { send: async (command) => { sent = command.input; return {}; } },
    commands, tableName: "JoyInboxMessages"
  });
  const result = await store.createOrganization({ organizationId: "org_1", uid: "user_1", name: "Acme", now: "2026-11-27T00:00:00.000Z" });
  assert.deepEqual(result, { id: "org_1", name: "Acme", role: "owner", status: "active" });
  assert.equal(sent.TransactItems.length, 3);
  assert.equal(sent.TransactItems[0].Put.Item.PK, "ORG#org_1");
  assert.equal(sent.TransactItems[0].Put.Item.SK, "META");
  assert.equal(sent.TransactItems[1].Put.Item.SK, "MEMBER#user_1");
  assert.match(sent.TransactItems[1].Put.ConditionExpression, /attribute_not_exists/);
  assert.equal(sent.TransactItems[2].Put.Item.PK, "USER#user_1");
  assert.equal(sent.TransactItems[2].Put.Item.SK, "ORG#org_1");
});

test("constructs without a GSI because user membership uses the base table", () => {
  assert.doesNotThrow(() => createDynamoOrganizationStore({
    documentClient: { send: async () => ({}) }, commands, tableName: "JoyInboxMessages"
  }));
});

test("resolves active membership from authoritative organization records", async () => {
  const store = createDynamoOrganizationStore({
    documentClient: { send: async (command) => command.input.Key.SK === "META"
      ? { Item: { name: "Acme", status: "active" } }
      : { Item: { role: "admin", status: "active" } } },
    commands, tableName: "JoyInboxMessages"
  });
  const organization = await store.requireActiveOrganization("org_1", "user_1");
  assert.equal(organization.role, "admin");
  assert.equal(organization.uid, "user_1");
});

test("rejects inactive organizations and missing memberships", async () => {
  const store = createDynamoOrganizationStore({
    documentClient: { send: async () => ({ Item: { status: "inactive" } }) },
    commands, tableName: "JoyInboxMessages", userIndexName: "GSI1"
  });
  await assert.rejects(() => store.requireActiveOrganization("org_1", "user_1"), { statusCode: 403 });
});

test("lists organizations by user index and rejects foreign pagination cursors", async () => {
  let sent;
  const store = createDynamoOrganizationStore({
    documentClient: { send: async (command) => { sent = command.input; return { Items: [{ organizationId: "org_1" }] }; } },
    commands, tableName: "JoyInboxMessages", userIndexName: "GSI1"
  });
  const page = await store.listOrganizations("user_1", { limit: 20 });
  assert.equal(page.items[0].organizationId, "org_1");
  assert.equal(sent.IndexName, undefined);
  assert.equal(sent.ExpressionAttributeValues[":user"], "USER#user_1");
  assert.equal(sent.KeyConditionExpression, "PK = :user AND begins_with(SK, :organization)");
  await assert.rejects(() => store.listOrganizations("user_1", { exclusiveStartKey: { PK: "USER#user_2" } }), { statusCode: 400 });
});
