"use strict";

const dynamodb = require("./dynamodb");

const EVENT_LEASE_SECONDS = 120;
const PLAN_SEATS = Object.freeze({ lite: 1, starter: 2, growth: 5, business: 5, pro: 10 });

function billingError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateOrganizationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw billingError("Stripe event has no valid workspace metadata.", 400);
  }
  return value;
}

function eventKey(eventId) {
  if (typeof eventId !== "string" || !/^evt_[A-Za-z0-9]{8,180}$/.test(eventId)) {
    throw billingError("Invalid Stripe event ID.", 400);
  }
  return { PK: "BILLING#STRIPE", SK: "EVENT#" + eventId };
}

async function claimStripeEvent(eventId, now = new Date()) {
  const key = eventKey(eventId);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.putItem("workspaces", {
      ...key,
      entityType: "STRIPE_EVENT",
      eventId,
      status: "processing",
      attempts: 1,
      leaseUntil: nowSeconds + EVENT_LEASE_SECONDS,
      expiresAt: nowSeconds + 60 * 60 * 24 * 30,
      updatedAt: now.toISOString()
    }, { ifAbsent: true });
    return { claimed: true, key };
  } catch (error) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    const existing = await dynamodb.getItem("workspaces", key, { consistentRead: true });
    if (existing?.status === "processed") return { claimed: false, reason: "processed", key };
    if (existing?.status === "processing" && Number(existing.leaseUntil) > nowSeconds) {
      return { claimed: false, reason: "processing", key };
    }
    try {
      await dynamodb.transactWrite([{
        Update: {
          TableName: dynamodb.getTableName("workspaces"),
          Key: key,
          UpdateExpression: "SET #status = :processing, leaseUntil = :lease, attempts = if_not_exists(attempts, :zero) + :one, updatedAt = :updated",
          ConditionExpression: "#status <> :processing OR leaseUntil <= :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":processing": "processing",
            ":lease": nowSeconds + EVENT_LEASE_SECONDS,
            ":zero": 0,
            ":one": 1,
            ":updated": now.toISOString(),
            ":now": nowSeconds
          }
        }
      }]);
      return { claimed: true, key };
    } catch (claimError) {
      if (claimError.name !== "TransactionCanceledException") throw claimError;
      return { claimed: false, reason: "processing", key };
    }
  }
}

async function finishStripeEvent(key, status, eventType, error) {
  const values = {
    ":status": status,
    ":updated": new Date().toISOString(),
    ":null": null
  };
  let expression = "SET #status = :status, updatedAt = :updated, leaseUntil = :null";
  const names = { "#status": "status" };
  if (status === "processed") {
    expression += ", eventType = :eventType, processedAt = :updated";
    values[":eventType"] = String(eventType || "unknown");
  } else {
    expression += ", error = :error";
    values[":error"] = String(error?.message || "Stripe event processing failed.").slice(0, 300);
  }
  await dynamodb.updateItem("workspaces", key, expression, values, names);
}

async function writeWorkspaceSubscription(organizationId, subscription, options = {}) {
  const id = validateOrganizationId(organizationId);
  if (!subscription || typeof subscription.id !== "string" || !subscription.id.startsWith("sub_")) {
    throw billingError("Stripe subscription payload is invalid.", 400);
  }
  const workspaceKey = dynamodb.workspaceKey(id);
  const workspace = await dynamodb.getItem("workspaces", workspaceKey, { consistentRead: true });
  if (!workspace || workspace.status !== "active") {
    throw billingError("Stripe event references an unknown or inactive workspace.", 404);
  }

  const priceId = String(subscription.items?.data?.[0]?.price?.id || "");
  const plans = options.plans || [];
  const matchedPlan = plans.find(plan => plan.priceId === priceId || plan.annualPriceId === priceId);
  const plan = matchedPlan?.key || "unknown";
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer : String(subscription.customer?.id || "");
  const existingCustomerId = String(workspace.stripeCustomerId || "");
  if (existingCustomerId && customerId && existingCustomerId !== customerId) {
    throw billingError("Stripe customer does not match the customer already linked to this workspace.", 409);
  }
  if (!customerId) throw billingError("Stripe subscription has no customer ID.", 400);

  const status = String(subscription.status || "unknown");
  const seatLimit = PLAN_SEATS[plan] || 1;
  const toIso = value => Number.isFinite(Number(value)) && Number(value) > 0
    ? new Date(Number(value) * 1000).toISOString() : null;
  const trialEnd = toIso(subscription.trial_end);
  const now = new Date().toISOString();
  const expressionNames = { "#plan": "plan", "#status": "subscriptionStatus" };
  const values = {
    ":plan": plan,
    ":status": status,
    ":seatLimit": seatLimit,
    ":customer": customerId,
    ":subscription": subscription.id,
    ":price": priceId,
    ":interval": matchedPlan?.annualPriceId === priceId ? "year" : "month",
    ":periodStart": toIso(subscription.current_period_start),
    ":periodEnd": toIso(subscription.current_period_end),
    ":trialStart": toIso(subscription.trial_start),
    ":trialEnd": trialEnd,
    ":cancel": subscription.cancel_at_period_end === true,
    ":updated": now
  };
  let expression = "SET #plan = :plan, #status = :status, seatLimit = :seatLimit, stripeCustomerId = :customer, stripeSubscriptionId = :subscription, stripePriceId = :price, billingInterval = :interval, currentPeriodStart = :periodStart, currentPeriodEnd = :periodEnd, trialStart = :trialStart, trialEnd = :trialEnd, cancelAtPeriodEnd = :cancel, updatedAt = :updated";
  if (trialEnd && !workspace.trialUsed) {
    expression += ", trialUsed = :true, trialUsedAt = :updated";
    values[":true"] = true;
  }
  await dynamodb.updateItem("workspaces", workspaceKey, expression, values, expressionNames);
  return { plan, status, seatLimit, stripeCustomerId: customerId, stripeSubscriptionId: subscription.id };
}


async function processStripeWebhookEvent(event, dependencies = {}) {
  if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
    throw billingError("Invalid Stripe event payload.", 400);
  }
  const now = dependencies.now ? dependencies.now() : new Date();
  const claim = await claimStripeEvent(event.id, now);
  if (!claim.claimed) {
    return { duplicate: claim.reason === "processed", inProgress: claim.reason === "processing", eventId: event.id };
  }
  try {
    const object = event.data.object;
    let subscription = null;
    let organizationId = "";
    if (event.type === "checkout.session.completed") {
      organizationId = String(object.metadata?.organizationId || object.client_reference_id || "");
      const value = object.subscription || object.parent?.subscription_details?.subscription;
      const subscriptionId = typeof value === "string" ? value : value?.id;
      if (organizationId && subscriptionId) {
        subscription = await (dependencies.getSubscription || (async id => {
          const billing = require("./billing");
          return billing.stripeRequest("/subscriptions/" + encodeURIComponent(id));
        }))(subscriptionId);
      }
    } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      organizationId = String(object.metadata?.organizationId || "");
      subscription = object;
    } else if (event.type === "invoice.payment_failed") {
      const value = object.subscription || object.parent?.subscription_details?.subscription;
      const subscriptionId = typeof value === "string" ? value : value?.id;
      if (subscriptionId) {
        subscription = await (dependencies.getSubscription || (async id => {
          const billing = require("./billing");
          return billing.stripeRequest("/subscriptions/" + encodeURIComponent(id));
        }))(subscriptionId);
        organizationId = String(subscription.metadata?.organizationId || "");
      }
    }
    if (organizationId && subscription) {
      const billing = require("./billing");
      await writeWorkspaceSubscription(organizationId, subscription, {
        plans: dependencies.plans || billing.getConfiguredBillingPlans()
      });
    }
    await finishStripeEvent(claim.key, "processed", event.type);
    return { processed: true, eventId: event.id, eventType: event.type };
  } catch (error) {
    await finishStripeEvent(claim.key, "failed", event.type, error);
    throw error;
  }
}

module.exports = {
  EVENT_LEASE_SECONDS,
  PLAN_SEATS,
  eventKey,
  claimStripeEvent,
  finishStripeEvent,
  writeWorkspaceSubscription
};
