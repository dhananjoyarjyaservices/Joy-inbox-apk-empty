const test = require("node:test");
const assert = require("node:assert/strict");
const { saveTenantIncomingMessage, verifyWebhook, isValidMetaWebhookPayload, getWebhookProcessingStatusCode } = require("../src/webhook");
const { handler } = require("../src/index");

function createRef(path, id = path.split("/").pop()) {
  return {
    path,
    id,
    collection(name) {
      return {
        doc(childId) {
          return createRef(path + "/" + name + "/" + childId, childId);
        }
      };
    }
  };
}

function createFakeDb() {
  const documents = new Map();
  return {
    documents,
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = documents.get(ref.path);
          return {
            exists: value !== undefined,
            data: () => value || {},
            get: key => value?.[key]
          };
        },
        set(ref, value, options) {
          writes.push({ ref, value, options });
        }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const previous = documents.get(write.ref.path) || {};
        documents.set(write.ref.path, write.options?.merge
          ? { ...previous, ...write.value }
          : write.value);
      }
      return result;
    }
  };
}

test("incoming customer media stores message metadata only, never image bytes or Storage paths", async () => {
  const db = createFakeDb();
  const organization = {
    id: "org_test",
    ref: createRef("organizations/org_test", "org_test")
  };
  const saved = await saveTenantIncomingMessage(db, organization, {
    from: "919876543210",
    id: "wamid.test-image-001",
    timestamp: "1795435200",
    type: "image",
    image: {
      id: "meta-media-id-123",
      mime_type: "image/jpeg",
      sha256: "abc123",
      file_size: 2048,
      caption: "Please check this"
    }
  }, "Customer", "123456789012345");

  assert.equal(saved, true);
  const message = db.documents.get(
    "organizations/org_test/chats/919876543210/messages/wamid.test-image-001"
  );
  assert.equal(message.direction, "incoming");
  assert.equal(message.type, "image");
  assert.equal(message.text, "Please check this");
  assert.equal(message.mediaId, "meta-media-id-123");
  assert.equal(message.mediaMimeType, "image/jpeg");

  for (const forbiddenField of [
    "mediaData",
    "mediaBytes",
    "fileBase64",
    "buffer",
    "mediaStoragePath",
    "storagePath",
    "downloadUrl"
  ]) {
    assert.equal(Object.hasOwn(message, forbiddenField), false, forbiddenField);
  }
});

test("duplicate incoming customer media message is not written twice", async () => {
  const db = createFakeDb();
  const organization = {
    id: "org_test",
    ref: createRef("organizations/org_test", "org_test")
  };
  const payload = {
    from: "919876543210",
    id: "wamid.duplicate-image",
    timestamp: "1795435200",
    type: "image",
    image: { id: "meta-media-id-456", mime_type: "image/jpeg" }
  };
  assert.equal(await saveTenantIncomingMessage(db, organization, payload, "Customer", "123456789012345"), true);
  assert.equal(await saveTenantIncomingMessage(db, organization, payload, "Customer", "123456789012345"), false);
  assert.equal(db.documents.size, 2);
});


test("Meta webhook subscription verification returns only a bounded challenge for the configured token", t => {
  const previous = process.env.WHATSAPP_VERIFY_TOKEN;
  process.env.WHATSAPP_VERIFY_TOKEN = "joy-inbox-webhook-verification-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = previous;
  });

  const valid = verifyWebhook({
    queryStringParameters: {
      "hub.mode": "subscribe",
      "hub.verify_token": "joy-inbox-webhook-verification-secret",
      "hub.challenge": "challenge-123"
    }
  });
  assert.deepEqual(valid, { statusCode: 200, body: "challenge-123" });

  const wrongToken = verifyWebhook({
    queryStringParameters: {
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong",
      "hub.challenge": "challenge-123"
    }
  });
  assert.equal(wrongToken.statusCode, 403);

  const oversizedChallenge = verifyWebhook({
    queryStringParameters: {
      "hub.mode": "subscribe",
      "hub.verify_token": "joy-inbox-webhook-verification-secret",
      "hub.challenge": "x".repeat(4097)
    }
  });
  assert.equal(oversizedChallenge.statusCode, 403);
});

test("Meta webhook payload validation rejects malformed structures", () => {
  assert.equal(isValidMetaWebhookPayload({ object: "whatsapp_business_account", entry: [] }), true);
  assert.equal(isValidMetaWebhookPayload(null), false);
  assert.equal(isValidMetaWebhookPayload({ object: "whatsapp_business_account", entry: {} }), false);
  assert.equal(isValidMetaWebhookPayload({ object: 7, entry: [] }), false);
  assert.equal(isValidMetaWebhookPayload([]), false);
});

test("webhook processing errors preserve only retryable server status codes", () => {
  assert.equal(getWebhookProcessingStatusCode({ statusCode: 503 }), 503);
  assert.equal(getWebhookProcessingStatusCode({ statusCode: 429 }), 500);
  assert.equal(getWebhookProcessingStatusCode(new Error("unknown")), 500);
});


test("HTTP Meta webhook route fails closed when the app secret is missing", async (t) => {
  const previousSecret = process.env.META_APP_SECRET;
  const previousLegacyFlag = process.env.LEGACY_OWNER_API_ENABLED;
  delete process.env.META_APP_SECRET;
  delete process.env.LEGACY_OWNER_API_ENABLED;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previousSecret;
    if (previousLegacyFlag === undefined) delete process.env.LEGACY_OWNER_API_ENABLED;
    else process.env.LEGACY_OWNER_API_ENABLED = previousLegacyFlag;
  });

  const response = await handler({
    httpMethod: "POST",
    path: "/webhook",
    headers: {},
    body: JSON.stringify({ object: "whatsapp_business_account", entry: [] })
  });
  assert.equal(response.statusCode, 500);
  assert.match(response.body, /signature verification failed/i);
});

test("HTTP Meta webhook route rejects an invalid signature before processing payloads", async (t) => {
  const previousSecret = process.env.META_APP_SECRET;
  const previousLegacyFlag = process.env.LEGACY_OWNER_API_ENABLED;
  process.env.META_APP_SECRET = "route-test-secret";
  delete process.env.LEGACY_OWNER_API_ENABLED;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previousSecret;
    if (previousLegacyFlag === undefined) delete process.env.LEGACY_OWNER_API_ENABLED;
    else process.env.LEGACY_OWNER_API_ENABLED = previousLegacyFlag;
  });

  const response = await handler({
    httpMethod: "POST",
    path: "/webhook",
    headers: { "x-hub-signature-256": "sha256=invalid" },
    body: JSON.stringify({ object: "whatsapp_business_account", entry: [] })
  });
  assert.equal(response.statusCode, 401);
  assert.match(response.body, /invalid webhook signature/i);
});
