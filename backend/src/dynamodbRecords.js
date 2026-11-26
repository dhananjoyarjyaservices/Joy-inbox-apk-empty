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


async function saveIncomingWhatsAppMessage(organizationId, message) {
  const orgId = requireWorkspaceId(organizationId);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    const error = new Error("An incoming WhatsApp message is required.");
    error.statusCode = 400;
    throw error;
  }
  const conversationId = String(message.conversationId || message.from || "");
  const customerId = String(message.customerId || conversationId);
  const messageId = String(message.messageId || message.id || "");
  const timestamp = normalizeTimestamp(message.timestamp);
  const customerKey = dynamodb.customerKey(orgId, customerId);
  const conversationKey = dynamodb.conversationSummaryKey(orgId, conversationId);
  const itemKey = dynamodb.messageKey(orgId, conversationId, timestamp, messageId);
  const messagePointerKey = {
    PK: "ORG#" + orgId,
    SK: "WHATSAPP_MESSAGE#" + messageId
  };
  const now = new Date().toISOString();
  const text = typeof message.text === "string" ? message.text.slice(0, 4096) : "";
  const customer = {
    ...customerKey, entityType: "CUSTOMER", organizationId: orgId, customerId,
    phone: customerId, name: String(message.customerName || customerId).slice(0, 100),
    updatedAt: now
  };
  const summary = {
    ...conversationKey, entityType: "CONVERSATION", organizationId: orgId, conversationId,
    customerId, customerPhone: customerId,
    customerName: String(message.customerName || customerId).slice(0, 100),
    lastMessage: text || (String(message.type || "unknown") + " message"),
    lastMessageAt: timestamp, lastMessageDirection: "incoming",
    phoneNumberId: String(message.phoneNumberId || "").slice(0, 32),
    updatedAt: now
  };
  const record = {
    ...itemKey, entityType: "MESSAGE", organizationId: orgId, conversationId, messageId,
    timestamp, direction: "incoming", type: String(message.type || "unknown").slice(0, 40),
    text, status: "received", source: "whatsapp",
    ...(message.mediaId ? { mediaId: String(message.mediaId).slice(0, 256) } : {}),
    ...(message.mediaMimeType ? { mediaMimeType: String(message.mediaMimeType).slice(0, 128) } : {}),
    ...(message.mediaFilename ? { mediaFilename: String(message.mediaFilename).slice(0, 180) } : {}),
    ...(message.mediaSize ? { mediaSize: Number(message.mediaSize) } : {}),
    phoneNumberId: String(message.phoneNumberId || "").slice(0, 32),
    createdAt: now
  };
  try {
    await dynamodb.transactWrite([
      {
        Update: {
          TableName: dynamodb.getTableName("customers"),
          Key: customerKey,
          UpdateExpression: "SET entityType = :entityType, organizationId = :organizationId, customerId = :customerId, phone = :phone, #name = :name, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: {
            ":entityType": customer.entityType, ":organizationId": orgId,
            ":customerId": customerId, ":phone": customer.phone,
            ":name": customer.name, ":updatedAt": now
          }
        }
      },
      {
        Update: {
          TableName: dynamodb.getTableName("customers"),
          Key: conversationKey,
          UpdateExpression: "SET entityType = :entityType, organizationId = :organizationId, conversationId = :conversationId, customerId = :customerId, customerPhone = :customerPhone, customerName = :customerName, lastMessage = :lastMessage, lastMessageAt = :lastMessageAt, lastMessageDirection = :direction, phoneNumberId = :phoneNumberId, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":entityType": summary.entityType, ":organizationId": orgId,
            ":conversationId": conversationId, ":customerId": customerId,
            ":customerPhone": summary.customerPhone, ":customerName": summary.customerName,
            ":lastMessage": summary.lastMessage, ":lastMessageAt": timestamp,
            ":direction": "incoming", ":phoneNumberId": summary.phoneNumberId,
            ":updatedAt": now
          }
        }
      },
      { Put: {
        TableName: dynamodb.getTableName("messages"), Item: record,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
      } },
      { Put: {
        TableName: dynamodb.getTableName("customers"),
        Item: {
          ...messagePointerKey,
          entityType: "WHATSAPP_MESSAGE_POINTER",
          organizationId: orgId,
          conversationId,
          messageId,
          timestamp,
          updatedAt: now
        },
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
      } }
    ]);
    return true;
  } catch (error) {
    if (error?.name === "TransactionCanceledException" || error?.name === "ConditionalCheckFailedException") {
      const existing = await dynamodb.getItem("messages", itemKey, { consistentRead: true });
      if (existing) return false;
    }
    throw error;
  }
}

module.exports = {
  saveCustomer,
  getCustomer,
  listCustomers,
  saveConversationSummary,
  listConversationSummaries,
  saveMessage,
  saveIncomingWhatsAppMessage,
  listMessages
};
