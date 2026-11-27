"use strict";

const { getConfiguredBillingPlans } = require("../billing");

function billingMigrationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Processes Stripe webhooks using DynamoDB-only persistence.
 * The HTTP boundary must verify Stripe-Signature against the raw request body
 * before calling this function. Subscription data for checkout/invoice events
 * is retrieved from Stripe, never trusted from the browser.
 */
async function processDynamoStripeWebhookEvent({
  event, eventStore, subscriptions, getStripeSubscription,
  plans = getConfiguredBillingPlans(), now = () => new Date()
}) {
  if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
    throw billingMigrationError("Invalid Stripe event payload.", 400);
  }
  if (!eventStore || typeof eventStore.claim !== "function" || typeof eventStore.finish !== "function") {
    throw new Error("A DynamoDB Stripe event store is required.");
  }
  if (!subscriptions || typeof subscriptions.putVerifiedSubscription !== "function") {
    throw new Error("A DynamoDB subscription store is required.");
  }
  if (typeof getStripeSubscription !== "function") throw new Error("A canonical Stripe subscription retriever is required.");

  const claim = await eventStore.claim(event.id);
  if (!claim.claimed) return {
    duplicate: claim.duplicate === true,
    inProgress: claim.inProgress === true,
    eventId: event.id
  };

  try {
    const object = event.data.object;
    let subscription = null;
    let organizationId = "";
    if (event.type === "checkout.session.completed") {
      organizationId = String(object.metadata?.organizationId || object.client_reference_id || "");
      const value = object.subscription || object.parent?.subscription_details?.subscription;
      const subscriptionId = typeof value === "string" ? value : value?.id;
      if (organizationId && subscriptionId) subscription = await getStripeSubscription(subscriptionId);
    } else if ([
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted"
    ].includes(event.type)) {
      organizationId = String(object.metadata?.organizationId || "");
      subscription = object;
    } else if (event.type === "invoice.payment_failed") {
      const value = object.subscription || object.parent?.subscription_details?.subscription;
      const subscriptionId = typeof value === "string" ? value : value?.id;
      if (subscriptionId) {
        subscription = await getStripeSubscription(subscriptionId);
        organizationId = String(subscription?.metadata?.organizationId || "");
      }
    }

    if (subscription && organizationId) {
      const priceId = String(subscription.items?.data?.[0]?.price?.id || "");
      const plan = plans.find(item => item.priceId === priceId || item.annualPriceId === priceId);
      const period = value => Number.isFinite(Number(value)) && Number(value) > 0
        ? new Date(Number(value) * 1000).toISOString() : null;
      const snapshot = {
        plan: plan?.key || "unknown",
        status: String(subscription.status || "unknown"),
        stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : String(subscription.customer?.id || ""),
        stripeSubscriptionId: String(subscription.id || ""),
        currentPeriodStart: period(subscription.current_period_start),
        currentPeriodEnd: period(subscription.current_period_end),
        trialStart: period(subscription.trial_start),
        trialEnd: period(subscription.trial_end)
      };
      await subscriptions.putVerifiedSubscription(organizationId, snapshot, { verified: true });
    }
    await eventStore.finish(event.id, claim.leaseToken, { status: "processed", eventType: event.type });
    return { processed: true, eventId: event.id, eventType: event.type };
  } catch (error) {
    await eventStore.finish(event.id, claim.leaseToken, { status: "failed", error }).catch(() => {});
    throw error;
  }
}

module.exports = { processDynamoStripeWebhookEvent };
