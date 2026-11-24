"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOrganizationApiKey,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  authenticateOrganizationApiKey,
  requireApiScope,
  listOrganizationApiUsage,
  runIdempotentApiRequest
} = require("../src/publicApi");

function fakeDb(seed = {}) {
  const records = new Map(Object.entries(seed));
  function doc(path) {
    return {
      id: path.split("/").pop(),
      path,
      async create(value) {
        if (records.has(path)) throw new Error("already exists");
        records.set(path, value);
      },
      async set(value, options = {}) {
        records.set(path, options.merge ? { ...(records.get(path) || {}), ...value } : value);
      },
      async delete() { records.delete(path); },
      async get() {
        const value = records.get(path);
        return { exists: Boolean(value), data: () => value };
      },
      collection(name) { return collection(path + "/" + name); }
    };
  }
  function collection(path) {
    return {
      doc(id) { return doc(path + "/" + id); },
      where(field, operator, value) {
        const filters = [{ field, operator, value }];
        const query = {
          where(nextField, nextOperator, nextValue) { filters.push({ field: nextField, operator: nextOperator, value: nextValue }); return query; },
          orderBy() { return query; },
          limit() { return query; },
          async get() {
            const prefix = path + "/";
            const docs = [...records.entries()]
              .filter(([key, data]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/") &&
                filters.every(filter => filter.operator === "==" ? data[filter.field] === filter.value :
                  filter.operator === ">=" ? data[filter.field] >= filter.value :
                  filter.operator === "<=" ? data[filter.field] <= filter.value : false))
              .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data }));
            return { docs };
          }
        };
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

test("creates a scoped API key once and stores only its SHA-256 hash", async () => {
  const db = fakeDb();
  const now = Date.parse("2026-11-24T10:00:00Z");
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "CRM integration",
    scopes: ["contacts:read", "contacts:write"],
    expiryDays: 30
  }, now);
  assert.match(created.apiKey, /^joy_live_[A-Za-z0-9_-]{40,64}$/);
  assert.equal(created.name, "CRM integration");
  assert.deepEqual(created.scopes, ["contacts:read", "contacts:write"]);
  assert.equal(Date.parse(created.expiresAt), now + 30 * 86400000);
  const stored = db.records.get("publicApiKeys/" + created.id);
  assert.ok(stored);
  assert.equal(stored.apiKey, undefined);
  assert.equal(stored.keyHash, undefined);
  assert.equal(stored.organizationId, "org_one");
  assert.equal(stored.createdBy, "owner_uid");
});

test("lists API key metadata without ever returning the secret", async () => {
  const db = fakeDb();
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Read contacts", scopes: ["contacts:read"]
  });
  const listed = await listOrganizationApiKeys(db, "org_one");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].apiKey, undefined);
  assert.equal(listed[0].keyPrefix, created.keyPrefix);
});

test("API key authentication derives workspace and scopes from the hashed key record", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Read contacts", scopes: ["contacts:read"]
  });
  const auth = await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey);
  assert.equal(auth.organizationId, "org_one");
  assert.deepEqual(auth.scopes, ["contacts:read"]);
  assert.equal(auth.keyId, created.id);
  assert.ok(db.records.get("publicApiKeys/" + created.id).lastUsedAt instanceof Date);
  requireApiScope(auth, "contacts:read");
  assert.throws(() => requireApiScope(auth, "contacts:write"), { statusCode: 403 });
});

test("rejects malformed, unknown, revoked, expired and inactive-workspace API keys", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  await assert.rejects(() => authenticateOrganizationApiKey(db, "Bearer not-a-key"), { statusCode: 401 });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Temporary", scopes: ["contacts:read"], expiryDays: 1
  }, 1000);
  await assert.rejects(
    () => authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, 86401000),
    { statusCode: 401 }
  );
  await revokeOrganizationApiKey(db, "org_one", created.id, 2000);
  await assert.rejects(
    () => authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, 3000),
    { statusCode: 401 }
  );
  const inactiveDb = fakeDb({ "organizations/org_inactive": { status: "suspended" } });
  const inactiveKey = await createOrganizationApiKey(inactiveDb, "org_inactive", "owner_uid", {
    name: "Inactive", scopes: ["contacts:read"]
  });
  await assert.rejects(
    () => authenticateOrganizationApiKey(inactiveDb, "Bearer " + inactiveKey.apiKey),
    { statusCode: 403 }
  );
});

test("API key revocation and listing are tenant-scoped", async () => {
  const db = fakeDb();
  const a = await createOrganizationApiKey(db, "org_a", "owner_a", { name: "A key", scopes: ["contacts:read"] });
  const b = await createOrganizationApiKey(db, "org_b", "owner_b", { name: "B key", scopes: ["contacts:read"] });
  await assert.rejects(() => revokeOrganizationApiKey(db, "org_a", b.id), { statusCode: 404 });
  await revokeOrganizationApiKey(db, "org_a", a.id);
  assert.equal((await listOrganizationApiKeys(db, "org_a"))[0].status, "revoked");
  assert.equal((await listOrganizationApiKeys(db, "org_b"))[0].status, "active");
});

test("rejects unknown scopes and invalid expiry values", async () => {
  const db = fakeDb();
  await assert.rejects(
    () => createOrganizationApiKey(db, "org_one", "owner_uid", { name: "Invalid", scopes: ["admin:*"] }),
    { statusCode: 400 }
  );
  await assert.rejects(
    () => createOrganizationApiKey(db, "org_one", "owner_uid", { name: "Invalid", scopes: ["contacts:read"], expiryDays: 999 }),
    { statusCode: 400 }
  );
});


test("enforces a per-key 60-request-per-minute limit", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Rate limited", scopes: ["contacts:read"]
  });
  const now = Date.parse("2026-11-24T12:00:00Z");
  for (let index = 0; index < 60; index += 1) {
    await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, now + index);
  }
  await assert.rejects(
    () => authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, now + 1000),
    { statusCode: 429 }
  );
  const nextMinute = await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, now + 60000);
  assert.equal(nextMinute.organizationId, "org_one");
});


test("records daily API request and rate-limit usage for each workspace key", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Analytics key", scopes: ["contacts:read"]
  });
  const now = Date.parse("2026-11-24T12:00:00Z");
  await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, now);
  const usagePath = `publicApiUsageDaily/${created.id}_20261124`;
  assert.equal(db.records.get(usagePath).requestCount, 1);
  assert.equal(db.records.get(usagePath).rateLimitedCount, 0);
  const usage = await listOrganizationApiUsage(db, "org_one", { days: 1, now });
  assert.deepEqual(usage.totals, { requests: 1, rateLimited: 0 });
  assert.equal(usage.daily[0].keyId, created.id);
  assert.equal(usage.daily[0].date, "20261124");
});

test("counts rate-limited API attempts in daily usage analytics", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Rate analytics", scopes: ["contacts:read"]
  });
  const now = Date.parse("2026-11-24T12:00:00Z");
  for (let index = 0; index < 60; index += 1) {
    await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, now + index);
  }
  await assert.rejects(() => authenticateOrganizationApiKey(db, "Bearer " + created.apiKey, now + 1000), { statusCode: 429 });
  const usage = await listOrganizationApiUsage(db, "org_one", { days: 1, now });
  assert.deepEqual(usage.totals, { requests: 61, rateLimited: 1 });
});

test("API usage analytics are tenant scoped and validate reporting windows", async () => {
  const db = fakeDb({
    "publicApiUsageDaily/key_a_20261124": { keyHash: "key_a", organizationId: "org_a", dateKey: "20261124", requestCount: 5, rateLimitedCount: 1 },
    "publicApiUsageDaily/key_b_20261124": { keyHash: "key_b", organizationId: "org_b", dateKey: "20261124", requestCount: 99, rateLimitedCount: 0 }
  });
  const usage = await listOrganizationApiUsage(db, "org_a", { days: 1, now: Date.parse("2026-11-24T12:00:00Z") });
  assert.equal(usage.totals.requests, 5);
  assert.equal(usage.daily.length, 1);
  await assert.rejects(() => listOrganizationApiUsage(db, "org_a", { days: 91 }), { statusCode: 400 });
});


test("idempotency returns the original result without repeating a mutation", async () => {
  const db = fakeDb();
  const auth = { keyId: "a".repeat(64), organizationId: "org_one" };
  let executions = 0;
  const operation = async () => ({ data: { id: "created_once" }, statusCode: 201 });
  const first = await runIdempotentApiRequest(db, auth, "request-123", { method: "POST", body: { name: "Alex" } }, async () => {
    executions += 1;
    return operation();
  }, 1000);
  const replay = await runIdempotentApiRequest(db, auth, "request-123", { method: "POST", body: { name: "Alex" } }, async () => {
    executions += 1;
    return operation();
  }, 2000);
  assert.equal(first.statusCode, 201);
  assert.equal(first.replayed, false);
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, { id: "created_once" });
  assert.equal(executions, 1);
});

test("idempotency rejects reuse with a different request and malformed keys", async () => {
  const db = fakeDb();
  const auth = { keyId: "b".repeat(64), organizationId: "org_one" };
  const request = { method: "POST", body: { name: "Alex" } };
  await runIdempotentApiRequest(db, auth, "request-456", request, async () => ({ data: { id: "one" }, statusCode: 201 }), 1000);
  await assert.rejects(
    () => runIdempotentApiRequest(db, auth, "request-456", { method: "POST", body: { name: "Sam" } }, async () => ({ data: { id: "two" } }), 2000),
    { statusCode: 409 }
  );
  await assert.rejects(
    () => runIdempotentApiRequest(db, auth, "bad", request, async () => ({}), 2000),
    { statusCode: 400 }
  );
});

test("idempotency reports an in-progress duplicate and releases failed reservations", async () => {
  const db = fakeDb();
  const auth = { keyId: "c".repeat(64), organizationId: "org_one" };
  const request = { method: "POST", body: { name: "Alex" } };
  await assert.rejects(
    () => runIdempotentApiRequest(db, auth, "request-789", request, async () => { throw new Error("upstream failed"); }, 1000),
    /upstream failed/
  );
  assert.equal(db.records.size, 0);
  const result = await runIdempotentApiRequest(db, auth, "request-789", request, async () => ({ data: { ok: true }, statusCode: 201 }), 2000);
  assert.equal(result.data.ok, true);
});


test("API keys accept the campaigns:read scope without granting campaign mutation", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Campaign reporting", scopes: ["campaigns:read"]
  });
  const auth = await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey);
  requireApiScope(auth, "campaigns:read");
  assert.throws(() => requireApiScope(auth, "messages:write"), { statusCode: 403 });
  assert.throws(() => requireApiScope(auth, "leads:write"), { statusCode: 403 });
});

test("campaigns:write permits draft creation scope without granting outbound message sends", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Campaign drafts", scopes: ["campaigns:write"]
  });
  const auth = await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey);
  requireApiScope(auth, "campaigns:write");
  assert.throws(() => requireApiScope(auth, "campaigns:read"), { statusCode: 403 });
  assert.throws(() => requireApiScope(auth, "messages:write"), { statusCode: 403 });
});

test("API key accepts the messages:write scope and rejects unknown message scopes", async () => {
  const db = fakeDb({ "organizations/org_one": { status: "active" } });
  const created = await createOrganizationApiKey(db, "org_one", "owner_uid", {
    name: "Messaging integration", scopes: ["messages:write", "templates:read"]
  });
  assert.deepEqual(created.scopes, ["messages:write", "templates:read"]);
  const auth = await authenticateOrganizationApiKey(db, "Bearer " + created.apiKey);
  assert.equal(auth.organizationId, "org_one");
});
