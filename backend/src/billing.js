"use strict";

const crypto = require("crypto");

const STRIPE_API = "https://api.stripe.com/v1";
const EVENT_LEASE_MS = 2 * 60 * 1000;
const TRIAL_PERIOD_DAYS = 7;

function billingError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getConfiguredBillingPlans(env = process.env) {
  return [
    { key: "lite", name: "Lite", monthlyPriceInr: 299, annualPriceInr: 2990, priceId: env.STRIPE_PRICE_LITE || "", annualPriceId: env.STRIPE_PRICE_LITE_ANNUAL || "", limits: { messages: 10000, agents: 1, mediaTransferGb: 1, historyMonths: 3 } },
    { key: "starter", name: "Starter", monthlyPriceInr: 599, annualPriceInr: 5990, priceId: env.STRIPE_PRICE_STARTER || "", annualPriceId: env.STRIPE_PRICE_STARTER_ANNUAL || "", limits: { messages: 40000, agents: 2, mediaTransferGb: 3, historyMonths: 6 } },
    { key: "growth", name: "Growth", monthlyPriceInr: 999, annualPriceInr: 9990, priceId: env.STRIPE_PRICE_GROWTH || "", annualPriceId: env.STRIPE_PRICE_GROWTH_ANNUAL || "", limits: { messages: 100000, agents: 5, mediaTransferGb: 6, historyMonths: 12 } },
    { key: "business", name: "Business", monthlyPriceInr: 1499, annualPriceInr: 14990, priceId: env.STRIPE_PRICE_BUSINESS || "", annualPriceId: env.STRIPE_PRICE_BUSINESS_ANNUAL || "", limits: { messages: 150000, agents: 5, mediaTransferGb: 6, historyMonths: 12 } },
    { key: "pro", name: "Pro", monthlyPriceInr: 1999, annualPriceInr: 19990, priceId: env.STRIPE_PRICE_PRO || "", annualPriceId: env.STRIPE_PRICE_PRO_ANNUAL || "", limits: { messages: 300000, agents: 10, mediaTransferGb: 15, historyMonths: 12 } }
  ].map(plan => ({ ...plan, priceId: /^price_[A-Za-z0-9_]+$/.test(plan.priceId) ? plan.priceId : "", annualPriceId: /^price_[A-Za-z0-9_]+$/.test(plan.annualPriceId) ? plan.annualPriceId : "" }))
    .filter(plan => plan.priceId || plan.annualPriceId);
}

function validReturnUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function verifyStripeSignature(rawBody, signatureHeader, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || typeof signatureHeader !== "string" || !secret) return false;
  const parts = signatureHeader.split(",").map(item => item.trim());
  const timestamp = parts.find(item => item.startsWith("t="))?.slice(2);
  const signatures = parts.filter(item => item.startsWith("v1=")).map(item => item.slice(3));
  if (!/^\d{1,12}$/.test(timestamp || "") || !signatures.length) return false;
  const timestampNumber = Number(timestamp);
  if (Math.abs(nowSeconds - timestampNumber) > 300) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(timestamp + "."), rawBody]))
    .digest();
  return signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const supplied = Buffer.from(signature, "hex");
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  });
}

async function stripeRequest(path, options = {}) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || !secret.startsWith("sk_")) throw billingError("Stripe billing is not configured on the backend.", 503);
  const method = options.method || "GET";
  const headers = { Authorization: `Bearer ${secret}` };
  const requestOptions = { method, headers };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  if (options.params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    requestOptions.body = new URLSearchParams(options.params).toString();
  }
  const response = await fetch(`${STRIPE_API}${path}`, requestOptions);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = billingError(payload.error?.message || "Stripe billing request failed.", response.status >= 500 ? 502 : 400);
    error.stripeCode = payload.error?.code || "";
    throw error;
  }
  return payload;
}

async function createCheckoutSession({ organization, decoded, planKey, interval = "month", env = process.env }) {
  const plans = getConfiguredBillingPlans(env);
  const plan = plans.find(item => item.key === planKey);
  if (!plan) throw billingError("This billing plan is not configured.", 400);
  if (!["month", "year"].includes(interval)) throw billingError("Choose monthly or annual billing.", 400);
  const selectedPriceId = interval === "year" ? plan.annualPriceId : plan.priceId;
  if (!selectedPriceId) throw billingError("This billing interval is not configured for the selected plan.", 400);
  if (!validReturnUrl(env.BILLING_SUCCESS_URL) || !validReturnUrl(env.BILLING_CANCEL_URL)) {
    throw billingError("BILLING_SUCCESS_URL and BILLING_CANCEL_URL must be configured as trusted HTTPS URLs.", 503);
  }
  const subscriptionRef = organization.ref.collection("billing").doc("subscription");
  const existing = await subscriptionRef.get();
  const existingStatus = existing.exists ? String(existing.get("status") || "") : "";
  if (["active", "trialing", "past_due", "unpaid"].includes(existingStatus)) {
    throw billingError("This workspace already has a subscription. Use the Stripe Billing Portal to change or update it.", 409);
  }
  const customerId = existing.exists ? String(existing.get("stripeCustomerId") || "") : "";
  const trialAlreadyUsed = Boolean(existing.exists && existing.get("trialUsedAt"));
  const params = {
    mode: "subscription",
    "line_items[0][price]": selectedPriceId,
    "line_items[0][quantity]": "1",
    success_url: env.BILLING_SUCCESS_URL,
    cancel_url: env.BILLING_CANCEL_URL,
    client_reference_id: organization.id,
    "metadata[organizationId]": organization.id,
    "metadata[planKey]": plan.key,
    "metadata[billingInterval]": interval,
    "subscription_data[metadata][organizationId]": organization.id,
    "subscription_data[metadata][planKey]": plan.key,
    "subscription_data[metadata][billingInterval]": interval
  };
  if (!trialAlreadyUsed) params["subscription_data[trial_period_days]"] = String(TRIAL_PERIOD_DAYS);
  if (customerId) params.customer = customerId;
  else if (decoded.email) params.customer_email = String(decoded.email).slice(0, 254);
  const session = await stripeRequest("/checkout/sessions", {
    method: "POST",
    params,
    idempotencyKey: `joy-inbox-${organization.id}-${plan.key}-${interval}-${Math.floor(Date.now() / 300000)}`
  });
  if (!session.id || !validReturnUrl(session.url)) throw billingError("Stripe did not return a valid checkout URL.", 502);
  await subscriptionRef.set({
    checkoutSessionId: session.id,
    checkoutPlan: plan.key,
    checkoutInterval: interval,
    checkoutStartedAt: new Date(),
    updatedAt: new Date()
  }, { merge: true });
  return { id: session.id, url: session.url, plan: plan.key, interval, trialDays: trialAlreadyUsed ? 0 : TRIAL_PERIOD_DAYS };
}

async function createPortalSession({ organization, env = process.env }) {
  if (!validReturnUrl(env.BILLING_PORTAL_RETURN_URL)) {
    throw billingError("BILLING_PORTAL_RETURN_URL must be configured as a trusted HTTPS URL.", 503);
  }
  const subscriptionRef = organization.ref.collection("billing").doc("subscription");
  const snapshot = await subscriptionRef.get();
  const customerId = snapshot.exists ? String(snapshot.get("stripeCustomerId") || "") : "";
  if (!customerId) throw billingError("No Stripe customer is linked to this workspace yet.", 404);
  const session = await stripeRequest("/billing_portal/sessions", {
    method: "POST",
    params: { customer: customerId, return_url: env.BILLING_PORTAL_RETURN_URL }
  });
  if (!session.url || !validReturnUrl(session.url)) throw billingError("Stripe did not return a valid billing portal URL.", 502);
  return { url: session.url };
}

function extractSubscriptionFields(subscription, plans = getConfiguredBillingPlans()) {
  const priceId = String(subscription.items?.data?.[0]?.price?.id || "");
  const matchedPlan = plans.find(item => item.priceId === priceId || item.annualPriceId === priceId);
  const plan = matchedPlan?.key || "unknown";
  const interval = matchedPlan?.annualPriceId === priceId ? "year" : "month";
  const timestamp = value => Number.isFinite(Number(value)) && Number(value) > 0
    ? new Date(Number(value) * 1000) : null;
  return {
    plan,
    priceId,
    interval,
    status: String(subscription.status || "unknown"),
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : String(subscription.customer?.id || ""),
    stripeSubscriptionId: String(subscription.id || ""),
    currentPeriodEnd: timestamp(subscription.current_period_end),
    trialEnd: timestamp(subscription.trial_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    updatedAt: new Date()
  };
}

async function claimStripeEvent(db, eventId, now = new Date()) {
  if (!/^evt_[A-Za-z0-9]{8,180}$/.test(String(eventId || ""))) throw billingError("Invalid Stripe event ID.", 400);
  const ref = db.collection("stripeWebhookEvents").doc(eventId);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) {
      const data = snapshot.data() || {};
      if (data.status === "processing") {
        const leaseMillis = data.leaseUntil?.toDate ? data.leaseUntil.toDate().getTime() : new Date(data.leaseUntil || 0).getTime();
        if (Number.isFinite(leaseMillis) && leaseMillis > now.getTime()) return { claimed: false, ref, reason: "processing" };
      }
      if (data.status === "processed") return { claimed: false, ref, reason: "processed" };
    }
    transaction.set(ref, {
      status: "processing",
      leaseUntil: new Date(now.getTime() + EVENT_LEASE_MS),
      attempts: (snapshot.exists ? Number(snapshot.get("attempts") || 0) : 0) + 1,
      updatedAt: now
    }, { merge: true });
    return { claimed: true, ref };
  });
}

async function processStripeWebhookEvent(db, event, dependencies = {}) {
  if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
    throw billingError("Invalid Stripe event payload.", 400);
  }
  const now = dependencies.now ? dependencies.now() : new Date();
  const claim = await claimStripeEvent(db, event.id, now);
  if (!claim.claimed) return { duplicate: claim.reason === "processed", inProgress: claim.reason === "processing", eventId: event.id };
  try {
    const object = event.data.object;
    let subscription = null;
    if (event.type === "checkout.session.completed") {
      const organizationId = String(object.metadata?.organizationId || object.client_reference_id || "");
      const subscriptionValue = object.subscription || object.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subscriptionValue === "string" ? subscriptionValue : subscriptionValue?.id;
      if (organizationId && subscriptionId) {
        subscription = await (dependencies.getSubscription || (id => stripeRequest(`/subscriptions/${encodeURIComponent(id)}`)))(subscriptionId);
        await writeOrganizationSubscription(db, organizationId, subscription);
      }
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const organizationId = String(object.metadata?.organizationId || "");
      if (organizationId) await writeOrganizationSubscription(db, organizationId, object);
    } else if (event.type === "invoice.payment_failed") {
      const subscriptionValue = object.subscription || object.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subscriptionValue === "string" ? subscriptionValue : subscriptionValue?.id;
      if (subscriptionId) {
        subscription = await (dependencies.getSubscription || (id => stripeRequest(`/subscriptions/${encodeURIComponent(id)}`)))(subscriptionId);
        const organizationId = String(subscription.metadata?.organizationId || "");
        if (organizationId) await writeOrganizationSubscription(db, organizationId, subscription);
      }
    }
    await claim.ref.set({
      status: "processed",
      eventType: event.type,
      processedAt: new Date(),
      leaseUntil: null
    }, { merge: true });
    return { processed: true, eventId: event.id, eventType: event.type };
  } catch (error) {
    await claim.ref.set({
      status: "failed",
      error: String(error.message || "Stripe webhook processing failed.").slice(0, 300),
      leaseUntil: null,
      updatedAt: new Date()
    }, { merge: true });
    throw error;
  }
}

async function writeOrganizationSubscription(db, organizationId, subscription) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) throw billingError("Stripe event has no valid organization metadata.", 400);
  const organizationRef = db.collection("organizations").doc(organizationId);
  const organization = await organizationRef.get();
  if (!organization.exists) throw billingError("Stripe event references an unknown organization.", 404);
  const details = extractSubscriptionFields(subscription);
  const subscriptionRef = organizationRef.collection("billing").doc("subscription");
  const existing = await subscriptionRef.get();
  const existingCustomerId = existing.exists ? String(existing.get("stripeCustomerId") || "") : "";
  if (existingCustomerId && details.stripeCustomerId && existingCustomerId !== details.stripeCustomerId) {
    throw billingError("Stripe customer does not match the customer already linked to this workspace.", 409);
  }
  await subscriptionRef.set({
    ...details,
    ...(details.trialEnd ? { trialUsedAt: existing.exists && existing.get("trialUsedAt") ? existing.get("trialUsedAt") : new Date() } : {}),
    updatedAt: new Date()
  }, { merge: true });
  return details;
}

module.exports = {
  EVENT_LEASE_MS,
  TRIAL_PERIOD_DAYS,
  getConfiguredBillingPlans,
  validReturnUrl,
  verifyStripeSignature,
  stripeRequest,
  createCheckoutSession,
  createPortalSession,
  extractSubscriptionFields,
  claimStripeEvent,
  processStripeWebhookEvent,
  writeOrganizationSubscription
};
