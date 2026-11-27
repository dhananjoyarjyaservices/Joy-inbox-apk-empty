"use strict";

const { getBillingPlanCatalog } = require("../billing");
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

function billingStoreError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Stores only server-verified subscription snapshots. The caller must invoke
 * putVerifiedSubscription only after validating the Stripe webhook signature
 * and retrieving/validating the subscription with Stripe.
 */
function createDynamoSubscriptionStore({ documentClient, commands, tableName, plans = getBillingPlanCatalog() }) {
  if (!documentClient || typeof documentClient.send !== "function") throw new Error("A DynamoDB DocumentClient is required.");
  if (!commands?.GetCommand || !commands?.PutCommand) throw new Error("DynamoDB Get and Put command constructors are required.");
  if (typeof tableName !== "string" || !tableName.trim()) throw new Error("A DynamoDB subscription table is required.");
  if (!Array.isArray(plans) || !plans.length) throw new Error("A trusted billing plan catalog is required.");

  async function putVerifiedSubscription(organizationId, subscription, { verified = false } = {}) {
    if (verified !== true) throw billingStoreError("Subscription state must come from a verified billing webhook.", 403);
    if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) throw billingStoreError("A valid organization ID is required.");
    if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) throw billingStoreError("A verified subscription is required.");
    const plan = plans.find(item => item.key === subscription.plan);
    if (!plan) throw billingStoreError("The verified subscription has an unknown plan.", 400);
    if (!ACTIVE_STATUSES.has(subscription.status)) throw billingStoreError("Only active or trialing subscriptions can grant seats.", 400);
    if (typeof subscription.stripeSubscriptionId !== "string" || !/^sub_[A-Za-z0-9_]+$/.test(subscription.stripeSubscriptionId)) {
      throw billingStoreError("A valid Stripe subscription ID is required.");
    }
    if (typeof subscription.stripeCustomerId !== "string" || !/^cus_[A-Za-z0-9_]+$/.test(subscription.stripeCustomerId)) {
      throw billingStoreError("A valid Stripe customer ID is required.");
    }
    const start = new Date(subscription.status === "trialing" ? (subscription.trialStart || subscription.currentPeriodStart) : subscription.currentPeriodStart);
    const end = new Date(subscription.status === "trialing" ? subscription.trialEnd : subscription.currentPeriodEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      throw billingStoreError("Subscription billing period is invalid.");
    }
    const item = {
      PK: `ORG#${organizationId}`, SK: "BILLING#SUBSCRIPTION",
      entityType: "BILLING_SUBSCRIPTION", organizationId,
      plan: plan.key, status: subscription.status,
      stripeCustomerId: subscription.stripeCustomerId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      currentPeriodStart: new Date(subscription.currentPeriodStart || start).toISOString(),
      currentPeriodEnd: new Date(subscription.currentPeriodEnd || end).toISOString(),
      ...(subscription.trialStart ? { trialStart: new Date(subscription.trialStart).toISOString() } : {}),
      ...(subscription.trialEnd ? { trialEnd: new Date(subscription.trialEnd).toISOString() } : {}),
      updatedAt: new Date().toISOString()
    };
    await documentClient.send(new commands.PutCommand({ TableName: tableName, Item: item }));
    return item;
  }

  async function getSubscription(organizationId) {
    if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) throw billingStoreError("A valid organization ID is required.");
    const result = await documentClient.send(new commands.GetCommand({
      TableName: tableName,
      Key: { PK: `ORG#${organizationId}`, SK: "BILLING#SUBSCRIPTION" },
      ConsistentRead: true
    }));
    return result.Item || null;
  }

  async function getSeatLimit(organizationId, now = new Date()) {
    const subscription = await getSubscription(organizationId);
    if (!subscription || !ACTIVE_STATUSES.has(subscription.status)) {
      throw billingStoreError("An active verified subscription is required before adding members.", 402);
    }
    const plan = plans.find(item => item.key === subscription.plan);
    if (!plan) throw billingStoreError("The subscription plan is not recognized; member changes are paused.", 503);
    const start = new Date(subscription.status === "trialing" ? (subscription.trialStart || subscription.currentPeriodStart) : subscription.currentPeriodStart);
    const end = new Date(subscription.status === "trialing" ? subscription.trialEnd : subscription.currentPeriodEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || now < start || now >= end) {
      throw billingStoreError("The subscription period is not currently valid; member changes are paused.", 402);
    }
    return plan.limits.agents;
  }

  return Object.freeze({ putVerifiedSubscription, getSubscription, getSeatLimit });
}

module.exports = { createDynamoSubscriptionStore };
