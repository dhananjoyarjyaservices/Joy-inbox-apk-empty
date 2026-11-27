const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyWebhook } = require("../src/webhook");

test("accepts Meta webhook subscription challenge with the configured verify token", () => {
  process.env.WHATSAPP_VERIFY_TOKEN = "joy-inbox-test-token";
  const result = verifyWebhook({
    queryStringParameters: {
      "hub.mode": "subscribe",
      "hub.verify_token": "joy-inbox-test-token",
      "hub.challenge": "challenge-123"
    }
  });
  assert.deepEqual(result, { statusCode: 200, body: "challenge-123" });
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

test("rejects invalid Meta webhook subscription challenge", () => {
  process.env.WHATSAPP_VERIFY_TOKEN = "joy-inbox-test-token";
  const result = verifyWebhook({
    queryStringParameters: {
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "challenge-123"
    }
  });
  assert.equal(result.statusCode, 403);
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

test("reports missing webhook verification configuration", () => {
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  delete process.env.VERIFY_TOKEN;
  const result = verifyWebhook({ queryStringParameters: { "hub.mode": "subscribe" } });
  assert.equal(result.statusCode, 500);
});


test("rejects a verification token with a different byte length", () => {
  process.env.WHATSAPP_VERIFY_TOKEN = "joy-inbox-test-token";
  const result = verifyWebhook({
    queryStringParameters: {
      "hub.mode": "subscribe",
      "hub.verify_token": "short",
      "hub.challenge": "challenge-123"
    }
  });
  assert.equal(result.statusCode, 403);
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

test("rejects an empty or oversized webhook challenge", () => {
  process.env.WHATSAPP_VERIFY_TOKEN = "joy-inbox-test-token";
  const base = { "hub.mode": "subscribe", "hub.verify_token": "joy-inbox-test-token" };
  assert.equal(verifyWebhook({ queryStringParameters: { ...base, "hub.challenge": "" } }).statusCode, 403);
  assert.equal(verifyWebhook({ queryStringParameters: { ...base, "hub.challenge": "x".repeat(4097) } }).statusCode, 403);
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});
