"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoStores } = require("../src/aws/dynamoStores");

class Command { constructor(input) { this.input = input; } }
const commands = {
  GetCommand: Command, PutCommand: Command, QueryCommand: Command,
  DeleteCommand: Command, TransactWriteCommand: Command
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
