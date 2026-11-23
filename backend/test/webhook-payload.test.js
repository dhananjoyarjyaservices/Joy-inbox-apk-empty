const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isValidMetaWebhookPayload,
  isIgnorableWebhookRoutingError
} = require("../src/webhook");

test("accepts only the expected Meta webhook payload envelope shape", () => {
  assert.equal(isValidMetaWebhookPayload({
    object: "whatsapp_business_account",
    entry: []
  }), true);
  assert.equal(isValidMetaWebhookPayload(null), false);
  assert.equal(isValidMetaWebhookPayload([]), false);
  assert.equal(isValidMetaWebhookPayload({ object: "whatsapp_business_account", entry: {} }), false);
  assert.equal(isValidMetaWebhookPayload({ entry: [] }), false);
  assert.equal(isValidMetaWebhookPayload({ object: "whatsapp_business_account" }), false);
});

test("only known permanent routing errors are ignored instead of retried", () => {
  for (const statusCode of [400, 403, 404, 409]) {
    assert.equal(isIgnorableWebhookRoutingError({ statusCode }), true);
  }
  assert.equal(isIgnorableWebhookRoutingError(new Error("Firestore temporarily unavailable")), false);
  assert.equal(isIgnorableWebhookRoutingError({ statusCode: 500 }), false);
  assert.equal(isIgnorableWebhookRoutingError({ statusCode: 503 }), false);
  assert.equal(isIgnorableWebhookRoutingError(null), false);
});
