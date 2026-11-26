"use strict";

const crypto = require("crypto");
const dynamodb = require("./dynamodb");

function usageError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.retryable = statusCode >= 500;
  return error;
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function addUtcMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function usageWindow(workspace, now = new Date()) {
  const status = String(workspace.subscriptionStatus || "");
  if (!["active", "trialing"].includes(status)) {
    throw usageError("Workspace subscription is not active; inbound message usage cannot be recorded safely.", 503);
  }
  const billing = require("./billing");
  const plan = billing.getBillingPlanCatalog().find(item => item.key === workspace.plan);
  if (!plan || !Number.isSafeInteger(Number(plan.limits?.messages)) || Number(plan.limits.messages) < 1) {
    throw usageError("Workspace billing plan or message quota is not configured.", 503);
  }
  if (status === "trialing") {
    const start = parseDate(workspace.trialStart || workspace.currentPeriodStart);
    const end = parseDate(workspace.trialEnd);
    if (!start || !end || now < start || now >= end) {
      throw usageError("Workspace trial period cannot be verified.", 503);
    }
    return {
      key: "month_" + start.getTime(),
      start,
      end,
      limit: Math.ceil(Number(plan.limits.messages) * 0.25),
      plan: plan.key,
      trial: true
    };
  }
  const cycleStart = parseDate(workspace.currentPeriodStart);
  const cycleEnd = parseDate(workspace.currentPeriodEnd);
  if (!cycleStart || !cycleEnd || now < cycleStart || now >= cycleEnd || cycleEnd <= cycleStart) {
    throw usageError("Workspace billing period cannot be verified.", 503);
  }
  let monthIndex = 0;
  for (let month = 1; month < 12; month += 1) {
    const next = addUtcMonths(cycleStart, month);
    if (now < next || next >= cycleEnd) break;
    monthIndex = month;
  }
  const start = addUtcMonths(cycleStart, monthIndex);
  const candidateEnd = addUtcMonths(cycleStart, monthIndex + 1);
  return {
    key: "month_" + start.getTime(),
    start,
    end: candidateEnd < cycleEnd ? candidateEnd : cycleEnd,
    limit: Number(plan.limits.messages),
    plan: plan.key,
    trial: false
  };
}

async function recordInboundMessageUsage(organizationId, providerMessageId, now = new Date()) {
  dynamodb.workspaceKey(organizationId);
  if (typeof providerMessageId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(providerMessageId)) {
    throw usageError("A valid provider message ID is required for usage accounting.", 400);
  }
  const workspace = await dynamodb.getItem("workspaces", dynamodb.workspaceKey(organizationId), { consistentRead: true });
  if (!workspace || workspace.status !== "active") throw usageError("Workspace is not active.", 503);
  const window = usageWindow(workspace, now);
  const digest = crypto.createHash("sha256").update(providerMessageId).digest("hex");
  const markerKey = { PK: "ORG#" + organizationId, SK: "INBOUND_USAGE#" + digest };
  const usageKey = { PK: "ORG#" + organizationId, SK: "USAGE#" + window.key };
  const nowIso = now.toISOString();
  try {
    await dynamodb.transactWrite([
      {
        Put: {
          TableName: dynamodb.getTableName("customers"),
          Item: {
            ...markerKey,
            entityType: "INBOUND_USAGE_EVENT",
            organizationId,
            providerMessageId,
            periodKey: window.key,
            createdAt: nowIso
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
        }
      },
      {
        Update: {
          TableName: dynamodb.getTableName("customers"),
          Key: usageKey,
          UpdateExpression: "SET entityType = :type, organizationId = :org, periodKey = :period, plan = :plan, periodStart = :start, periodEnd = :end, messageLimit = :limit, trial = :trial, updatedAt = :updated ADD messagesUsed :one",
          ExpressionAttributeValues: {
            ":type": "BILLING_USAGE",
            ":org": organizationId,
            ":period": window.key,
            ":plan": window.plan,
            ":start": window.start.toISOString(),
            ":end": window.end.toISOString(),
            ":limit": window.limit,
            ":trial": window.trial,
            ":updated": nowIso,
            ":one": 1
          }
        }
      }
    ]);
    return { recorded: true, periodKey: window.key, limit: window.limit };
  } catch (error) {
    if (error?.name === "TransactionCanceledException" || error?.name === "ConditionalCheckFailedException") {
      const existing = await dynamodb.getItem("customers", markerKey, { consistentRead: true });
      if (existing) return { recorded: false, duplicate: true, periodKey: existing.periodKey };
    }
    throw error;
  }
}

async function getInboundUsage(organizationId, now = new Date()) {
  dynamodb.workspaceKey(organizationId);
  const workspace = await dynamodb.getItem("workspaces", dynamodb.workspaceKey(organizationId), { consistentRead: true });
  if (!workspace || workspace.status !== "active") throw usageError("Workspace is not active.", 404);
  const window = usageWindow(workspace, now);
  const usage = await dynamodb.getItem("customers", {
    PK: "ORG#" + organizationId,
    SK: "USAGE#" + window.key
  }, { consistentRead: true });
  const used = Math.max(0, Number(usage?.messagesUsed || 0));
  return {
    messagesUsed: used,
    messageLimit: window.limit,
    percent: Math.min(100, Math.floor(used / window.limit * 100)),
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    trial: window.trial
  };
}

module.exports = { usageWindow, recordInboundMessageUsage, getInboundUsage };
