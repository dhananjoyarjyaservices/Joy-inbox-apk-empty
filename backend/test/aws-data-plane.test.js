"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dynamodb = require("../src/dynamodb");
const media = require("../src/s3Media");
const workspaces = require("../src/dynamodbWorkspaces");
const records = require("../src/dynamodbRecords");
const members = require("../src/dynamodbMembers");

test("DynamoDB workspace service validates names and verified Firebase identities", () => {
  assert.equal(workspaces.normalizeWorkspaceName("  My   Business  "), "My Business");
  assert.throws(() => workspaces.normalizeWorkspaceName("x"), { statusCode: 400 });
  return assert.rejects(workspaces.createWorkspace({}, { name: "My Business" }), { statusCode: 401 });
});

test("DynamoDB key builders create workspace-scoped PK/SK values", () => {
  assert.deepEqual(dynamodb.workspaceKey("workspace_1"), { PK: "ORG#workspace_1", SK: "WORKSPACE" });
  assert.deepEqual(dynamodb.membershipKey("workspace_1", "user_1"), { PK: "ORG#workspace_1", SK: "MEMBER#user_1" });
  assert.deepEqual(dynamodb.customerKey("workspace_1", "customer_1"), { PK: "ORG#workspace_1", SK: "CUSTOMER#customer_1" });
  assert.deepEqual(dynamodb.messageKey("workspace_1", "conversation_1", 1760000000000, "message_1"), {
    PK: "ORG#workspace_1#CONVERSATION#conversation_1",
    SK: "MESSAGE#0001760000000000#message_1"
  });
});

test("DynamoDB key builders support user workspace pointers and conversation summaries", () => {
  assert.equal(dynamodb.userWorkspacePartition("user_1"), "USER#user_1");
  assert.deepEqual(dynamodb.userWorkspacePointerKey("user_1", "workspace_1"), {
    PK: "USER#user_1",
    SK: "ORG#workspace_1"
  });
  assert.deepEqual(dynamodb.conversationSummaryKey("workspace_1", "conversation_1"), {
    PK: "ORG#workspace_1",
    SK: "CONVERSATION#conversation_1"
  });
});

test("DynamoDB user and conversation key builders reject malformed IDs", () => {
  assert.throws(() => dynamodb.userWorkspacePartition("../user"), { statusCode: 400 });
  assert.throws(() => dynamodb.userWorkspacePointerKey("user_1", "../workspace"), { statusCode: 400 });
  assert.throws(() => dynamodb.conversationSummaryKey("workspace_1", "bad/conversation"), { statusCode: 400 });
});

test("DynamoDB tenant partition guard rejects cross-tenant and unscoped partitions", () => {
  assert.doesNotThrow(() => dynamodb.assertTenantPartition("org_a", "ORG#org_a"));
  assert.doesNotThrow(() => dynamodb.assertTenantPartition("org_a", "ORG#org_a#CONVERSATION#c1"));
  assert.throws(() => dynamodb.assertTenantPartition("org_a", "ORG#org_b"));
  assert.throws(() => dynamodb.assertTenantPartition("org_a", "USER#user_a"));
});

test("DynamoDB key builders reject malformed IDs and timestamps", () => {
  assert.throws(() => dynamodb.workspaceKey("../other"), { statusCode: 400 });
  assert.throws(() => dynamodb.customerKey("org_a", "bad/customer"), { statusCode: 400 });
  assert.throws(() => dynamodb.messageKey("org_a", "conv_a", "not-a-time", "msg_a"), { statusCode: 400 });
});


test("DynamoDB workspace creation writes workspace, owner and reverse pointer atomically", async () => {
  const previous = {
    region: process.env.AWS_REGION,
    workspaces: process.env.DYNAMODB_WORKSPACES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return {};
    }
  });
  try {
    const created = await workspaces.createWorkspace(
      { uid: "firebase_user_1" },
      { name: "Example Shop" },
      { organizationId: "workspace_1" }
    );
    assert.deepEqual(created, {
      id: "workspace_1",
      name: "Example Shop",
      role: "owner",
      status: "active"
    });
    assert.equal(captured.TransactItems.length, 3);
    const items = captured.TransactItems.map(entry => entry.Put.Item);
    assert.deepEqual(items.map(item => [item.PK, item.SK]), [
      ["ORG#workspace_1", "WORKSPACE"],
      ["ORG#workspace_1", "MEMBER#firebase_user_1"],
      ["USER#firebase_user_1", "ORG#workspace_1"]
    ]);
    assert.ok(captured.TransactItems.every(entry =>
      entry.Put.ConditionExpression.includes("attribute_not_exists")
    ));
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (previous.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous.region;
    if (previous.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE;
    else process.env.DYNAMODB_WORKSPACES_TABLE = previous.workspaces;
  }
});

test("DynamoDB partition queries support safe sort-key prefix filtering", async () => {
  const previous = {
    region: process.env.AWS_REGION,
    workspaces: process.env.DYNAMODB_WORKSPACES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return { Items: [] };
    }
  });
  try {
    await dynamodb.queryPartition("workspaces", "workspace_1", "ORG#workspace_1", {
      sortKeyBeginsWith: "MEMBER#"
    });
    assert.equal(captured.KeyConditionExpression, "PK = :pk AND begins_with(SK, :skPrefix)");
    assert.equal(captured.ExpressionAttributeValues[":skPrefix"], "MEMBER#");
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (previous.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous.region;
    if (previous.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE;
    else process.env.DYNAMODB_WORKSPACES_TABLE = previous.workspaces;
  }
});


test("DynamoDB customer and conversation repositories enforce tenant keys", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  const writes = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      writes.push(command.input);
      return {};
    }
  });
  try {
    const customer = await records.saveCustomer("workspace_1", "customer_1", {
      name: "Customer One",
      organizationId: "attacker_workspace"
    });
    assert.equal(customer.PK, "ORG#workspace_1");
    assert.equal(customer.organizationId, "workspace_1");
    assert.equal(customer.SK, "CUSTOMER#customer_1");
    const conversation = await records.saveConversationSummary("workspace_1", "conversation_1", {
      status: "open",
      PK: "ORG#attacker"
    });
    assert.equal(conversation.PK, "ORG#workspace_1");
    assert.equal(conversation.SK, "CONVERSATION#conversation_1");
    assert.equal(writes.length, 2);
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE;
    else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
  }
});

test("DynamoDB message repository writes idempotently with validated tenant partition", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    messages: process.env.DYNAMODB_MESSAGES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_MESSAGES_TABLE = "JoyInboxMessages";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return {};
    }
  });
  try {
    const message = await records.saveMessage("workspace_1", "conversation_1", {
      id: "provider_message_1",
      timestamp: 1760000000000,
      text: "Hello",
      organizationId: "spoofed_workspace",
      PK: "ORG#spoofed"
    });
    assert.equal(message.PK, "ORG#workspace_1#CONVERSATION#conversation_1");
    assert.equal(message.organizationId, "workspace_1");
    assert.equal(message.messageId, "provider_message_1");
    assert.match(captured.ConditionExpression, /attribute_not_exists/);
    await assert.rejects(
      records.saveMessage("workspace_1", "conversation_1", { id: "bad", timestamp: -1 }),
      { statusCode: 400 }
    );
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prior.region;
    if (prior.messages === undefined) delete process.env.DYNAMODB_MESSAGES_TABLE;
    else process.env.DYNAMODB_MESSAGES_TABLE = prior.messages;
  }
});

test("DynamoDB table names must be configured explicitly", () => {
  const prior = process.env.DYNAMODB_CUSTOMERS_TABLE;
  delete process.env.DYNAMODB_CUSTOMERS_TABLE;
  assert.throws(() => dynamodb.getTableName("customers"), /DYNAMODB_CUSTOMERS_TABLE/);
  if (prior !== undefined) process.env.DYNAMODB_CUSTOMERS_TABLE = prior;
});

test("S3 object keys are generated under tenant prefixes and never use display filenames", () => {
  const key = media.buildMessageMediaKey({
    organizationId: "org_a",
    customerId: "customer_a",
    messageId: "message_a",
    objectId: "object_a"
  });
  assert.equal(key, "tenants/org_a/customers/customer_a/messages/message_a/object_a");
  assert.equal(media.buildQuickReplyImageKey({
    organizationId: "org_a",
    quickReplyId: "reply_a",
    objectId: "image_a"
  }), "tenants/org_a/quick-replies/reply_a/image_a");
  assert.throws(() => media.buildMessageMediaKey({
    organizationId: "../other",
    customerId: "customer_a",
    messageId: "message_a"
  }), { statusCode: 400 });
});


test("DynamoDB workspace context requires active workspace membership", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  dynamodb.setDocumentClientForTests({
    async send(command) {
      if (command.input.Key.SK === "WORKSPACE") {
        return { Item: { PK: "ORG#workspace_1", SK: "WORKSPACE", organizationId: "workspace_1", status: "active", createdBy: "owner_1" } };
      }
      return { Item: { PK: "ORG#workspace_1", SK: "MEMBER#user_1", uid: "user_1", role: "agent", status: "active" } };
    }
  });
  try {
    const context = await members.getWorkspaceContext({ uid: "user_1" }, "workspace_1");
    assert.equal(context.id, "workspace_1");
    assert.equal(context.role, "agent");
    await assert.rejects(members.getWorkspaceContext({}, "workspace_1"), { statusCode: 401 });
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});

test("DynamoDB member role changes atomically update membership and reverse pointer", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  const commands = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetCommand") {
        return { Item: { uid: "agent_1", role: "agent", status: "active" } };
      }
      return {};
    }
  });
  try {
    const result = await members.updateWorkspaceMemberRole(
      { id: "workspace_1", createdBy: "owner_1" },
      { uid: "owner_1", role: "owner" },
      { uid: "agent_1", role: "admin" }
    );
    assert.deepEqual(result, { uid: "agent_1", role: "admin" });
    const transaction = commands.find(command => command.constructor.name === "TransactWriteCommand");
    assert.equal(transaction.input.TransactItems.length, 3);
    assert.deepEqual(transaction.input.TransactItems.slice(0, 2).map(item => item.Update.Key), [
      { PK: "ORG#workspace_1", SK: "MEMBER#agent_1" },
      { PK: "USER#agent_1", SK: "ORG#workspace_1" }
    ]);
    assert.equal(transaction.input.TransactItems[2].Put.Item.action, "member.role_changed");
    assert.equal(transaction.input.TransactItems[2].Put.Item.targetUid, "agent_1");
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});


test("DynamoDB member audit history is tenant-scoped, newest-first and cursor-paginated", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return { Items: [{ id: "event_1", action: "member.removed", targetUid: "agent_1", createdAt: "2026-11-26T10:00:00.000Z" }], LastEvaluatedKey: { PK: "ORG#workspace_1", SK: "AUDIT#2026-11-26T10:00:00.000Z#event_1" } };
    }
  });
  try {
    const page = await members.listWorkspaceMemberAudit("workspace_1", { limit: 10 });
    assert.equal(page.events[0].action, "member.removed");
    assert.ok(page.nextCursor);
    assert.equal(captured.ScanIndexForward, false);
    assert.equal(captured.ExpressionAttributeValues[":skPrefix"], "AUDIT#");
    await assert.rejects(
      members.listWorkspaceMemberAudit("workspace_1", { cursor: Buffer.from(JSON.stringify({ PK: "ORG#other", SK: "AUDIT#bad" })).toString("base64url") }),
      { statusCode: 400 }
    );
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});
