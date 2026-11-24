"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOrganizationApiKey,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  authenticateOrganizationApiKey,
  requireApiScope
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
        assert.equal(operator, "==");
        const query = {
          orderBy() { return query; },
          limit() { return query; },
          async get() {
            const prefix = path + "/";
            const docs = [...records.entries()]
              .filter(([key, data]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/") && data[field] === value)
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
