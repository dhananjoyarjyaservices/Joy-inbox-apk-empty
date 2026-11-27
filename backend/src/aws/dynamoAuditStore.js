"use strict";

const { randomUUID } = require("node:crypto");
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Tenant-scoped audit events stored in JoyInboxMessages.
 * Audit rows share the organization partition but use an AUDIT# sort-key
 * prefix, so they can be queried without a GSI or table scan.
 */
function createDynamoAuditStore({ documentClient, commands, tableName, idFactory = randomUUID }) {
  if (!documentClient || typeof documentClient.send !== "function") throw new Error("A DynamoDB DocumentClient is required.");
  if (!commands?.PutCommand || !commands?.QueryCommand) throw new Error("DynamoDB Put and Query command constructors are required.");
  if (typeof tableName !== "string" || !tableName.trim()) throw new Error("A DynamoDB audit table is required.");
  if (typeof idFactory !== "function") throw new Error("An audit event ID factory is required.");

  async function record(event) {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        typeof event.organizationId !== "string" || !ID_PATTERN.test(event.organizationId) ||
        typeof event.actorUid !== "string" || !ID_PATTERN.test(event.actorUid) ||
        typeof event.actorRole !== "string" || !["owner", "admin", "agent"].includes(event.actorRole) ||
        typeof event.action !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(event.action) ||
        typeof event.targetUid !== "string" || !ID_PATTERN.test(event.targetUid)) {
      throw httpError("A valid organization audit event is required.", 400);
    }
    const createdAt = event.createdAt || new Date().toISOString();
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw httpError("A valid audit timestamp is required.", 400);
    const details = event.details === undefined ? {} : event.details;
    if (!details || typeof details !== "object" || Array.isArray(details) || Buffer.byteLength(JSON.stringify(details), "utf8") > 8192) {
      throw httpError("Audit details must be an object no larger than 8 KB.", 400);
    }
    const eventId = idFactory();
    if (typeof eventId !== "string" || !ID_PATTERN.test(eventId)) throw new Error("Audit event ID factory returned an invalid ID.");
    const item = {
      PK: `ORG#${event.organizationId}`,
      SK: `AUDIT#${createdAt}#${eventId}`,
      entityType: "AUDIT_EVENT",
      organizationId: event.organizationId,
      eventId,
      actorUid: event.actorUid,
      actorRole: event.actorRole,
      action: event.action,
      targetUid: event.targetUid,
      details,
      createdAt
    };
    await documentClient.send(new commands.PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    }));
    return item;
  }

  async function list(organizationId, { limit = 50, exclusiveStartKey, scanIndexForward = false } = {}) {
    if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) throw httpError("A valid organization ID is required.", 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw httpError("Page limit must be between 1 and 100.", 400);
    const input = {
      TableName: tableName,
      KeyConditionExpression: "PK = :organization AND begins_with(SK, :audit)",
      ExpressionAttributeValues: { ":organization": `ORG#${organizationId}`, ":audit": "AUDIT#" },
      Limit: limit,
      ScanIndexForward: scanIndexForward === true
    };
    if (exclusiveStartKey !== undefined) {
      if (!exclusiveStartKey || exclusiveStartKey.PK !== `ORG#${organizationId}` ||
          typeof exclusiveStartKey.SK !== "string" || !exclusiveStartKey.SK.startsWith("AUDIT#")) {
        throw httpError("Pagination cursor does not belong to this organization audit log.", 400);
      }
      input.ExclusiveStartKey = exclusiveStartKey;
    }
    const result = await documentClient.send(new commands.QueryCommand(input));
    return { items: result.Items || [], lastEvaluatedKey: result.LastEvaluatedKey || null };
  }

  return Object.freeze({ record, list });
}

module.exports = { createDynamoAuditStore };
