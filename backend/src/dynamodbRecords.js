"use strict";

const dynamodb = require("./dynamodb");

function requireWorkspaceId(value) {
  // Validate IDs before constructing any tenant partition or key.
  dynamodb.workspaceKey(value);
  return value;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    const error = new Error("A valid epoch-millisecond timestamp is required.");
    error.statusCode = 400;
    throw error;
  }
  return timestamp;
}

async function saveCustomer(organizationId, customerId, attributes) {
  const orgId = requireWorkspaceId(organizationId);
  const key = dynamodb.customerKey(orgId, customerId);
  const now = new Date().toISOString();
  const item = {
    ...key,
    entityType: "CUSTOMER",
    organizationId: orgId,
    customerId,
    ...(attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes : {}),
    updatedAt: now
  };
  // Keep tenant and key attributes controlled by the repository, not user input.
  Object.assign(item, key, { entityType: "CUSTOMER", organizationId: orgId, customerId, updatedAt: now });
  await dynamodb.putItem("customers", item);
  return item;
}

async function getCustomer(organizationId, customerId) {
  const orgId = requireWorkspaceId(organizationId);
  return dynamodb.getItem("customers", dynamodb.customerKey(orgId, customerId));
}

async function listCustomers(organizationId, options = {}) {
  const orgId = requireWorkspaceId(organizationId);
  return dynamodb.queryPartition("customers", orgId, "ORG#" + orgId, {
    ...options,
    sortKeyBeginsWith: "CUSTOMER#"
  });
}

async function saveConversationSummary(organizationId, conversationId, attributes) {
  const orgId = requireWorkspaceId(organizationId);
  const key = dynamodb.conversationSummaryKey(orgId, conversationId);
  const now = new Date().toISOString();
  const item = {
    ...key,
    entityType: "CONVERSATION",
    organizationId: orgId,
    conversationId,
    ...(attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes : {}),
    updatedAt: now
  };
  Object.assign(item, key, {
    entityType: "CONVERSATION",
    organizationId: orgId,
    conversationId,
    updatedAt: now
  });
  await dynamodb.putItem("customers", item);
  return item;
}

async function listConversationSummaries(organizationId, options = {}) {
  const orgId = requireWorkspaceId(organizationId);
  return dynamodb.queryPartition("customers", orgId, "ORG#" + orgId, {
    ...options,
    sortKeyBeginsWith: "CONVERSATION#"
  });
}

async function saveMessage(organizationId, conversationId, message, options = {}) {
  const orgId = requireWorkspaceId(organizationId);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    const error = new Error("A message record is required.");
    error.statusCode = 400;
    throw error;
  }
  const timestamp = normalizeTimestamp(message.timestamp);
  const messageId = message.messageId || message.id;
  const key = dynamodb.messageKey(orgId, conversationId, timestamp, messageId);
  const item = {
    ...key,
    entityType: "MESSAGE",
    organizationId: orgId,
    conversationId,
    messageId,
    timestamp,
    ...message
  };
  Object.assign(item, key, {
    entityType: "MESSAGE",
    organizationId: orgId,
    conversationId,
    messageId,
    timestamp
  });
  await dynamodb.putItem("messages", item, { ifAbsent: options.idempotent !== false });
  return item;
}

async function listMessages(organizationId, conversationId, options = {}) {
  const orgId = requireWorkspaceId(organizationId);
  return dynamodb.queryPartition("messages", orgId,
    dynamodb.conversationPartition(orgId, conversationId), {
      ...options,
      scanIndexForward: options.scanIndexForward === undefined ? true : options.scanIndexForward,
      sortKeyBeginsWith: "MESSAGE#"
    });
}

module.exports = {
  saveCustomer,
  getCustomer,
  listCustomers,
  saveConversationSummary,
  listConversationSummaries,
  saveMessage,
  listMessages
};
