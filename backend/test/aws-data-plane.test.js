"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dynamodb = require("../src/dynamodb");
const media = require("../src/s3Media");
const workspaces = require("../src/dynamodbWorkspaces");

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
