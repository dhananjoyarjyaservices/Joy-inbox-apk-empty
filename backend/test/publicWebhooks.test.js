"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  normalizeWebhookUrl,
  createOrganizationWebhook,
  listOrganizationWebhooks,
  revokeOrganizationWebhook,
  enqueueOrganizationWebhookEvent,
  resolvePublicWebhookHost,
  processPendingWebhookDeliveries
} = require("../src/publicWebhooks");

function fakeDb() {
  const records = new Map();
  let generated = 0;
  function doc(path) {
    return {
      id: path.split("/").pop(),
      path,
      async create(value) {
        if (records.has(path)) {
          const error = new Error("already exists");
          error.code = 6;
          throw error;
        }
        records.set(path, value);
      },
      async get() {
        const value = records.get(path);
        return { exists: Boolean(value), data: () => value };
      },
      async set(value, options = {}) {
        records.set(path, options.merge ? { ...(records.get(path) || {}), ...value } : value);
      },
      collection(name) { return collection(path + "/" + name); }
    };
  }
  function collection(path) {
    return {
      doc(id) { return doc(path + "/" + (id || "generated_" + (++generated))); },
      where(field, operator, value) {
        const query = {
          orderBy() { return query; },
          limit() { return query; },
          async get() {
            const prefix = path + "/";
            const docs = [...records.entries()].filter(([key, data]) => {
              if (!key.startsWith(prefix) || key.slice(prefix.length).includes("/")) return false;
              if (operator === "==") return data[field] === value;
              if (operator === "in") return value.includes(data[field]);
              return false;
            }).map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data }));
            return { docs };
          }
        };
        return query;
      },
      orderBy() {
        const query = { limit() { return query; }, async get() {
          const prefix = path + "/";
          return { docs: [...records.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
            .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data })) };
        } };
        return query;
      }
    };
  }
  return {
    records,
    collection,
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = records.get(ref.path);
          return { exists: Boolean(value), data: () => value };
        },
        set(ref, value, options = {}) {
          writes.push(() => records.set(ref.path, options.merge ? { ...(records.get(ref.path) || {}), ...value } : value));
        }
      };
      const result = await callback(transaction);
      writes.forEach(write => write());
      return result;
    }
  };
}

test("webhook URL validation requires HTTPS and rejects local/private destinations", () => {
  assert.equal(normalizeWebhookUrl("https://hooks.example.com/events"), "https://hooks.example.com/events");
  for (const value of [
    "http://hooks.example.com",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://10.0.0.2/hook",
    "https://192.168.1.5/hook",
    "https://metadata.google.internal/latest",
    "https://user:password@hooks.example.com/hook",
    "https://hooks.example.com:8443/hook"
  ]) assert.throws(() => normalizeWebhookUrl(value), { statusCode: 400 });
});

test("creates webhook subscriptions with encrypted secrets and lists no secret material", async () => {
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  const db = fakeDb();
  const created = await createOrganizationWebhook(db, "org_a", "owner_uid", {
    name: "CRM sync",
    url: "https://hooks.example.com/joy",
    events: ["contact.upserted", "message.received"]
  });
  assert.match(created.secret, /^joywhsec_[A-Za-z0-9_-]{40,64}$/);
  const stored = db.records.get("organizations/org_a/webhookSubscriptions/" + created.webhook.id);
  assert.ok(stored.secretEncrypted);
  assert.equal(stored.secret, undefined);
  const listed = await listOrganizationWebhooks(db, "org_a");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.webhook.id);
  assert.equal(listed[0].secret, undefined);
  await revokeOrganizationWebhook(db, "org_a", created.webhook.id);
  assert.equal((await listOrganizationWebhooks(db, "org_a"))[0].status, "revoked");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("webhook creation rejects unsupported event names and non-HTTPS URLs", async () => {
  const db = fakeDb();
  await assert.rejects(() => createOrganizationWebhook(db, "org_a", "owner", {
    name: "Invalid", url: "https://hooks.example.com", events: ["account.deleted"]
  }), { statusCode: 400 });
  await assert.rejects(() => createOrganizationWebhook(db, "org_a", "owner", {
    name: "Invalid", url: "http://hooks.example.com", events: ["contact.upserted"]
  }), { statusCode: 400 });
});

test("queues only subscribed events and deduplicates repeated event IDs", async () => {
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 14).toString("base64");
  const db = fakeDb();
  await createOrganizationWebhook(db, "org_a", "owner", {
    name: "Contacts", url: "https://hooks.example.com", events: ["contact.upserted"]
  });
  const first = await enqueueOrganizationWebhookEvent(db, "org_a", "contact.upserted", "contact-123", { phone: "+919876543210" });
  const duplicate = await enqueueOrganizationWebhookEvent(db, "org_a", "contact.upserted", "contact-123", { phone: "+919876543210" });
  const ignored = await enqueueOrganizationWebhookEvent(db, "org_a", "message.received", "message-123", { id: "message-123" });
  assert.equal(first.queued, 1);
  assert.equal(duplicate.queued, 0);
  assert.equal(ignored.queued, 0);
  assert.equal([...db.records.keys()].filter(path => path.startsWith("webhookDeliveryQueue/")).length, 1);
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("rejects webhook DNS results that include a private address", async () => {
  await assert.rejects(
    () => resolvePublicWebhookHost("hooks.example.com", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.4", family: 4 }
    ]),
    { statusCode: 400 }
  );
});

test("delivers a signed webhook and records the HTTP result", async () => {
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");
  const db = fakeDb();
  const created = await createOrganizationWebhook(db, "org_a", "owner", {
    name: "Contacts", url: "https://hooks.example.com/events", events: ["contact.upserted"]
  });
  await enqueueOrganizationWebhookEvent(db, "org_a", "contact.upserted", "contact-42", { phone: "+919876543210" }, 1000);
  let sentBody = "";
  let sentHeaders;
  const result = await processPendingWebhookDeliveries(db, {
    now: 1000,
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (_url, options) => {
      sentBody = options.body;
      sentHeaders = options.headers;
      return { ok: true, status: 204 };
    }
  });
  assert.deepEqual(result, { delivered: 1, retried: 0, failed: 0 });
  const expected = "sha256=" + crypto.createHmac("sha256", created.secret).update(sentBody).digest("hex");
  assert.equal(sentHeaders["X-Joy-Signature"], expected);
  assert.equal(sentHeaders["X-Joy-Event"], "contact.upserted");
  const delivery = [...db.records.entries()].find(([path]) => path.startsWith("webhookDeliveryQueue/"))[1];
  assert.equal(delivery.status, "delivered");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("retries failed webhook deliveries with backoff and marks terminal failures", async () => {
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 16).toString("base64");
  const db = fakeDb();
  await createOrganizationWebhook(db, "org_a", "owner", {
    name: "Contacts", url: "https://hooks.example.com/events", events: ["contact.upserted"]
  });
  await enqueueOrganizationWebhookEvent(db, "org_a", "contact.upserted", "contact-43", { phone: "+919876543211" }, 1000);
  const failed = await processPendingWebhookDeliveries(db, {
    now: 1000,
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.deepEqual(failed, { delivered: 0, retried: 1, failed: 0 });
  let deliveryEntry = [...db.records.entries()].find(([path]) => path.startsWith("webhookDeliveryQueue/"));
  assert.equal(deliveryEntry[1].status, "pending");
  assert.equal(deliveryEntry[1].attempts, 1);
  const terminal = await processPendingWebhookDeliveries(db, {
    now: deliveryEntry[1].nextAttemptAt.getTime(),
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.deepEqual(terminal, { delivered: 0, retried: 1, failed: 0 });
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});
