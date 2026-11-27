"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { processDynamoStripeWebhookEvent } = require("../src/aws/dynamoStripeBilling");

function fixture() {
  const calls = [];
  const eventStore = {
    async claim(id) { calls.push(["claim", id]); return { claimed: true, leaseToken: "lease_1" }; },
    async finish(id, token, result) { calls.push(["finish", id, token, result]); }
  };
  const subscriptions = {
    async putVerifiedSubscription(orgId, snapshot, options) { calls.push(["subscription", orgId, snapshot, options]); }
  };
  return { calls, eventStore, subscriptions };
}
const plans = [{ key: "starter", priceId: "price_starter", annualPriceId: "price_starter_year" }];
const stripeSub = {
  id: "sub_123", customer: "cus_123", status: "active",
  current_period_start: 1793491200, current_period_end: 1796083200,
  metadata: { organizationId: "org_1" },
  items: { data: [{ price: { id: "price_starter" } }] }
};

test("processes checkout completion using canonical Stripe subscription retrieval", async () => {
  const f = fixture();
  const result = await processDynamoStripeWebhookEvent({
    event: { id: "evt_123456789", type: "checkout.session.completed", data: { object: {
      client_reference_id: "org_1", subscription: "sub_123"
    } } },
    ...f, plans, getStripeSubscription: async id => { assert.equal(id, "sub_123"); return stripeSub; }
  });
  assert.equal(result.processed, true);
  const saved = f.calls.find(x => x[0] === "subscription");
  assert.equal(saved[1], "org_1");
  assert.equal(saved[2].plan, "starter");
  assert.deepEqual(saved[3], { verified: true });
  assert.equal(f.calls.at(-1)[0], "finish");
});

test("processes subscription updates and cancellations from signed webhook payload", async () => {
  const f = fixture();
  const canceled = { ...stripeSub, status: "canceled" };
  await processDynamoStripeWebhookEvent({
    event: { id: "evt_123456790", type: "customer.subscription.deleted", data: { object: canceled } },
    ...f, plans, getStripeSubscription: async () => { assert.fail("Direct subscription event must not refetch."); }
  });
  assert.equal(f.calls.find(x => x[0] === "subscription")[2].status, "canceled");
});

test("invoice payment failure retrieves canonical subscription and persists inactive state", async () => {
  const f = fixture();
  await processDynamoStripeWebhookEvent({
    event: { id: "evt_123456791", type: "invoice.payment_failed", data: { object: { subscription: "sub_123" } } },
    ...f, plans, getStripeSubscription: async () => ({ ...stripeSub, status: "past_due" })
  });
  assert.equal(f.calls.find(x => x[0] === "subscription")[2].status, "past_due");
});

test("does not write subscription data when duplicate or event is in progress", async () => {
  const f = fixture();
  f.eventStore.claim = async () => ({ claimed: false, duplicate: true, inProgress: false });
  const result = await processDynamoStripeWebhookEvent({
    event: { id: "evt_123456792", type: "customer.subscription.updated", data: { object: stripeSub } },
    ...f, plans, getStripeSubscription: async () => stripeSub
  });
  assert.equal(result.duplicate, true);
  assert.equal(f.calls.some(x => x[0] === "subscription"), false);
});

test("marks event failed and rethrows if canonical subscription lookup fails", async () => {
  const f = fixture();
  await assert.rejects(() => processDynamoStripeWebhookEvent({
    event: { id: "evt_123456793", type: "checkout.session.completed", data: { object: {
      metadata: { organizationId: "org_1" }, subscription: "sub_123"
    } } },
    ...f, plans, getStripeSubscription: async () => { throw new Error("Stripe unavailable"); }
  }), /Stripe unavailable/);
  assert.equal(f.calls.at(-1)[0], "finish");
  assert.equal(f.calls.at(-1)[3].status, "failed");
});

test("requires validated event and persistence dependencies", async () => {
  await assert.rejects(() => processDynamoStripeWebhookEvent({ event: {} }), /Invalid Stripe event/);
});
