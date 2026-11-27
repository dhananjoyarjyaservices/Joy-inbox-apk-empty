const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isValidMetaWebhookPayload,
  isIgnorableWebhookRoutingError,
  getWebhookProcessingStatusCode
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


test("webhook processing preserves retryable 5xx responses for Meta retries", () => {
  assert.equal(getWebhookProcessingStatusCode({ statusCode: 503 }), 503);
  assert.equal(getWebhookProcessingStatusCode({ statusCode: 502 }), 502);
  assert.equal(getWebhookProcessingStatusCode({ statusCode: 599 }), 599);
});

test("webhook processing never exposes non-server errors as success or client errors", () => {
  assert.equal(getWebhookProcessingStatusCode({ statusCode: 400 }), 500);
  assert.equal(getWebhookProcessingStatusCode({ statusCode: 401 }), 500);
  assert.equal(getWebhookProcessingStatusCode(new Error("temporary database issue")), 500);
  assert.equal(getWebhookProcessingStatusCode(null), 500);
});
