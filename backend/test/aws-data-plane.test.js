"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dynamodb = require("../src/dynamodb");
const media = require("../src/s3Media");

test("DynamoDB key builders create workspace-scoped PK/SK values", () => {
  assert.deepEqual(dynamodb.workspaceKey("workspace_1"), { PK: "ORG#workspace_1", SK: "WORKSPACE" });
  assert.deepEqual(dynamodb.membershipKey("workspace_1", "user_1"), { PK: "ORG#workspace_1", SK: "MEMBER#user_1" });
  assert.deepEqual(dynamodb.customerKey("workspace_1", "customer_1"), { PK: "ORG#workspace_1", SK: "CUSTOMER#customer_1" });
  assert.deepEqual(dynamodb.messageKey("workspace_1", "conversation_1", 1760000000000, "message_1"), {
    PK: "ORG#workspace_1#CONVERSATION#conversation_1",
    SK: "MESSAGE#0001760000000000#message_1"
  });
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
