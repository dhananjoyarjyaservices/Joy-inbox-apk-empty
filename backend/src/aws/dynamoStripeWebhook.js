"use strict";

const { processVerifiedStripeWebhook } = require("../stripeWebhookBoundary");

/**
 * AWS-native Stripe webhook orchestration. The caller supplies configured
 * DynamoDB stores and a server-side Stripe API retriever; this module never
 * trusts browser-provided subscription state.
 */
async function processDynamoStripeWebhook({
  rawBody, signature, secret, stores, getStripeSubscription,
  nowSeconds
}) {
  if (!stores?.stripeBilling || typeof stores.stripeBilling.process !== "function") {
    const error = new Error("DynamoDB Stripe billing stores are not configured.");
    error.statusCode = 503;
    throw error;
  }
  if (typeof getStripeSubscription !== "function") {
    const error = new Error("Stripe subscription retrieval is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const verified = await processVerifiedStripeWebhook({
    rawBody, signature, secret, nowSeconds,
    processEvent: event => stores.stripeBilling.process({ event, getStripeSubscription })
  });
  return verified.result;
}

module.exports = { processDynamoStripeWebhook };
