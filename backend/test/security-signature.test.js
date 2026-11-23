const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyMetaSignature, getRawBody } = require("../src/security");

function signedEvent(body, secret, base64 = false) {
  const raw = Buffer.from(body, "utf8");
  const signature = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return {
    body: base64 ? raw.toString("base64") : body,
    isBase64Encoded: base64,
    headers: { "X-Hub-Signature-256": signature }
  };
}

test("Meta signature accepts the exact raw JSON body", () => {
  process.env.META_APP_SECRET = "test-meta-app-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  assert.equal(verifyMetaSignature(signedEvent(body, process.env.META_APP_SECRET)), true);
  delete process.env.META_APP_SECRET;
});

test("Meta signature accepts API Gateway base64 encoded raw request bodies", () => {
  process.env.META_APP_SECRET = "test-meta-app-secret";
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] });
  assert.equal(verifyMetaSignature(signedEvent(body, process.env.META_APP_SECRET, true)), true);
  assert.equal(getRawBody(signedEvent(body, process.env.META_APP_SECRET, true)).toString("utf8"), body);
  delete process.env.META_APP_SECRET;
});

test("Meta signature rejects a modified body", () => {
  process.env.META_APP_SECRET = "test-meta-app-secret";
  const event = signedEvent('{"entry":[]}', process.env.META_APP_SECRET);
  event.body = '{"entry":[{"changes":[]}]}';
  assert.equal(verifyMetaSignature(event), false);
  delete process.env.META_APP_SECRET;
});

test("Meta signature rejects missing, malformed and wrong-secret signatures", () => {
  process.env.META_APP_SECRET = "test-meta-app-secret";
  const body = '{"entry":[]}';
  assert.equal(verifyMetaSignature({ body, headers: {} }), false);
  assert.equal(verifyMetaSignature({ body, headers: { "x-hub-signature-256": "sha1=abcd" } }), false);
  const wrong = signedEvent(body, "another-secret");
  assert.equal(verifyMetaSignature(wrong), false);
  delete process.env.META_APP_SECRET;
});

test("Meta signature verification fails closed when the app secret is not configured", () => {
  delete process.env.META_APP_SECRET;
  delete process.env.WHATSAPP_APP_SECRET;
  assert.throws(() => verifyMetaSignature({ body: "{}", headers: {} }), /Meta App Secret is not configured/);
});
