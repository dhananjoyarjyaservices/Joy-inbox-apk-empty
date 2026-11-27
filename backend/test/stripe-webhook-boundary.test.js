"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { processVerifiedStripeWebhook } = require("../src/stripeWebhookBoundary");

const secret = "whsec_test_secret";
const now = 1793491200;
const event = { id: "evt_123456789", type: "customer.subscription.updated", data: { object: { id: "sub_123" } } };

function signedBody(value = event, timestamp = now) {
  const rawBody = Buffer.from(JSON.stringify(value));
  const digest = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(String(timestamp) + "."), rawBody]))
    .digest("hex");
  return { rawBody, signature: `t=${timestamp},v1=${digest}` };
}

test("verifies exact raw bytes before invoking the persistence processor", async () => {
  const signed = signedBody();
  let received;
  const output = await processVerifiedStripeWebhook({
    ...signed, secret, nowSeconds: now,
    processEvent: async value => { received = value; return { processed: true }; }
  });
  assert.deepEqual(received, event);
  assert.equal(output.result.processed, true);
});

test("rejects a modified body and never invokes persistence", async () => {
  const signed = signedBody();
  signed.rawBody = Buffer.from(signed.rawBody.toString("utf8") + " ");
  let called = false;
  await assert.rejects(() => processVerifiedStripeWebhook({
    ...signed, secret, nowSeconds: now,
    processEvent: async () => { called = true; }
  }), { statusCode: 400, message: "Invalid Stripe signature." });
  assert.equal(called, false);
});

test("rejects stale signatures", async () => {
  const signed = signedBody(event, now - 301);
  await assert.rejects(() => processVerifiedStripeWebhook({
    ...signed, secret, nowSeconds: now, processEvent: async () => ({})
  }), { statusCode: 400 });
});

test("rejects malformed JSON and invalid event envelopes after signature verification", async () => {
  const rawBody = Buffer.from("{");
  const digest = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(String(now) + "."), rawBody])).digest("hex");
  await assert.rejects(() => processVerifiedStripeWebhook({
    rawBody, signature: `t=${now},v1=${digest}`, secret, nowSeconds: now,
    processEvent: async () => ({})
  }), /Invalid Stripe event JSON/);
  const invalid = signedBody({ id: "evt_123456789", type: "charge.succeeded" });
  await assert.rejects(() => processVerifiedStripeWebhook({
    ...invalid, secret, nowSeconds: now, processEvent: async () => ({})
  }), /Invalid Stripe event payload/);
});

test("requires raw bytes and a configured processor", async () => {
  await assert.rejects(() => processVerifiedStripeWebhook({
    rawBody: "not bytes", signature: "", secret, processEvent: async () => ({})
  }), /raw body is required/);
  const signed = signedBody();
  await assert.rejects(() => processVerifiedStripeWebhook({
    ...signed, secret, nowSeconds: now
  }), /processor is not configured/);
});
