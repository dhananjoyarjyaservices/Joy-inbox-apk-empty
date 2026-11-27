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
        const filters = [{ field, operator, value }];
        const orders = [];
        let pageLimit = Infinity;
        let cursorValues = null;
        const query = {
          where(nextField, nextOperator, nextValue) { filters.push({ field: nextField, operator: nextOperator, value: nextValue }); return query; },
          orderBy(orderField, direction = "asc") { orders.push({ field: orderField, direction }); return query; },
          startAfter(...values) { cursorValues = values; return query; },
          limit(value) { pageLimit = value; return query; },
          async get() {
            const prefix = path + "/";
            let entries = [...records.entries()].filter(([key, data]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/") &&
              filters.every(filter => filter.operator === "==" ? data[filter.field] === filter.value :
                filter.operator === "in" ? filter.value.includes(data[filter.field]) : false))
              .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data }));
            const valueOf = (item, field) => field === "__name__" ? item.id : item.data()?.[field];
            entries.sort((a, b) => {
              for (const order of orders) {
                const av = valueOf(a, order.field), bv = valueOf(b, order.field);
                const aa = av instanceof Date ? av.getTime() : String(av ?? "");
                const bb = bv instanceof Date ? bv.getTime() : String(bv ?? "");
                if (aa !== bb) return (aa < bb ? -1 : 1) * (order.direction === "desc" ? -1 : 1);
              }
              return 0;
            });
            if (cursorValues) {
              const [createdAt, id] = cursorValues;
              const timestamp = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
              entries = entries.filter(item => {
                const itemTime = new Date(item.data()?.createdAt).getTime();
                return itemTime < timestamp || (itemTime === timestamp && item.id.localeCompare(id) < 0);
              });
            }
            return { docs: entries.slice(0, pageLimit) };
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
    "https://169.254.169.254/latest",
    "https://192.0.2.10/hook",
    "https://[::1]/hook",
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
  const expected = "sha256=" + crypto.createHmac("sha256", created.secret).update(`${sentHeaders["X-Joy-Timestamp"]}.${sentBody}`).digest("hex");
  assert.equal(sentHeaders["X-Joy-Signature"], expected);
  assert.equal(sentHeaders["X-Joy-Event"], "contact.upserted");
  const delivery = [...db.records.entries()].find(([path]) => path.startsWith("webhookDeliveryQueue/"))[1];
  assert.equal(delivery.status, "delivered");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("retries failed webhook deliveries with exponential backoff and marks the eighth attempt terminal", async () => {
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 16).toString("base64");
  const db = fakeDb();
  await createOrganizationWebhook(db, "org_a", "owner", {
    name: "Contacts", url: "https://hooks.example.com/events", events: ["contact.upserted"]
  });
  await enqueueOrganizationWebhookEvent(db, "org_a", "contact.upserted", "contact-43", { phone: "+919876543211" }, 1000);
  let now = 1000;
  let deliveryEntry;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await processPendingWebhookDeliveries(db, {
      now,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => ({ ok: false, status: 503 })
    });
    if (attempt < 8) assert.deepEqual(result, { delivered: 0, retried: 1, failed: 0 });
    else assert.deepEqual(result, { delivered: 0, retried: 0, failed: 1 });
    deliveryEntry = [...db.records.entries()].find(([path]) => path.startsWith("webhookDeliveryQueue/"));
    assert.equal(deliveryEntry[1].attempts, attempt);
    now = deliveryEntry[1].nextAttemptAt.getTime();
  }
  assert.equal(deliveryEntry[1].status, "failed");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});


test("accepts CRM lead lifecycle events as webhook subscription types", () => {
  const { normalizeWebhookInput } = require("../src/publicWebhooks");
  const result = normalizeWebhookInput({
    name: "CRM sync",
    url: "https://hooks.example.com/joy",
    events: ["lead.created", "lead.updated", "lead.deleted"]
  });
  assert.deepEqual(result.events, ["lead.created", "lead.updated", "lead.deleted"]);
});


test("rotates an active workspace webhook secret and refuses revoked or foreign subscriptions", async () => {
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  const { createOrganizationWebhook, rotateOrganizationWebhookSecret } = require("../src/publicWebhooks");
  const db = fakeDb();
  const created = await createOrganizationWebhook(db, "org_a", "owner_a", {
    name: "CRM sync", url: "https://hooks.example.com/joy", events: ["lead.created"]
  }, 1000);
  const rotated = await rotateOrganizationWebhookSecret(db, "org_a", created.webhook.id, 2000);
  assert.equal(rotated.id, created.webhook.id);
  assert.match(rotated.secret, /^joywhsec_/);
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(rotated.rotatedAt, new Date(2000).toISOString());
  await assert.rejects(() => rotateOrganizationWebhookSecret(db, "org_b", created.webhook.id), { statusCode: 404 });
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});


test("lists workspace-scoped webhook delivery history and replays only failed deliveries", async () => {
  const { listOrganizationWebhookDeliveries, replayOrganizationWebhookDelivery } = require("../src/publicWebhooks");
  const db = fakeDb();
  const deliveryId = "a".repeat(64);
  db.records.set("webhookDeliveryQueue/" + deliveryId, {
    organizationId: "org_a",
    subscriptionId: "sub_a",
    event: "lead.created",
    eventId: "lead-1",
    status: "failed",
    attempts: 8,
    lastError: "Endpoint returned HTTP 503.",
    createdAt: new Date("2026-11-24T10:00:00Z")
  });
  const listed = await listOrganizationWebhookDeliveries(db, "org_a", { limit: 20 });
  assert.equal(listed.deliveries.length, 1);
  assert.equal(listed.deliveries[0].event, "lead.created");
  assert.equal(listed.deliveries[0].status, "failed");
  assert.equal(listed.nextCursor, null);
  await assert.rejects(() => replayOrganizationWebhookDelivery(db, "org_b", deliveryId), { statusCode: 404 });
  const replayed = await replayOrganizationWebhookDelivery(db, "org_a", deliveryId, 2000);
  assert.deepEqual(replayed, { id: deliveryId, status: "pending" });
  const stored = db.records.get("webhookDeliveryQueue/" + deliveryId);
  assert.equal(stored.attempts, 0);
  assert.equal(stored.nextAttemptAt.getTime(), 2000);
  await assert.rejects(() => replayOrganizationWebhookDelivery(db, "org_a", deliveryId), { statusCode: 409 });
});


test("filters webhook deliveries and paginates with a stable cursor", async () => {
  const { listOrganizationWebhookDeliveries } = require("../src/publicWebhooks");
  const db = fakeDb();
  const base = Date.parse("2026-11-25T10:00:00Z");
  const rows = [
    ["1".repeat(64), "failed", "lead.created", 0],
    ["2".repeat(64), "delivered", "lead.created", 1],
    ["3".repeat(64), "failed", "message.read", 2],
    ["4".repeat(64), "failed", "lead.created", 3]
  ];
  for (const [id, status, event, offset] of rows) {
    db.records.set("webhookDeliveryQueue/" + id, {
      organizationId: "org_a", status, event, eventId: id, attempts: 1,
      createdAt: new Date(base + offset * 1000)
    });
  }
  db.records.set("webhookDeliveryQueue/" + "5".repeat(64), {
    organizationId: "org_b", status: "failed", event: "lead.created", createdAt: new Date(base + 4000)
  });
  const first = await listOrganizationWebhookDeliveries(db, "org_a", { status: "failed", event: "lead.created", limit: 1 });
  assert.equal(first.deliveries.length, 1);
  assert.ok(first.nextCursor);
  const second = await listOrganizationWebhookDeliveries(db, "org_a", { status: "failed", event: "lead.created", limit: 1, cursor: first.nextCursor });
  assert.equal(second.deliveries.length, 1);
  assert.notEqual(first.deliveries[0].id, second.deliveries[0].id);
  assert.equal(second.nextCursor, null);
  await assert.rejects(() => listOrganizationWebhookDeliveries(db, "org_a", { status: "invalid" }), { statusCode: 400 });
  await assert.rejects(() => listOrganizationWebhookDeliveries(db, "org_a", { cursor: "not-a-cursor" }), { statusCode: 400 });
});
