"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand
} = require("@aws-sdk/lib-dynamodb");

const TABLE_ENV = Object.freeze({
  workspaces: "DYNAMODB_WORKSPACES_TABLE",
  customers: "DYNAMODB_CUSTOMERS_TABLE",
  messages: "DYNAMODB_MESSAGES_TABLE"
});

let documentClient;

function getDocumentClient() {
  if (documentClient) return documentClient;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS_REGION must be configured for DynamoDB.");
  const client = new DynamoDBClient({ region });
  documentClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true }
  });
  return documentClient;
}

function setDocumentClientForTests(client) {
  documentClient = client || undefined;
}

function getTableName(kind) {
  const variable = TABLE_ENV[kind];
  if (!variable) throw new Error("Unknown DynamoDB table kind.");
  const name = process.env[variable];
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(variable + " must be configured.");
  }
  return name.trim();
}

function validateId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    const error = new Error("A valid " + label + " is required.");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function workspaceKey(organizationId) {
  const id = validateId(organizationId, "organization ID");
  return { PK: "ORG#" + id, SK: "WORKSPACE" };
}

function userWorkspacePartition(uid) {
  const userId = validateId(uid, "user ID");
  return "USER#" + userId;
}

function userWorkspacePointerKey(uid, organizationId) {
  return { PK: userWorkspacePartition(uid), SK: "ORG#" + validateId(organizationId, "organization ID") };
}

function membershipKey(organizationId, uid) {
  const orgId = validateId(organizationId, "organization ID");
  const userId = validateId(uid, "user ID");
  return { PK: "ORG#" + orgId, SK: "MEMBER#" + userId };
}

function customerKey(organizationId, customerId) {
  const orgId = validateId(organizationId, "organization ID");
  const id = validateId(customerId, "customer ID");
  return { PK: "ORG#" + orgId, SK: "CUSTOMER#" + id };
}

function conversationSummaryKey(organizationId, conversationId) {
  const orgId = validateId(organizationId, "organization ID");
  const id = validateId(conversationId, "conversation ID");
  return { PK: "ORG#" + orgId, SK: "CONVERSATION#" + id };
}

function conversationPartition(organizationId, conversationId) {
  const orgId = validateId(organizationId, "organization ID");
  const id = validateId(conversationId, "conversation ID");
  return "ORG#" + orgId + "#CONVERSATION#" + id;
}

function messageKey(organizationId, conversationId, timestamp, messageId) {
  if (!Number.isFinite(Number(timestamp))) {
    const error = new Error("A valid message timestamp is required.");
    error.statusCode = 400;
    throw error;
  }
  if (typeof messageId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId)) {
    const error = new Error("A valid message ID is required.");
    error.statusCode = 400;
    throw error;
  }
  const id = messageId;
  return {
    PK: conversationPartition(organizationId, conversationId),
    SK: "MESSAGE#" + String(Math.trunc(Number(timestamp))).padStart(16, "0") + "#" + id
  };
}

function assertTenantPartition(organizationId, partitionKey) {
  const orgId = validateId(organizationId, "organization ID");
  if (typeof partitionKey !== "string" ||
      !(partitionKey === "ORG#" + orgId || partitionKey.startsWith("ORG#" + orgId + "#"))) {
    const error = new Error("DynamoDB access must stay within the authenticated workspace.");
    error.statusCode = 403;
    throw error;
  }
}

async function getItem(kind, key, options = {}) {
  if (!key || typeof key.PK !== "string" || typeof key.SK !== "string") {
    throw new Error("DynamoDB items require PK and SK string keys.");
  }
  const result = await getDocumentClient().send(new GetCommand({
    TableName: getTableName(kind),
    Key: key,
    ConsistentRead: options.consistentRead === true
  }));
  return result.Item || null;
}

async function putItem(kind, item, options = {}) {
  if (!item || typeof item.PK !== "string" || typeof item.SK !== "string") {
    throw new Error("DynamoDB items require PK and SK string keys.");
  }
  await getDocumentClient().send(new PutCommand({
    TableName: getTableName(kind),
    Item: item,
    ...(options.ifAbsent ? { ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } : {})
  }));
  return item;
}

async function updateItem(kind, key, updateExpression, expressionValues, expressionNames = {}, options = {}) {
  if (!key || typeof key.PK !== "string" || typeof key.SK !== "string") {
    throw new Error("DynamoDB updates require PK and SK string keys.");
  }
  if (typeof updateExpression !== "string" || !/^SET\s/.test(updateExpression)) {
    throw new Error("Only explicit SET update expressions are supported.");
  }
  const result = await getDocumentClient().send(new UpdateCommand({
    TableName: getTableName(kind),
    Key: key,
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionValues || {},
    ...(Object.keys(expressionNames).length ? { ExpressionAttributeNames: expressionNames } : {}),
    ...(options.conditionExpression ? { ConditionExpression: options.conditionExpression } : {}),
    ReturnValues: "ALL_NEW"
  }));
  return result.Attributes || null;
}

async function deleteItem(kind, key, options = {}) {
  if (!key || typeof key.PK !== "string" || typeof key.SK !== "string") {
    throw new Error("DynamoDB deletes require PK and SK string keys.");
  }
  await getDocumentClient().send(new DeleteCommand({
    TableName: getTableName(kind),
    Key: key,
    ...(options.conditionExpression ? { ConditionExpression: options.conditionExpression } : {})
  }));
}

async function queryPartition(kind, organizationId, partitionKey, options = {}) {
  assertTenantPartition(organizationId, partitionKey);
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error("DynamoDB query limit must be between 1 and 100.");
    error.statusCode = 400;
    throw error;
  }
  const result = await getDocumentClient().send(new QueryCommand({
    TableName: getTableName(kind),
    KeyConditionExpression: options.sortKeyBeginsWith ? "PK = :pk AND begins_with(SK, :skPrefix)" : "PK = :pk",
    ExpressionAttributeValues: options.sortKeyBeginsWith ? { ":pk": partitionKey, ":skPrefix": options.sortKeyBeginsWith } : { ":pk": partitionKey },
    Limit: limit,
    ...(options.exclusiveStartKey ? { ExclusiveStartKey: options.exclusiveStartKey } : {}),
    ...(options.scanIndexForward === undefined ? {} : { ScanIndexForward: options.scanIndexForward })
  }));
  return {
    items: result.Items || [],
    lastEvaluatedKey: result.LastEvaluatedKey || null
  };
}

async function listUserWorkspacePointers(uid, options = {}) {
  const userPartition = userWorkspacePartition(uid);
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error("DynamoDB query limit must be between 1 and 100.");
    error.statusCode = 400;
    throw error;
  }
  const result = await getDocumentClient().send(new QueryCommand({
    TableName: getTableName("workspaces"),
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
    ExpressionAttributeValues: { ":pk": userPartition, ":skPrefix": "ORG#" },
    Limit: limit,
    ...(options.exclusiveStartKey ? { ExclusiveStartKey: options.exclusiveStartKey } : {})
  }));
  return { items: result.Items || [], lastEvaluatedKey: result.LastEvaluatedKey || null };
}

async function transactWrite(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new Error("DynamoDB transaction must contain 1–100 operations.");
  }
  return getDocumentClient().send(new TransactWriteCommand({ TransactItems: items }));
}

module.exports = {
  TABLE_ENV,
  getDocumentClient,
  setDocumentClientForTests,
  getTableName,
  workspaceKey,
  membershipKey,
  userWorkspacePartition,
  userWorkspacePointerKey,
  customerKey,
  conversationSummaryKey,
  conversationPartition,
  messageKey,
  assertTenantPartition,
  getItem,
  putItem,
  updateItem,
  deleteItem,
  queryPartition,
  listUserWorkspacePointers,
  transactWrite
};
