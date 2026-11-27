"use strict";

const crypto = require("crypto");
const { getUsageWindow, usageError } = require("../tenantUsage");

const ID = /^[A-Za-z0-9_-]{1,128}$/;
function digest(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function dateIso(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

/**
 * Atomic hard-block message quota ledger. Reservation and usage counter updates
 * are committed in one DynamoDB transaction so concurrent sends cannot exceed
 * the tenant's verified plan allowance.
 */
function createDynamoUsageStore({ documentClient, commands, tableName, subscriptions, plans, now = () => new Date() }) {
  if (!documentClient || typeof documentClient.send !== "function") throw new Error("A DynamoDB DocumentClient is required.");
  if (!commands?.GetCommand || !commands?.TransactWriteCommand) throw new Error("DynamoDB Get and TransactWrite command constructors are required.");
  if (!subscriptions || typeof subscriptions.getSubscription !== "function") throw new Error("A verified DynamoDB subscription store is required.");
  if (typeof tableName !== "string" || !tableName.trim()) throw new Error("A DynamoDB usage table is required.");

  async function getWindow(organizationId, at = now()) {
    if (!ID.test(String(organizationId || ""))) throw usageError("A valid workspace is required for quota enforcement.", 400);
    const subscription = await subscriptions.getSubscription(organizationId);
    if (!subscription) throw usageError("Start the workspace free trial or choose a plan before sending messages.", 402, "SUBSCRIPTION_REQUIRED");
    return getUsageWindow(subscription, at, plans);
  }

  async function reserveOutboundMessage(organizationId, clientMessageId, at = now()) {
    if (!ID.test(String(clientMessageId || ""))) throw usageError("A valid client message ID is required for safe quota reservation.", 400);
    const window = await getWindow(organizationId, at);
    const pk = `ORG#${organizationId}`;
    const usageKey = { PK: pk, SK: `USAGE#${window.key}` };
    const reservationKey = { PK: pk, SK: `USAGE_RESERVATION#${digest(clientMessageId)}` };
    const existing = await documentClient.send(new commands.GetCommand({ TableName: tableName, Key: reservationKey, ConsistentRead: true }));
    if (existing.Item && ["reserved", "committed"].includes(existing.Item.state)) {
      return { enforced: true, duplicate: true, organizationId, periodKey: window.key, clientMessageId: String(clientMessageId), limit: window.limit };
    }
    try {
      await documentClient.send(new commands.TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: tableName, Key: usageKey,
          UpdateExpression: "SET #entity = :entity, plan = :plan, periodStart = :start, periodEnd = :end, messageLimit = :limit, updatedAt = :now, messagesUsed = if_not_exists(messagesUsed, :zero), messagesReserved = if_not_exists(messagesReserved, :zero) ADD messagesReserved :one, messagesCount :one",
          ConditionExpression: "attribute_not_exists(messagesCount) OR messagesCount < :limit",
          ExpressionAttributeNames: { "#entity": "entityType" },
          ExpressionAttributeValues: {
            ":entity": "BILLING_USAGE", ":plan": window.plan.key, ":start": dateIso(window.start),
            ":end": dateIso(window.end), ":limit": window.limit, ":now": at.toISOString(), ":one": 1, ":zero": 0
          }
        } },
        { Put: {
          TableName: tableName,
          Item: { ...reservationKey, entityType: "USAGE_RESERVATION", organizationId, clientMessageId: String(clientMessageId), periodKey: window.key, state: "reserved", createdAt: at.toISOString(), updatedAt: at.toISOString() },
          ConditionExpression: "attribute_not_exists(PK)"
        } }
      ] }));
      return { enforced: true, duplicate: false, organizationId, periodKey: window.key, clientMessageId: String(clientMessageId), limit: window.limit };
    } catch (error) {
      if (error?.name === "TransactionCanceledException" || error?.name === "ConditionalCheckFailedException") {
        const latest = await documentClient.send(new commands.GetCommand({ TableName: tableName, Key: reservationKey, ConsistentRead: true }));
        if (latest.Item && ["reserved", "committed"].includes(latest.Item.state)) {
          return { enforced: true, duplicate: true, organizationId, periodKey: window.key, clientMessageId: String(clientMessageId), limit: window.limit };
        }
        throw usageError(`Message limit reached (${window.limit.toLocaleString("en-IN")} messages for this service month). Upgrade your plan to continue sending.`);
      }
      throw error;
    }
  }

  async function finishOutboundReservation(reservation, outcome, at = now()) {
    if (!reservation?.enforced || reservation.duplicate || !ID.test(String(reservation.organizationId || "")) ||
        !ID.test(String(reservation.clientMessageId || "")) || !["sent", "failed"].includes(outcome)) return false;
    const pk = `ORG#${reservation.organizationId}`;
    const reservationKey = { PK: pk, SK: `USAGE_RESERVATION#${digest(reservation.clientMessageId)}` };
    const usageKey = { PK: pk, SK: `USAGE#${reservation.periodKey}` };
    try {
      await documentClient.send(new commands.TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: tableName, Key: usageKey,
          UpdateExpression: outcome === "sent"
            ? "SET updatedAt = :now ADD messagesReserved :minus, messagesUsed :one"
            : "SET updatedAt = :now ADD messagesReserved :minus, messagesCount :minus",
          ConditionExpression: "messagesReserved >= :one",
          ExpressionAttributeValues: { ":minus": -1, ":one": 1, ":now": at.toISOString() }
        } },
        { Update: {
          TableName: tableName, Key: reservationKey,
          UpdateExpression: "SET #state = :state, finishedAt = :now, updatedAt = :now",
          ConditionExpression: "#state = :reserved",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":state": outcome === "sent" ? "committed" : "released", ":reserved": "reserved", ":now": at.toISOString() }
        } }
      ] }));
      return true;
    } catch (error) {
      if (error?.name === "TransactionCanceledException" || error?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async function recordInboundMessageUsage(organizationId, providerMessageId, at = now()) {
    if (!ID.test(String(organizationId || "")) || !providerMessageId) return false;
    const window = await getWindow(organizationId, at);
    const pk = `ORG#${organizationId}`;
    const markerKey = { PK: pk, SK: `INBOUND_USAGE#${digest(providerMessageId)}` };
    try {
      await documentClient.send(new commands.TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: tableName, Key: { PK: pk, SK: `USAGE#${window.key}` },
          UpdateExpression: "SET #entity = :entity, plan = :plan, periodStart = :start, periodEnd = :end, messageLimit = :limit, updatedAt = :now ADD messagesUsed :one, messagesCount :one",
          ExpressionAttributeNames: { "#entity": "entityType" },
          ExpressionAttributeValues: { ":entity": "BILLING_USAGE", ":plan": window.plan.key, ":start": dateIso(window.start), ":end": dateIso(window.end), ":limit": window.limit, ":now": at.toISOString(), ":one": 1 }
        } },
        { Put: {
          TableName: tableName,
          Item: { ...markerKey, entityType: "INBOUND_USAGE_EVENT", organizationId, providerMessageId: String(providerMessageId).slice(0, 256), periodKey: window.key, createdAt: at.toISOString() },
          ConditionExpression: "attribute_not_exists(PK)"
        } }
      ] }));
      return true;
    } catch (error) {
      if (error?.name === "TransactionCanceledException" || error?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async function getUsage(organizationId, at = now()) {
    const window = await getWindow(organizationId, at);
    const result = await documentClient.send(new commands.GetCommand({
      TableName: tableName, Key: { PK: `ORG#${organizationId}`, SK: `USAGE#${window.key}` }, ConsistentRead: true
    }));
    const item = result.Item || {};
    const used = Math.max(0, Number(item.messagesUsed || 0));
    const reserved = Math.max(0, Number(item.messagesReserved || 0));
    const counted = Math.max(0, Number(item.messagesCount ?? (used + reserved)));
    const percent = Math.min(100, Math.floor(counted / window.limit * 100));
    return {
      messagesUsed: used, messagesReserved: reserved, messageLimit: window.limit, percent,
      thresholdsReached: [80, 95, 100].filter(value => percent >= value),
      periodStart: window.start.toISOString(), periodEnd: window.end.toISOString(), trial: window.trial
    };
  }

  return Object.freeze({ reserveOutboundMessage, finishOutboundReservation, recordInboundMessageUsage, getUsage });
}

module.exports = { createDynamoUsageStore };
