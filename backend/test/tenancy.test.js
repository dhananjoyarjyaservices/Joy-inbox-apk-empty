const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptSecret, decryptSecret, rotateEncryptedSecret, parseEncryptionKeyring, requireOrganization, requirePermission, ROLE_PERMISSIONS, saveWhatsAppConnection, disconnectWhatsAppConnection, getWhatsAppCredentials, listWhatsAppConnections, resolvePhoneNumberOrganization } = require("../src/tenancy");

test("tenant WhatsApp credentials encrypt and decrypt with authenticated encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptSecret("EAA_test_token", key);
  assert.notEqual(encrypted.ciphertext, Buffer.from("EAA_test_token").toString("base64"));
  assert.equal(decryptSecret(encrypted, key), "EAA_test_token");
  assert.throws(() => decryptSecret(encrypted, Buffer.alloc(32, 8).toString("base64")));
});

test("agent role cannot manage organization membership or WhatsApp settings", () => {
  const agent = { role: "agent" };
  assert.equal(ROLE_PERMISSIONS.agent.has("chats:read"), true);
  assert.throws(() => requirePermission(agent, "members:manage"), { statusCode: 403 });
  assert.throws(() => requirePermission(agent, "whatsapp:manage"), { statusCode: 403 });
});

test("role permission matrix denies unknown and privileged permissions to agents", () => {
  const permissions = [
    "members:manage", "settings:manage", "whatsapp:manage",
    "chats:read", "chats:manage", "messages:send",
    "contacts:manage", "quickReplies:manage"
  ];
  for (const permission of permissions) {
    assert.equal(ROLE_PERMISSIONS.owner.has(permission), true, "owner: " + permission);
    assert.equal(ROLE_PERMISSIONS.admin.has(permission), true, "admin: " + permission);
    assert.equal(ROLE_PERMISSIONS.agent.has(permission), [
      "chats:read", "chats:manage", "messages:send", "contacts:manage", "quickReplies:manage"
    ].includes(permission), "agent: " + permission);
  }
  for (const role of ["owner", "admin", "agent", "unknown", undefined]) {
    assert.throws(() => requirePermission({ role }, "system:root"), { statusCode: 403 });
  }
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
    return {
      doc(id) { return doc(path + "/" + id); },
      async get() {
        const prefix = path + "/";
        const docsList = [...docs.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, value]) => ({ id: key.slice(prefix.length), exists: true, data: () => value }));
        return { docs: docsList };
      }
    };
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
      const result = await callback(tx);
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    }
  };
}

test("WhatsApp credentials are encrypted and mapped to exactly one tenant", async () => {
  const db = fakeTenantDb();
  db.docs.set("organizations/org_test", { status: "active" });
  const key = Buffer.alloc(32, 9).toString("base64");
  process.env.TENANT_SECRET_ENCRYPTION_KEY = key;
  const orgRef = db.collection("organizations").doc("org_test");
  const organization = { id: "org_test", ref: orgRef };
  const connection = await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "123456789012345",
    accessToken: "EAA_example_secret_token",
    displayPhoneNumber: "+1 555 0100",
    verifiedName: "Test Business"
  });
  assert.equal(connection.connected, true);
  const stored = db.docs.get("organizations/org_test/settings/whatsapp");
  assert.notEqual(stored.accessToken.ciphertext, Buffer.from("EAA_example_secret_token").toString("base64"));
  const credentials = await getWhatsAppCredentials(db, "org_test");
  assert.equal(credentials.accessToken, "EAA_example_secret_token");
  const numberCredentials = await getWhatsAppCredentials(db, "org_test", "123456789012345");
  assert.equal(numberCredentials.accessToken, "EAA_example_secret_token");
  assert.equal(numberCredentials.phoneNumberId, "123456789012345");
  const mapped = await resolvePhoneNumberOrganization(db, "123456789012345");
  assert.equal(mapped.id, "org_test");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("WhatsApp number cannot be claimed by a second organization", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  await saveWhatsAppConnection(db, { id: "org_a", ref: db.collection("organizations").doc("org_a") }, {
    phoneNumberId: "123456789012345",
    accessToken: "EAA_first_token"
  });
  await assert.rejects(() => saveWhatsAppConnection(db, {
    id: "org_b", ref: db.collection("organizations").doc("org_b")
  }, { phoneNumberId: "123456789012345", accessToken: "EAA_second_token" }), { statusCode: 409 });
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});


test("organization access requires an active membership with a recognized role", async () => {
  const db = fakeTenantDb();
  db.docs.set("organizations/org_access", { status: "active" });
  db.docs.set("organizations/org_inactive", { status: "suspended" });
  db.docs.set("organizations/org_inactive/members/user_active", { status: "active", role: "owner" });
  db.docs.set("organizations/org_access/members/user_active", { status: "active", role: "agent" });
  db.docs.set("organizations/org_access/members/user_disabled", { status: "disabled", role: "admin" });
  db.docs.set("organizations/org_access/members/user_unknown", { status: "active", role: "superuser" });

  const access = await requireOrganization(db, { uid: "user_active" }, "org_access");
  assert.equal(access.id, "org_access");
  assert.equal(access.role, "agent");

  await assert.rejects(
    () => requireOrganization(db, { uid: "user_disabled" }, "org_access"),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => requireOrganization(db, { uid: "user_unknown" }, "org_access"),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => requireOrganization(db, { uid: "user_missing" }, "org_access"),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => requireOrganization(db, { uid: "user_active" }, "org_inactive"),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => requireOrganization(db, { uid: "user_active" }, "../other"),
    { statusCode: 400 }
  );
});


test("multiple WhatsApp numbers keep separate credentials and tenant mappings", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  db.docs.set("organizations/org_multi", { status: "active" });
  const organization = { id: "org_multi", ref: db.collection("organizations").doc("org_multi") };
  await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "111111111111111",
    accessToken: "EAA_first_number_token",
    displayPhoneNumber: "+1 555 0101"
  });
  await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "222222222222222",
    accessToken: "EAA_second_number_token",
    displayPhoneNumber: "+1 555 0102"
  });
  const first = await getWhatsAppCredentials(db, "org_multi", "111111111111111");
  const second = await getWhatsAppCredentials(db, "org_multi", "222222222222222");
  assert.equal(first.accessToken, "EAA_first_number_token");
  assert.equal(second.accessToken, "EAA_second_number_token");
  assert.notEqual(first.phoneNumberId, second.phoneNumberId);
  const connections = await listWhatsAppConnections(db, "org_multi");
  assert.equal(connections.length, 2);
  assert.deepEqual(connections.map(item => item.phoneNumberId).sort(), ["111111111111111", "222222222222222"]);
  assert.equal((await resolvePhoneNumberOrganization(db, "111111111111111")).id, "org_multi");
  assert.equal((await resolvePhoneNumberOrganization(db, "222222222222222")).id, "org_multi");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("disconnect marks only the selected WhatsApp number inactive and preserves credentials", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
  db.docs.set("organizations/org_disconnect", { status: "active" });
  const organization = { id: "org_disconnect", ref: db.collection("organizations").doc("org_disconnect") };
  await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "333333333333333",
    accessToken: "EAA_keep_this_token"
  });
  await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "444444444444444",
    accessToken: "EAA_other_token"
  });
  const result = await disconnectWhatsAppConnection(db, organization, "333333333333333");
  assert.deepEqual(result, { phoneNumberId: "333333333333333", connected: false });
  await assert.rejects(
    () => getWhatsAppCredentials(db, "org_disconnect", "333333333333333"),
    { statusCode: 404 }
  );
  assert.equal((await getWhatsAppCredentials(db, "org_disconnect", "444444444444444")).accessToken, "EAA_other_token");
  const stored = db.docs.get("organizations/org_disconnect/settings/whatsapp/numbers/333333333333333");
  assert.equal(stored.connected, false);
  assert.ok(stored.accessToken);
  assert.equal(db.docs.get("whatsappPhoneNumbers/333333333333333").status, "disconnected");
  assert.equal(db.docs.get("whatsappPhoneNumbers/444444444444444").status, "active");
  await assert.rejects(
    () => resolvePhoneNumberOrganization(db, "333333333333333"),
    { statusCode: 404 }
  );
  assert.equal((await resolvePhoneNumberOrganization(db, "444444444444444")).id, "org_disconnect");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("legacy WhatsApp credential lookup falls back to a remaining connected number after primary disconnect", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 44).toString("base64");
  db.docs.set("organizations/org_primary_fallback", { status: "active" });
  const organization = {
    id: "org_primary_fallback",
    ref: db.collection("organizations").doc("org_primary_fallback")
  };
  await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "777777777777771",
    accessToken: "EAA_first_active_number"
  });
  await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "777777777777772",
    accessToken: "EAA_second_primary_number"
  });
  await disconnectWhatsAppConnection(db, organization, "777777777777772");

  const fallback = await getWhatsAppCredentials(db, "org_primary_fallback");
  assert.equal(fallback.phoneNumberId, "777777777777771");
  assert.equal(fallback.accessToken, "EAA_first_active_number");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("a workspace cannot disconnect another workspace's WhatsApp number", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
  const owner = { id: "org_owner", ref: db.collection("organizations").doc("org_owner") };
  const other = { id: "org_other", ref: db.collection("organizations").doc("org_other") };
  await saveWhatsAppConnection(db, owner, {
    phoneNumberId: "555555555555555",
    accessToken: "EAA_owner_token"
  });
  await assert.rejects(
    () => disconnectWhatsAppConnection(db, other, "555555555555555"),
    { statusCode: 404 }
  );
  assert.equal((await getWhatsAppCredentials(db, "org_owner", "555555555555555")).accessToken, "EAA_owner_token");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});

test("a disconnected WhatsApp number can be connected to a different organization", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
  db.docs.set("organizations/org_first", { status: "active" });
  db.docs.set("organizations/org_second", { status: "active" });
  const first = { id: "org_first", ref: db.collection("organizations").doc("org_first") };
  const second = { id: "org_second", ref: db.collection("organizations").doc("org_second") };
  await saveWhatsAppConnection(db, first, {
    phoneNumberId: "666666666666666",
    accessToken: "EAA_first_org_token"
  });
  await disconnectWhatsAppConnection(db, first, "666666666666666");
  await saveWhatsAppConnection(db, second, {
    phoneNumberId: "666666666666666",
    accessToken: "EAA_second_org_token"
  });
  assert.equal((await resolvePhoneNumberOrganization(db, "666666666666666")).id, "org_second");
  assert.equal((await getWhatsAppCredentials(db, "org_second", "666666666666666")).accessToken, "EAA_second_org_token");
  await assert.rejects(
    () => getWhatsAppCredentials(db, "org_first", "666666666666666"),
    { statusCode: 404 }
  );
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});


test("a member of one organization cannot authenticate against another organization ID", async () => {
  const db = fakeTenantDb();
  db.docs.set("organizations/org_alpha", { status: "active" });
  db.docs.set("organizations/org_beta", { status: "active" });
  db.docs.set("organizations/org_alpha/members/shared_user", { status: "active", role: "owner" });
  const ownWorkspace = await requireOrganization(db, { uid: "shared_user" }, "org_alpha");
  assert.equal(ownWorkspace.id, "org_alpha");
  await assert.rejects(
    () => requireOrganization(db, { uid: "shared_user" }, "org_beta"),
    { statusCode: 403 }
  );
});

test("tenant authentication rejects organization IDs containing path traversal or invalid characters", async () => {
  const db = fakeTenantDb();
  await assert.rejects(
    () => requireOrganization(db, { uid: "shared_user" }, "org_alpha/../org_beta"),
    { statusCode: 400 }
  );
  await assert.rejects(
    () => requireOrganization(db, { uid: "shared_user" }, "org alpha"),
    { statusCode: 400 }
  );
});


test("legacy version 1 tenant secrets remain readable during key rotation", () => {
  const oldKey = Buffer.alloc(32, 21).toString("base64");
  const current = encryptSecret("EAA_legacy_token", oldKey);
  const legacyRecord = { ...current, version: 1 };
  delete legacyRecord.keyId;
  assert.equal(decryptSecret(legacyRecord, oldKey), "EAA_legacy_token");
});

test("keyring encryption uses the active key ID and can decrypt retained old keys", () => {
  const oldKey = Buffer.alloc(32, 22).toString("base64");
  const newKey = Buffer.alloc(32, 23).toString("base64");
  process.env.TENANT_SECRET_ENCRYPTION_KEYRING = JSON.stringify({
    activeKeyId: "key_2026",
    keys: { key_2025: oldKey, key_2026: newKey }
  });
  const encrypted = encryptSecret("EAA_keyring_token");
  assert.equal(encrypted.version, 2);
  assert.equal(encrypted.keyId, "key_2026");
  assert.equal(decryptSecret(encrypted), "EAA_keyring_token");
  const oldEncrypted = encryptSecret("EAA_old_key_token", oldKey);
  oldEncrypted.version = 2;
  oldEncrypted.keyId = "key_2025";
  assert.equal(decryptSecret(oldEncrypted), "EAA_old_key_token");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEYRING;
});

test("rotation helper re-encrypts a legacy secret with the target active key", () => {
  const oldKey = Buffer.alloc(32, 24).toString("base64");
  const newKey = Buffer.alloc(32, 25).toString("base64");
  const encrypted = encryptSecret("EAA_rotate_me", oldKey);
  const rotated = rotateEncryptedSecret(encrypted, {
    sourceKeyValue: oldKey,
    targetKeyring: {
      activeKeyId: "key_next",
      keys: { key_next: newKey }
    }
  });
  assert.equal(rotated.version, 2);
  assert.equal(rotated.keyId, "key_next");
  assert.equal(decryptSecret(rotated, newKey), "EAA_rotate_me");
  assert.notEqual(rotated.ciphertext, encrypted.ciphertext);
});

test("invalid keyrings and missing rotation keys fail closed", () => {
  assert.throws(() => parseEncryptionKeyring("{bad json"));
  assert.throws(() => parseEncryptionKeyring(JSON.stringify({
    activeKeyId: "missing", keys: { other: Buffer.alloc(32, 1).toString("base64") }
  })));
  assert.throws(() => rotateEncryptedSecret({}, { targetKeyring: {} }));
});


test("tenant credential migration defaults to dry-run and rotates legacy and per-number records", async () => {
  const db = fakeTenantDb();
  const oldKey = Buffer.alloc(32, 31).toString("base64");
  const newKey = Buffer.alloc(32, 32).toString("base64");
  const targetKeyring = {
    activeKeyId: "rotation_2026",
    keys: { rotation_2026: Buffer.from(newKey, "base64") }
  };
  process.env.TENANT_SECRET_ENCRYPTION_KEYRING = JSON.stringify({
    activeKeyId: "legacy_2025",
    keys: { legacy_2025: oldKey }
  });
  db.docs.set("organizations/org_rotate", { status: "active" });
  const legacySecret = encryptSecret("EAA_legacy_primary");
  const numberSecret = encryptSecret("EAA_number_specific");
  db.docs.set("organizations/org_rotate/settings/whatsapp", {
    phoneNumberId: "777777777777777", connected: true, accessToken: legacySecret
  });
  db.docs.set("organizations/org_rotate/settings/whatsapp/numbers/777777777777777", {
    phoneNumberId: "777777777777777", connected: true, accessToken: numberSecret
  });

  const { rotateOrganizationWhatsAppCredentials } = require("../src/tenancy");
  const preview = await rotateOrganizationWhatsAppCredentials(db, "org_rotate", targetKeyring);
  assert.deepEqual(
    { dryRun: preview.dryRun, scanned: preview.scanned, rotated: preview.rotated, failed: preview.failed },
    { dryRun: true, scanned: 2, rotated: 2, failed: 0 }
  );
  assert.equal(db.docs.get("organizations/org_rotate/settings/whatsapp").accessToken.keyId, "legacy_2025");

  const migrated = await rotateOrganizationWhatsAppCredentials(db, "org_rotate", targetKeyring, { dryRun: false });
  assert.equal(migrated.rotated, 2);
  assert.equal(migrated.failed, 0);
  const rootRecord = db.docs.get("organizations/org_rotate/settings/whatsapp").accessToken;
  const numberRecord = db.docs.get("organizations/org_rotate/settings/whatsapp/numbers/777777777777777").accessToken;
  assert.equal(rootRecord.keyId, "rotation_2026");
  assert.equal(numberRecord.keyId, "rotation_2026");
  assert.equal(decryptSecret(rootRecord, newKey), "EAA_legacy_primary");
  assert.equal(decryptSecret(numberRecord, newKey), "EAA_number_specific");
  assert.equal(JSON.stringify([...db.docs.values()]).includes("EAA_legacy_primary"), false);

  const secondPass = await rotateOrganizationWhatsAppCredentials(db, "org_rotate", targetKeyring, { dryRun: false });
  assert.equal(secondPass.rotated, 0);
  assert.equal(secondPass.alreadyCurrent, 2);
  delete process.env.TENANT_SECRET_ENCRYPTION_KEYRING;
});

test("tenant credential migration rejects invalid tenant IDs and missing organizations", async () => {
  const db = fakeTenantDb();
  const { rotateOrganizationWhatsAppCredentials } = require("../src/tenancy");
  await assert.rejects(
    () => rotateOrganizationWhatsAppCredentials(db, "../invalid", { activeKeyId: "new", keys: { new: Buffer.alloc(32) } }),
    { statusCode: 400 }
  );
  await assert.rejects(
    () => rotateOrganizationWhatsAppCredentials(db, "missing_org", { activeKeyId: "new", keys: { new: Buffer.alloc(32) } }),
    { statusCode: 404 }
  );
});


test("WhatsApp phone number IDs must be numeric and bounded at credential boundaries", async () => {
  const db = fakeTenantDb();
  for (const phoneNumberId of ["abcde", "1234", "123456789012345678901234567890123"]) {
    await assert.rejects(
      () => getWhatsAppCredentials(db, "org_valid", phoneNumberId),
      { statusCode: 400 }
    );
    await assert.rejects(
      () => resolvePhoneNumberOrganization(db, phoneNumberId),
      { statusCode: 400 }
    );
  }
});


test("Embedded Signup stores the WABA ID and encrypts the generated two-step registration PIN", async () => {
  const db = fakeTenantDb();
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  const organization = { id: "org_embedded", ref: db.collection("organizations").doc("org_embedded") };
  await saveWhatsAppConnection(db, organization, {
    phoneNumberId: "555555555555555",
    wabaId: "666666666666666",
    accessToken: "EAA_embedded_signup_business_token",
    registrationPin: "042731",
    displayPhoneNumber: "+91 98765 43210",
    verifiedName: "Embedded Signup Business"
  });
  const stored = db.docs.get("organizations/org_embedded/settings/whatsapp/numbers/555555555555555");
  assert.equal(stored.wabaId, "666666666666666");
  assert.notEqual(stored.registrationPin.ciphertext, Buffer.from("042731").toString("base64"));
  const credentials = await getWhatsAppCredentials(db, "org_embedded", "555555555555555");
  assert.equal(credentials.wabaId, "666666666666666");
  assert.equal(credentials.registrationPin, "042731");
  const connections = await listWhatsAppConnections(db, "org_embedded");
  assert.equal(connections[0].wabaId, "666666666666666");
  delete process.env.TENANT_SECRET_ENCRYPTION_KEY;
});
