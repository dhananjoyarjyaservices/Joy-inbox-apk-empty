const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptSecret, decryptSecret, requirePermission, ROLE_PERMISSIONS } = require("../src/tenancy");

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
