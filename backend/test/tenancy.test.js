const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptSecret, decryptSecret, requirePermission, ROLE_PERMISSIONS, saveWhatsAppConnection, getWhatsAppCredentials, resolvePhoneNumberOrganization } = require("../src/tenancy");

test("tenant WhatsApp credentials encrypt and decrypt with authenticated encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptSecret("EAA-test-token", key);
  assert.notEqual(encrypted.ciphertext, Buffer.from("EAA-test-token").toString("base64"));
  assert.equal(decryptSecret(encrypted, key), "EAA-test-token");
  assert.throws(() => decryptSecret(encrypted, Buffer.alloc(32, 8).toString("base64")));
});

test("agent role cannot manage organization membership or WhatsApp settings", () => {
  const agent = { role: "agent" };
  assert.equal(ROLE_PERMISSIONS.agent.has("chats:read"), true);
  assert.throws(() => requirePermission(agent, "members:manage"), { statusCode: 403 });
  assert.throws(() => requirePermission(agent, "whatsapp:manage"), { statusCode: 403 });
});

test("owner role can manage organization settings", () => {
  assert.doesNotThrow(() => requirePermission({ role: "owner" }, "settings:manage"));
});

function fakeTenantDb() {
  const docs = new Map();
  function doc(path) {
    return {
      path,
      collection(name) { return collection(path + "/" + name); },
      async get() { const value = docs.get(path); return { exists: Boolean(value), data: () => value, ref: this }; }
    };
  }
  function collection(path) {
    return { doc(id) { return doc(path + "/" + id); } };
  }
  return {
    docs,
    collection,
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        async get(reference) {
          const value = docs.get(reference.path);
          return { exists: Boolean(value), data: () => value };
        },
        set(reference, value, options) {
          writes.push([reference.path, options ? { ...(docs.get(reference.path) || {}), ...value } : value]);
        }
      };
      await callback(tx);
      for (const [path, value] of writes) docs.set(path, value);
    }
  };
}

test("WhatsApp credentials are encrypted and mapped to exactly one tenant", async () => {
  const db = fakeTenantDb();
  const key = Buffer.alloc(32, 9).toString("base64");
  process.env.TENANT_SECRET_ENCRYPTION_KEY = key;
  const orgRef = db.collection("organizations").doc("org_test");
  const organization = { id: "org_test", ref: orgRef };
  const connection = await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "123456789012345",
    accessToken: "EAA-example-secret-token",
    displayPhoneNumber: "+1 555 0100",
    verifiedName: "Test Business"
  });
  assert.equal(connection.connected, true);
  const stored = db.docs.get("organizations/org_test/settings/whatsapp");
  assert.notEqual(stored.accessToken.ciphertext, Buffer.from("EAA-example-secret-token").toString("base64"));
  const credentials = await getWhatsAppCredentials(db, "org_test");
  assert.equal(credentials.accessToken, "EAA-example-secret-token");
  const mapped = await resolvePhoneNumberOrganization(db, "123456789012345");
  assert.equal(mapped.id, "org_test");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("WhatsApp number cannot be claimed by a second organization", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  await saveWhatsAppConnection(db, { id: "org_a", ref: db.collection("organizations").doc("org_a") }, {
    phoneNumberId: "123456789012345",
    accessToken: "EAA-first-token"
  });
  await assert.rejects(() => saveWhatsAppConnection(db, {
    id: "org_b", ref: db.collection("organizations").doc("org_b")
  }, { phoneNumberId: "123456789012345", accessToken: "EAA-second-token" }), { statusCode: 409 });
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});
