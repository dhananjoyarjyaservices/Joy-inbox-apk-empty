"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { processDynamoStripeWebhook } = require("../src/aws/dynamoStripeWebhook");

const secret = "whsec_aws_native_test";
const now = 1793491200;
const event = {
  id: "evt_123456789", type: "checkout.session.completed",
  data: { object: { client_reference_id: "org_1", subscription: "sub_123" } }
};
function signed(value = event) {
  const rawBody = Buffer.from(JSON.stringify(value));
  const digest = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(String(now) + "."), rawBody])).digest("hex");
  return { rawBody, signature: `t=${now},v1=${digest}` };
}

test("verifies Stripe request then sends event to DynamoDB billing processor", async () => {
  const calls = [];
  const stores = { stripeBilling: { process: async options => {
    calls.push(options);
    return { processed: true, eventId: options.event.id };
  } } };
  const getStripeSubscription = async id => ({ id });
  const result = await processDynamoStripeWebhook({
    ...signed(), secret, nowSeconds: now, stores, getStripeSubscription
  });
  assert.deepEqual(result, { processed: true, eventId: event.id });
  assert.equal(calls[0].event.id, event.id);
  assert.equal(calls[0].getStripeSubscription, getStripeSubscription);
});

test("rejects invalid signatures before touching DynamoDB", async () => {
  let called = false;
  const request = signed();
  request.rawBody = Buffer.from(request.rawBody.toString("utf8") + " ");
  await assert.rejects(() => processDynamoStripeWebhook({
    ...request, secret, nowSeconds: now,
    stores: { stripeBilling: { process: async () => { called = true; } } },
    getStripeSubscription: async () => ({})
  }), /Invalid Stripe signature/);
  assert.equal(called, false);
});

test("requires AWS persistence and canonical Stripe retrieval dependencies", async () => {
  const request = signed();
  await assert.rejects(() => processDynamoStripeWebhook({
    ...request, secret, nowSeconds: now, getStripeSubscription: async () => ({})
  }), /DynamoDB Stripe billing stores are not configured/);
  await assert.rejects(() => processDynamoStripeWebhook({
    ...request, secret, nowSeconds: now,
    stores: { stripeBilling: { process: async () => ({}) } }
  }), /Stripe subscription retrieval is not configured/);
});
