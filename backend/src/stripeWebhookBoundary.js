"use strict";

const { verifyStripeSignature } = require("./billing");

function webhookError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Verify Stripe's signature over the exact raw request bytes before parsing
 * or passing the event to any persistence implementation.
 */
async function processVerifiedStripeWebhook({
  rawBody, signature, secret, processEvent,
  nowSeconds = Math.floor(Date.now() / 1000)
}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw webhookError("Stripe webhook raw body is required.", 400);
  }
  if (!verifyStripeSignature(rawBody, signature, secret, nowSeconds)) {
    throw webhookError("Invalid Stripe signature.", 400);
  }
  if (typeof processEvent !== "function") {
    throw webhookError("Stripe webhook processor is not configured.", 503);
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw webhookError("Invalid Stripe event JSON.", 400);
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
    throw webhookError("Invalid Stripe event payload.", 400);
  }
  const result = await processEvent(event);
  return { event, result };
}

module.exports = { processVerifiedStripeWebhook };
