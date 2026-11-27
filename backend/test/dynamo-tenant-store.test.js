"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoTenantStore } = require("../src/aws/dynamoTenantStore");

class Command {
  constructor(input) { this.input = input; }
}
const commands = {
  GetCommand: class extends Command {},
  PutCommand: class extends Command {},
  QueryCommand: class extends Command {},
  DeleteCommand: class extends Command {}
};

function createClient(responses = []) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return responses.shift() || {};
    }
  };
}

test("DynamoDB tenant store reads only the requested organization partition", async () => {
  const client = createClient([{ Item: { PK: "ORG#org_a", SK: "CONTACT#contact_a", name: "A" } }]);
  const store = createDynamoTenantStore({ documentClient: client, commands, tableName: "JoyInboxMessages" });
  const item = await store.get("org_a", "CONTACT", "contact_a");
  assert.equal(item.name, "A");
  assert.deepEqual(client.calls[0].input.Key, { PK: "ORG#org_a", SK: "CONTACT#contact_a" });
  assert.equal(client.calls[0].input.ConsistentRead, true);
});

test("DynamoDB tenant store enforces create-only writes when requested", async () => {
  const client = createClient();
  const store = createDynamoTenantStore({ documentClient: client, commands, tableName: "JoyInboxMessages" });
  const item = await store.put("org_a", "CONTACT", "contact_a", { name: "A", organizationId: "org_other" }, { ifAbsent: true });
  assert.equal(item.organizationId, "org_a");
  assert.equal(item.PK, "ORG#org_a");
  assert.equal(client.calls[0].input.ConditionExpression, "attribute_not_exists(PK) AND attribute_not_exists(SK)");
});

test("DynamoDB tenant store paginates within the tenant and resource prefix", async () => {
  const client = createClient([{ Items: [{ SK: "CHAT#chat_a" }], LastEvaluatedKey: { PK: "ORG#org_a", SK: "CHAT#chat_a" } }]);
  const store = createDynamoTenantStore({ documentClient: client, commands, tableName: "JoyInboxMessages" });
  const page = await store.list("org_a", "CHAT", { limit: 20 });
  assert.equal(page.items.length, 1);
  assert.equal(client.calls[0].input.ExpressionAttributeValues[":pk"], "ORG#org_a");
  assert.equal(client.calls[0].input.ExpressionAttributeValues[":prefix"], "CHAT#");
});

test("DynamoDB tenant store rejects cross-tenant pagination cursors", async () => {
  const client = createClient();
  const store = createDynamoTenantStore({ documentClient: client, commands, tableName: "JoyInboxMessages" });
  await assert.rejects(
    store.list("org_a", "CHAT", { exclusiveStartKey: { PK: "ORG#org_b", SK: "CHAT#chat_a" } }),
    { statusCode: 400 }
  );
  assert.equal(client.calls.length, 0);
});

test("DynamoDB tenant store validates identifiers before issuing commands", async () => {
  const client = createClient();
  const store = createDynamoTenantStore({ documentClient: client, commands, tableName: "JoyInboxMessages" });
  await assert.rejects(store.get("org/a", "CHAT", "chat_a"), { statusCode: 400 });
  await assert.rejects(store.put("org_a", "chat", "chat_a", {}), { statusCode: 400 });
  assert.equal(client.calls.length, 0);
});
