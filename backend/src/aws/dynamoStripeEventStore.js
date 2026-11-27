"use strict";

const { randomUUID } = require("node:crypto");
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9]{8,180}$/;
const LEASE_MS = 2 * 60 * 1000;

function eventStoreError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isConditionalFailure(error) {
  return error?.name === "ConditionalCheckFailedException" || error?.code === "ConditionalCheckFailedException";
}

/**
 * Global Stripe event idempotency ledger. Stripe event IDs are globally
 * unique; the ledger is deliberately not tenant-partitioned so retries that
 * arrive before organization resolution are still deduplicated.
 */
function createDynamoStripeEventStore({ documentClient, commands, tableName, now = () => new Date(), tokenFactory = randomUUID }) {
  if (!documentClient || typeof documentClient.send !== "function") throw new Error("A DynamoDB DocumentClient is required.");
  if (!commands?.GetCommand || !commands?.UpdateCommand) throw new Error("DynamoDB Get and Update command constructors are required.");
  if (typeof tableName !== "string" || !tableName.trim()) throw new Error("A DynamoDB event table is required.");

  function key(eventId) {
    if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) throw eventStoreError("Invalid Stripe event ID.");
    return { PK: `STRIPE_EVENT#${eventId}`, SK: "META" };
  }

  async function get(eventId) {
    const result = await documentClient.send(new commands.GetCommand({
      TableName: tableName, Key: key(eventId), ConsistentRead: true
    }));
    return result.Item || null;
  }

  async function claim(eventId) {
    const Key = key(eventId);
    const current = now();
    const leaseToken = tokenFactory();
    const leaseUntil = new Date(current.getTime() + LEASE_MS).toISOString();
    try {
      await documentClient.send(new commands.UpdateCommand({
        TableName: tableName,
        Key,
        UpdateExpression: "SET #status = :processing, leaseUntil = :leaseUntil, leaseToken = :leaseToken, updatedAt = :now ADD attempts :one",
        ConditionExpression: "attribute_not_exists(#status) OR (#status <> :processed AND (#status <> :processing OR leaseUntil <= :now))",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":processing": "processing", ":processed": "processed",
          ":leaseUntil": leaseUntil, ":leaseToken": leaseToken,
          ":now": current.toISOString(), ":one": 1
        }
      }));
      return { claimed: true, eventId, leaseToken, leaseUntil };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const item = await get(eventId);
      return {
        claimed: false,
        duplicate: item?.status === "processed",
        inProgress: item?.status === "processing" && new Date(item.leaseUntil || 0) > current,
        eventId
      };
    }
  }

  async function finish(eventId, leaseToken, { status, eventType, error } = {}) {
    key(eventId);
    if (typeof leaseToken !== "string" || !leaseToken) throw eventStoreError("A Stripe event lease token is required.", 409);
    if (!["processed", "failed"].includes(status)) throw eventStoreError("A valid Stripe event result status is required.");
    const current = now().toISOString();
    const values = {
      ":status": status, ":processing": "processing",
      ":leaseToken": leaseToken, ":now": current
    };
    let update = "SET #status = :status, updatedAt = :now REMOVE leaseUntil, leaseToken";
    if (status === "processed") {
      values[":eventType"] = String(eventType || "unknown").slice(0, 160);
      update = "SET #status = :status, eventType = :eventType, processedAt = :now, updatedAt = :now REMOVE leaseUntil, leaseToken, lastError";
    } else {
      values[":lastError"] = String(error?.message || error || "Stripe event processing failed.").slice(0, 300);
      update = "SET #status = :status, lastError = :lastError, updatedAt = :now REMOVE leaseUntil, leaseToken";
    }
    try {
      await documentClient.send(new commands.UpdateCommand({
        TableName: tableName, Key: key(eventId), UpdateExpression: update,
        ConditionExpression: "#status = :processing AND leaseToken = :leaseToken",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: values
      }));
      return { eventId, status };
    } catch (error) {
      if (isConditionalFailure(error)) throw eventStoreError("Stripe event lease expired or is no longer owned by this worker.", 409);
      throw error;
    }
  }

  return Object.freeze({ get, claim, finish });
}

module.exports = { LEASE_MS, createDynamoStripeEventStore };
