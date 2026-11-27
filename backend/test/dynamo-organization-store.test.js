"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoOrganizationStore } = require("../src/aws/dynamoOrganizationStore");

class Command { constructor(input) { this.input = input; } }
const commands = { GetCommand: Command, PutCommand: Command, QueryCommand: Command, TransactWriteCommand: Command, DeleteCommand: Command };

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
  await assert.rejects(() => store.listOrganizations("user_1", { exclusiveStartKey: { PK: "USER#user_2", SK: "ORG#org_1" } }), { statusCode: 400 });
  await assert.rejects(() => store.listOrganizations("user_1", { exclusiveStartKey: { PK: "USER#user_1", SK: "CUSTOMER#customer_1" } }), { statusCode: 400 });
});

test("adds a non-owner member atomically to organization and user lookup records", async () => {
  let sent;
  const store = createDynamoOrganizationStore({
    documentClient: { send: async (command) => { sent = command.input; return {}; } },
    commands, tableName: "JoyInboxMessages"
  });
  const result = await store.addMember({ organizationId: "org_1", uid: "user_2", role: "agent", seatLimit: 5 });
  assert.deepEqual(result, { uid: "user_2", role: "agent", status: "active" });
  assert.equal(sent.TransactItems.length, 3);
  assert.equal(sent.TransactItems[0].Put.Item.SK, "MEMBER#user_2");
  assert.equal(sent.TransactItems[1].Put.Item.PK, "USER#user_2");
  assert.equal(sent.TransactItems[2].Update.ExpressionAttributeValues[":seatLimit"], 5);
  assert.match(sent.TransactItems[2].Update.ConditionExpression, /activeMemberCount < :seatLimit/);
});

test("rejects owner assignment to a new member and protects owner removal", async () => {
  const store = createDynamoOrganizationStore({
    documentClient: { send: async (command) => command.input.Key.SK === "MEMBER#user_1"
      ? { Item: { role: "owner", status: "active" } }
      : {} },
    commands, tableName: "JoyInboxMessages"
  });
  await assert.rejects(() => store.addMember({ organizationId: "org_1", uid: "user_2", role: "owner", seatLimit: 5 }), { statusCode: 400 });
  await assert.rejects(() => store.removeMember({ organizationId: "org_1", uid: "user_1" }), { statusCode: 409 });
});

test("updates and removes non-owner memberships using DynamoDB transactions", async () => {
  let sent;
  const store = createDynamoOrganizationStore({
    documentClient: { send: async (command) => {
      if (command.input.Key?.SK === "MEMBER#user_2") return { Item: { uid: "user_2", role: "agent", status: "active" } };
      sent = command.input;
      return {};
    } },
    commands, tableName: "JoyInboxMessages"
  });
  await store.updateMemberRole({ organizationId: "org_1", uid: "user_2", role: "admin" });
  assert.equal(sent.TransactItems[0].Put.Item.role, "admin");
  assert.equal(sent.TransactItems[1].Put.Item.role, "admin");
  assert.match(sent.TransactItems[0].Put.ConditionExpression, /#role <> :owner/);
  assert.match(sent.TransactItems[0].Put.ConditionExpression, /#status = :active/);
  await store.removeMember({ organizationId: "org_1", uid: "user_2" });
  assert.ok(sent.TransactItems.slice(0, 2).every(item => item.Delete));
  assert.match(sent.TransactItems[2].Update.UpdateExpression, /activeMemberCount/);
  assert.match(sent.TransactItems[0].Delete.ConditionExpression, /#role <> :owner/);
  assert.match(sent.TransactItems[0].Delete.ConditionExpression, /#status = :active/);
});

test("lists organization members with tenant-bound pagination", async () => {
  let sent;
  const store = createDynamoOrganizationStore({
    documentClient: { send: async command => { sent = command.input; return { Items: [{ uid: "user_2" }] }; } },
    commands, tableName: "JoyInboxMessages"
  });
  const page = await store.listMembers("org_1", { limit: 10 });
  assert.equal(page.items[0].uid, "user_2");
  assert.equal(sent.KeyConditionExpression, "PK = :organization AND begins_with(SK, :member)");
  assert.equal(sent.ExpressionAttributeValues[":organization"], "ORG#org_1");
  await assert.rejects(() => store.listMembers("org_1", {
    exclusiveStartKey: { PK: "ORG#org_2", SK: "MEMBER#user_2" }
  }), { statusCode: 400 });
  await assert.rejects(() => store.listMembers("org_1", {
    exclusiveStartKey: { PK: "ORG#org_1", SK: "CUSTOMER#user_2" }
  }), { statusCode: 400 });
});
