const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyMetaSignature, getCorsHeaders, jsonResponse } = require("../src/security");

function signatureFor(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function withAppSecret(secret, callback) {
  const previous = process.env.META_APP_SECRET;
  if (secret === undefined) delete process.env.META_APP_SECRET;
  else process.env.META_APP_SECRET = secret;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previous;
  }
}


function withCorsOrigins(origins, callback) {
  const previous = process.env.CORS_ORIGINS;
  if (origins === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = origins;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previous;
  }
}

test("CORS reflects only an exact origin from the configured allowlist", () => {
  withCorsOrigins("https://app.example.com, https://preview.example.com", () => {
    const allowed = getCorsHeaders({ headers: { Origin: "https://app.example.com" } });
    assert.equal(allowed["Access-Control-Allow-Origin"], "https://app.example.com");
    assert.equal(allowed.Vary, "Origin");

    const unlisted = getCorsHeaders({ headers: { Origin: "https://evil.example.com" } });
    assert.equal(unlisted["Access-Control-Allow-Origin"], undefined);
    assert.equal(unlisted.Vary, undefined);
  });
});

test("CORS does not use wildcard or accept origin-prefix lookalikes", () => {
  withCorsOrigins("https://app.example.com", () => {
    const lookalike = getCorsHeaders({ headers: { origin: "https://app.example.com.evil.test" } });
    assert.equal(lookalike["Access-Control-Allow-Origin"], undefined);
    const response = jsonResponse({ headers: { origin: "https://evil.example.com" } }, 200, { ok: true });
    assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
    assert.equal(response.headers["Cache-Control"], "no-store");
  });
});

test("CORS omits browser origin headers when the request has no Origin", () => {
  withCorsOrigins("https://app.example.com", () => {
    const headers = getCorsHeaders({ headers: {} });
    assert.equal(headers["Access-Control-Allow-Origin"], undefined);
    assert.equal(headers["Access-Control-Allow-Headers"], "Content-Type,Authorization");
  });
});

test("Meta webhook signature accepts the exact raw request body", () => {
  const secret = "joy-inbox-test-meta-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const event = {
    body,
    headers: { "x-hub-signature-256": signatureFor(body, secret) }
  };

  withAppSecret(secret, () => assert.equal(verifyMetaSignature(event), true));
});

test("Meta webhook signature rejects a body changed after signing", () => {
  const secret = "joy-inbox-test-meta-secret";
  const signedBody = JSON.stringify({ entry: [{ id: "original" }] });
  const event = {
    body: JSON.stringify({ entry: [{ id: "tampered" }] }),
    headers: { "x-hub-signature-256": signatureFor(signedBody, secret) }
  };

  withAppSecret(secret, () => assert.equal(verifyMetaSignature(event), false));
});

test("Meta webhook signature verifies API Gateway base64-encoded raw bodies", () => {
  const secret = "joy-inbox-test-meta-secret";
  const rawBody = Buffer.from(JSON.stringify({ entry: [{ id: "base64" }] }));
  const event = {
    body: rawBody.toString("base64"),
    isBase64Encoded: true,
    headers: { "X-Hub-Signature-256": signatureFor(rawBody, secret) }
  };

  withAppSecret(secret, () => assert.equal(verifyMetaSignature(event), true));
});

test("Meta webhook signature rejects missing and malformed signature headers", () => {
  const secret = "joy-inbox-test-meta-secret";
  withAppSecret(secret, () => {
    assert.equal(verifyMetaSignature({ body: "{}", headers: {} }), false);
    assert.equal(verifyMetaSignature({
      body: "{}",
      headers: { "x-hub-signature-256": "md5=invalid" }
    }), false);
  });
});

test("Meta webhook signature fails closed when the app secret is not configured", () => {
  withAppSecret(undefined, () => {
    assert.throws(
      () => verifyMetaSignature({ body: "{}", headers: {} }),
      /Meta App Secret is not configured/
    );
  });
});
