"use strict";

const dynamodb = require("./dynamodb");
const tenancy = require("./tenancy");

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function validPhoneNumberId(value) { return typeof value === "string" && /^[0-9]{5,32}$/.test(value); }
function connectionKey(organizationId, phoneNumberId) {
  return { PK: "ORG#" + organizationId, SK: "WHATSAPP#PHONE#" + phoneNumberId };
}
function phoneOwnerKey(phoneNumberId) {
  return { PK: "PHONE#" + phoneNumberId, SK: "CONNECTION" };
}
function normalizeInput(input = {}) {
  const phoneNumberId = String(input.phoneNumberId || "").trim();
  const accessToken = String(input.accessToken || "").trim();
  const wabaId = String(input.wabaId || "").trim();
  const registrationPin = input.registrationPin === undefined ? "" : String(input.registrationPin);
  if (!validPhoneNumberId(phoneNumberId) || !/^[A-Za-z0-9._|=-]{8,4096}$/.test(accessToken) ||
      (wabaId && !/^[0-9]{5,32}$/.test(wabaId)) ||
      (registrationPin && !/^\d{6}$/.test(registrationPin))) {
    throw httpError("A valid WhatsApp Phone Number ID and access token are required.", 400);
  }
  return {
    phoneNumberId, wabaId, registrationPin,
    accessToken: tenancy.encryptSecret(accessToken),
    ...(registrationPin ? { encryptedRegistrationPin: tenancy.encryptSecret(registrationPin) } : {}),
    billingModel: input.billingModel === "joy_inbox_partner_credit_line" ? "joy_inbox_partner_credit_line" : "meta_direct",
    displayPhoneNumber: String(input.displayPhoneNumber || "").trim().slice(0, 40),
    verifiedName: String(input.verifiedName || "").trim().slice(0, 100)
  };
}

async function saveWhatsAppConnection(organizationId, input) {
  if (!validId(organizationId)) throw httpError("A valid organization ID is required.", 400);
  const value = normalizeInput(input);
  const now = new Date().toISOString();
  const credential = {
    ...connectionKey(organizationId, value.phoneNumberId),
    entityType: "WHATSAPP_CONNECTION", organizationId, phoneNumberId: value.phoneNumberId,
    accessToken: value.accessToken,
    ...(value.wabaId ? { wabaId: value.wabaId } : {}),
    ...(value.encryptedRegistrationPin ? { registrationPin: value.encryptedRegistrationPin } : {}),
    billingModel: value.billingModel, displayPhoneNumber: value.displayPhoneNumber,
    verifiedName: value.verifiedName, connected: true, updatedAt: now
  };
  const owner = {
    ...phoneOwnerKey(value.phoneNumberId), entityType: "WHATSAPP_PHONE_OWNER",
    organizationId, phoneNumberId: value.phoneNumberId, status: "active", updatedAt: now
  };
  await dynamodb.transactWrite([
    { Put: { TableName: dynamodb.getTableName("workspaces"), Item: credential } },
    { Put: {
      TableName: dynamodb.getTableName("workspaces"), Item: owner,
      ConditionExpression: "attribute_not_exists(PK) OR organizationId = :org OR #status = :disconnected",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":org": organizationId, ":disconnected": "disconnected" }
    } }
  ]);
  return { phoneNumberId: value.phoneNumberId, displayPhoneNumber: value.displayPhoneNumber, verifiedName: value.verifiedName, connected: true };
}

async function resolvePhoneNumberOrganization(phoneNumberId) {
  if (!validPhoneNumberId(phoneNumberId)) throw httpError("A valid WhatsApp Phone Number ID is required.", 400);
  const owner = await dynamodb.getItem("workspaces", phoneOwnerKey(phoneNumberId), { consistentRead: true });
  if (!owner || owner.status !== "active" || !validId(owner.organizationId)) {
    throw httpError("No active workspace owns this WhatsApp number.", 404);
  }
  const connection = await dynamodb.getItem("workspaces", connectionKey(owner.organizationId, phoneNumberId), { consistentRead: true });
  if (!connection || connection.connected !== true || connection.organizationId !== owner.organizationId) {
    throw httpError("The WhatsApp number ownership record is inconsistent.", 409);
  }
  return { id: owner.organizationId };
}

async function getWhatsAppCredentials(organizationId, phoneNumberId) {
  if (!validId(organizationId) || !validPhoneNumberId(phoneNumberId)) throw httpError("A valid organization and phone number ID are required.", 400);
  const [record, owner] = await Promise.all([
    dynamodb.getItem("workspaces", connectionKey(organizationId, phoneNumberId), { consistentRead: true }),
    dynamodb.getItem("workspaces", phoneOwnerKey(phoneNumberId), { consistentRead: true })
  ]);
  if (!record || record.connected !== true || !owner || owner.organizationId !== organizationId || owner.status !== "active") {
    throw httpError("WhatsApp is not connected for this organization.", 404);
  }
  return {
    phoneNumberId: record.phoneNumberId,
    accessToken: tenancy.decryptSecret(record.accessToken),
    ...(record.wabaId ? { wabaId: record.wabaId } : {}),
    ...(record.registrationPin ? { registrationPin: tenancy.decryptSecret(record.registrationPin) } : {}),
    displayPhoneNumber: record.displayPhoneNumber || "",
    verifiedName: record.verifiedName || ""
  };
}

async function disconnectWhatsAppConnection(organizationId, phoneNumberId) {
  if (!validId(organizationId) || !validPhoneNumberId(phoneNumberId)) throw httpError("A valid organization and phone number ID are required.", 400);
  const now = new Date().toISOString();
  await dynamodb.transactWrite([
    { Update: {
      TableName: dynamodb.getTableName("workspaces"), Key: connectionKey(organizationId, phoneNumberId),
      UpdateExpression: "SET connected = :false, disconnectedAt = :now, updatedAt = :now",
      ConditionExpression: "organizationId = :org AND connected = :true",
      ExpressionAttributeValues: { ":false": false, ":true": true, ":org": organizationId, ":now": now }
    } },
    { Update: {
      TableName: dynamodb.getTableName("workspaces"), Key: phoneOwnerKey(phoneNumberId),
      UpdateExpression: "SET #status = :disconnected, updatedAt = :now",
      ConditionExpression: "organizationId = :org AND #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":disconnected": "disconnected", ":active": "active", ":org": organizationId, ":now": now }
    } }
  ]);
  return { phoneNumberId, connected: false };
}

async function listWhatsAppConnections(organizationId) {
  if (!validId(organizationId)) throw httpError("A valid organization ID is required.", 400);
  const page = await dynamodb.queryPartition("workspaces", organizationId, "ORG#" + organizationId, {
    limit: 100, sortKeyBeginsWith: "WHATSAPP#PHONE#"
  });
  return page.items.map(item => ({
    phoneNumberId: item.phoneNumberId,
    ...(item.wabaId ? { wabaId: item.wabaId } : {}),
    billingModel: item.billingModel || "meta_direct",
    displayPhoneNumber: item.displayPhoneNumber || "",
    verifiedName: item.verifiedName || "",
    connected: item.connected === true,
    updatedAt: item.updatedAt || null
  }));
}

module.exports = { connectionKey, phoneOwnerKey, saveWhatsAppConnection, resolvePhoneNumberOrganization, getWhatsAppCredentials, disconnectWhatsAppConnection, listWhatsAppConnections };
