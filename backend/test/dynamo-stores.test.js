"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoStores } = require("../src/aws/dynamoStores");

class Command { constructor(input) { this.input = input; } }
const commands = {
  GetCommand: Command, PutCommand: Command, QueryCommand: Command,
  DeleteCommand: Command, TransactWriteCommand: Command, UpdateCommand: Command
};

test("routes organization and message data to the messages table and CRM/workspaces to separate tables", async () => {
  const sent = [];
  const stores = createDynamoStores({
    documentClient: { send: async (command) => { sent.push(command.input); return {}; } },
    commands,
    env: {
      DYNAMODB_MESSAGES_TABLE: "JoyInboxMessages",
      DYNAMODB_CUSTOMERS_TABLE: "JoyInboxCustomers",
      DYNAMODB_WORKSPACES_TABLE: "JoyInboxWorkspaces"
    }
  });
  assert.deepEqual(stores.tableNames, {
    messages: "JoyInboxMessages",
    customers: "JoyInboxCustomers",
    workspaces: "JoyInboxWorkspaces"
  });
  await stores.customers.put("org_1", "customer_1", { name: "Asha" });
  await stores.workspaces.put("org_1", "workspace_1", { phoneNumberId: "123456" });
  await stores.messages.put("org_1", "MESSAGE", "message_1", { text: "hello" });
  assert.equal(sent[0].TableName, "JoyInboxCustomers");
  assert.equal(sent[0].Item.PK, "ORG#org_1");
  assert.equal(sent[0].Item.SK, "CUSTOMER#customer_1");
  assert.equal(sent[1].TableName, "JoyInboxWorkspaces");
  assert.equal(sent[1].Item.SK, "WORKSPACE#workspace_1");
  assert.equal(sent[2].TableName, "JoyInboxMessages");
  assert.equal(sent[2].Item.SK, "MESSAGE#message_1");
});

test("rejects table-name collisions to prevent cross-domain writes", () => {
  assert.throws(() => createDynamoStores({
    documentClient: { send: async () => ({}) }, commands,
    env: {
      DYNAMODB_MESSAGES_TABLE: "JoyInboxMessages",
      DYNAMODB_CUSTOMERS_TABLE: "JoyInboxMessages",
      DYNAMODB_WORKSPACES_TABLE: "JoyInboxWorkspaces"
    }
  }), /three distinct DynamoDB tables/);
});

test("exposes native tenant-scoped audit store and uses it for member-management audit", async () => {
  const sent = [];
  const stores = createDynamoStores({
    documentClient: { send: async command => { sent.push(command.input); return {}; } },
    commands,
    env: {},
    getSeatLimit: async () => 5
  });
  assert.equal(typeof stores.audit.record, "function");
  assert.equal(typeof stores.audit.list, "function");
  assert.ok(stores.memberManagement);
  await stores.audit.record({
    organizationId: "org_1", actorUid: "owner_1", actorRole: "owner",
    action: "member.added", targetUid: "agent_1", details: { role: "agent" }
  });
  assert.equal(sent[0].TableName, "JoyInboxMessages");
  assert.equal(sent[0].Item.PK, "ORG#org_1");
  assert.ok(sent[0].Item.SK.startsWith("AUDIT#"));
});

test("member management is wired to the verified DynamoDB subscription seat resolver", () => {
  const stores = createDynamoStores({
    documentClient: { send: async () => ({}) }, commands, env: {}
  });
  assert.ok(stores.memberManagement);
  assert.equal(typeof stores.subscriptions.getSeatLimit, "function");
  assert.equal(typeof stores.subscriptions.putVerifiedSubscription, "function");
  assert.equal(typeof stores.stripeEvents.claim, "function");
  assert.equal(typeof stores.stripeEvents.finish, "function");
  assert.equal(typeof stores.stripeBilling.process, "function");
  assert.equal(typeof stores.usage.reserveOutboundMessage, "function");
  assert.equal(typeof stores.usage.finishOutboundReservation, "function");
  assert.equal(typeof stores.usage.reserveMediaTransfer, "function");
  assert.equal(typeof stores.usage.finishMediaTransfer, "function");
  assert.equal(typeof stores.usage.recordInboundMessageUsage, "function");
});
