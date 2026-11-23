"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  EVENT_LEASE_MS,
  getConfiguredBillingPlans,
  validReturnUrl,
  verifyStripeSignature,
  extractSubscriptionFields,
  claimStripeEvent,
  createCheckoutSession,
  createPortalSession,
  processStripeWebhookEvent
} = require("../src/billing");

test("billing plan discovery returns only Stripe price IDs configured by the backend", () => {
  const plans = getConfiguredBillingPlans({
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_GROWTH: "",
    STRIPE_PRICE_BUSINESS: "price_business"
  });
  assert.deepEqual(plans.map(plan => plan.key), ["starter", "business"]);
  assert.equal(plans[0].priceId, "price_starter");
});

test("billing return URLs must be HTTPS except local development URLs", () => {
  assert.equal(validReturnUrl("https://app.example.com/billing/success"), true);
  assert.equal(validReturnUrl("http://localhost:5173/billing"), true);
  assert.equal(validReturnUrl("http://app.example.com"), false);
  assert.equal(validReturnUrl("javascript:alert(1)"), false);
});

test("Stripe webhook signature verification checks timestamp and HMAC", () => {
  const raw = Buffer.from(JSON.stringify({ id: "evt_123456789", type: "customer.subscription.updated" }));
  const secret = "whsec_test_secret";
  const timestamp = 1_800_000_000;
  const signature = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(String(timestamp) + "."), raw]))
    .digest("hex");
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${signature}`, secret, timestamp), true);
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${"0".repeat(64)}`, secret, timestamp), false);
  assert.equal(verifyStripeSignature(raw, `t=${timestamp - 600},v1=${signature}`, secret, timestamp), false);
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${signature}`, "", timestamp), false);
});

test("subscription normalization extracts plan, status, customer and billing dates", () => {
  const value = extractSubscriptionFields({
    id: "sub_123",
    customer: "cus_123",
    status: "active",
    current_period_end: 1_800_000_000,
    trial_end: null,
    cancel_at_period_end: true,
    items: { data: [{ price: { id: "price_growth" } }] }
  }, [{ key: "growth", name: "Growth", priceId: "price_growth" }]);
  assert.equal(value.plan, "growth");
  assert.equal(value.status, "active");
  assert.equal(value.stripeCustomerId, "cus_123");
  assert.equal(value.stripeSubscriptionId, "sub_123");
  assert.equal(value.currentPeriodEnd.toISOString(), "2027-01-15T08:00:00.000Z");
  assert.equal(value.cancelAtPeriodEnd, true);
});

test("Stripe event claims use a bounded lease and mark completed events as duplicates", async () => {
  const now = new Date("2026-11-23T12:00:00.000Z");
  let stored = null;
  const ref = {};
  const db = {
    collection(name) {
      assert.equal(name, "stripeWebhookEvents");
      return { doc(id) { assert.equal(id, "evt_123456789"); return ref; } };
    },
    async runTransaction(callback) {
      return callback({
        async get() { return { exists: Boolean(stored), data: () => stored, get: key => stored?.[key] }; },
        set(_ref, patch) { stored = { ...stored, ...patch }; }
      });
    }
  };
  const first = await claimStripeEvent(db, "evt_123456789", now);
  assert.equal(first.claimed, true);
  assert.equal(stored.status, "processing");
  assert.equal(stored.leaseUntil.getTime(), now.getTime() + EVENT_LEASE_MS);
  stored.status = "processed";
  const second = await claimStripeEvent(db, "evt_123456789", now);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "processed");
});

test("checkout session creation uses server price IDs and a Stripe idempotency key", async t => {
  const oldKey = process.env.STRIPE_SECRET_KEY;
  const oldFetch = global.fetch;
  const oldSuccess = process.env.BILLING_SUCCESS_URL;
  const oldCancel = process.env.BILLING_CANCEL_URL;
  t.after(() => {
    if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldKey;
    if (oldSuccess === undefined) delete process.env.BILLING_SUCCESS_URL; else process.env.BILLING_SUCCESS_URL = oldSuccess;
    if (oldCancel === undefined) delete process.env.BILLING_CANCEL_URL; else process.env.BILLING_CANCEL_URL = oldCancel;
    global.fetch = oldFetch;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.BILLING_SUCCESS_URL = "https://app.example.com/success?session_id={CHECKOUT_SESSION_ID}";
  process.env.BILLING_CANCEL_URL = "https://app.example.com/cancel";
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" }; } };
  };
  const writes = [];
  const organization = {
    id: "org_123",
    ref: { collection(name) {
      assert.equal(name, "billing");
      return { doc(id) {
        assert.equal(id, "subscription");
        return {
          async get() { return { exists: false }; },
          async set(value, options) { writes.push({ value, options }); }
        };
      } };
    } }
  };
  const session = await createCheckoutSession({
    organization,
    decoded: { email: "owner@example.com" },
    planKey: "starter",
    env: {
      STRIPE_PRICE_STARTER: "price_starter",
      BILLING_SUCCESS_URL: process.env.BILLING_SUCCESS_URL,
      BILLING_CANCEL_URL: process.env.BILLING_CANCEL_URL
    }
  });
  assert.equal(session.id, "cs_test_123");
  assert.equal(session.plan, "starter");
  assert.match(request.url, /checkout\/sessions$/);
  assert.equal(request.options.headers.Authorization, "Bearer sk_test_123");
  assert.equal(request.options.headers["Idempotency-Key"].startsWith("joy-inbox-org_123-starter-"), true);
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get("line_items[0][price]"), "price_starter");
  assert.equal(form.get("metadata[organizationId]"), "org_123");
  assert.equal(form.get("customer_email"), "owner@example.com");
  assert.equal(writes.length, 1);
});

test("Stripe webhook processor ignores an already processed event", async () => {
  const ref = {};
  const stored = { status: "processed" };
  const db = {
    collection() { return { doc() { return ref; } }; },
    async runTransaction(callback) {
      return callback({
        async get() { return { exists: true, data: () => stored, get: key => stored[key] }; },
        set() { assert.fail("Processed Stripe events must not be claimed again."); }
      });
    }
  };
  const result = await processStripeWebhookEvent(db, {
    id: "evt_123456789",
    type: "checkout.session.completed",
    data: { object: {} }
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.inProgress, false);
});

test("checkout cannot create a duplicate subscription for an active workspace", async () => {
  const organization = {
    id: "org_active",
    ref: { collection() {
      return { doc() {
        return { async get() {
          return { exists: true, get: key => key === "status" ? "active" : "cus_existing" };
        } };
      } };
    } }
  };
  await assert.rejects(
    createCheckoutSession({
      organization,
      decoded: { email: "owner@example.com" },
      planKey: "starter",
      env: {
        STRIPE_PRICE_STARTER: "price_starter",
        BILLING_SUCCESS_URL: "https://app.example.com/success",
        BILLING_CANCEL_URL: "https://app.example.com/cancel"
      }
    }),
    error => error.statusCode === 409 && /Billing Portal/.test(error.message)
  );
});

test("checkout completion webhook stores subscription state in the correct organization", async t => {
  const previousPrice = process.env.STRIPE_PRICE_GROWTH;
  process.env.STRIPE_PRICE_GROWTH = "price_growth";
  t.after(() => { if (previousPrice === undefined) delete process.env.STRIPE_PRICE_GROWTH; else process.env.STRIPE_PRICE_GROWTH = previousPrice; });
  let eventRecord = null;
  let subscriptionRecord = null;
  const eventRef = {
    async set(patch) { eventRecord = { ...eventRecord, ...patch }; }
  };
  const organizationRef = {
    async get() { return { exists: true }; },
    collection(name) {
      assert.equal(name, "billing");
      return { doc(id) {
        assert.equal(id, "subscription");
        return { async set(value) { subscriptionRecord = value; } };
      } };
    }
  };
  const db = {
    collection(name) {
      if (name === "stripeWebhookEvents") return { doc() { return eventRef; } };
      if (name === "organizations") return { doc(id) {
        assert.equal(id, "org_123");
        return organizationRef;
      } };
      throw new Error("Unexpected collection " + name);
    },
    async runTransaction(callback) {
      return callback({
        async get() {
          return { exists: Boolean(eventRecord), data: () => eventRecord, get: key => eventRecord?.[key] };
        },
        set(_ref, patch) { eventRecord = { ...eventRecord, ...patch }; }
      });
    }
  };
  const result = await processStripeWebhookEvent(db, {
    id: "evt_checkout_123456789",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_123",
      customer: "cus_123",
      subscription: "sub_123",
      metadata: { organizationId: "org_123" }
    } }
  }, {
    getSubscription: async () => ({
      id: "sub_123",
      customer: "cus_123",
      status: "active",
      current_period_end: 1_800_000_000,
      cancel_at_period_end: false,
      metadata: { organizationId: "org_123" },
      items: { data: [{ price: { id: "price_growth" } }] }
    })
  });
  assert.equal(result.processed, true);
  assert.equal(subscriptionRecord.plan, "growth");
  assert.equal(subscriptionRecord.status, "active");
  assert.equal(subscriptionRecord.stripeCustomerId, "cus_123");
  assert.equal(subscriptionRecord.stripeSubscriptionId, "sub_123");
  assert.equal(eventRecord.status, "processed");
});
