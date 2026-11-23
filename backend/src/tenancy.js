const crypto = require("crypto");

const ROLES = new Set(["owner", "admin", "agent"]);
const ROLE_PERMISSIONS = {
  owner: new Set(["members:manage", "settings:manage", "whatsapp:manage", "chats:read", "chats:manage", "messages:send", "contacts:manage", "quickReplies:manage"]),
  admin: new Set(["members:manage", "settings:manage", "whatsapp:manage", "chats:read", "chats:manage", "messages:send", "contacts:manage", "quickReplies:manage"]),
  agent: new Set(["chats:read", "chats:manage", "messages:send", "contacts:manage", "quickReplies:manage"])
};

function httpError(message, statusCode) { const error = new Error(message); error.statusCode = statusCode; return error; }
function validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

async function requireOrganization(db, decoded, organizationId) {
  if (!decoded?.uid) throw httpError("Authentication required.", 401);
  if (!validId(organizationId)) throw httpError("A valid organization ID is required.", 400);
  const memberRef = db.collection("organizations").doc(organizationId).collection("members").doc(decoded.uid);
  const [org, member] = await Promise.all([db.collection("organizations").doc(organizationId).get(), memberRef.get()]);
  if (!org.exists || org.data().status !== "active" || !member.exists || member.data().status !== "active" || !ROLES.has(member.data().role)) {
    throw httpError("You are not an active member of this organization.", 403);
  }
  return { ...org.data(), id: organizationId, ref: org.ref, memberRef, role: member.data().role, uid: decoded.uid };
}

function requirePermission(organization, permission) {
  if (!organization || !ROLE_PERMISSIONS[organization.role]?.has(permission)) throw httpError("Insufficient organization permissions.", 403);
}

function decodeEncryptionKey(value, label = "encryption key") {
  if (typeof value !== "string" || !value) throw new Error(`Tenant secret ${label} is not configured.`);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(`Tenant secret ${label} must be a base64-encoded 32-byte key.`);
  }
  return key;
}

function parseEncryptionKeyring(value = process.env.TENANT_SECRET_ENCRYPTION_KEYRING) {
  if (!value) return null;
  let config;
  try { config = JSON.parse(value); }
  catch { throw new Error("TENANT_SECRET_ENCRYPTION_KEYRING must be valid JSON."); }
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.activeKeyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(config.activeKeyId) ||
      !config.keys || typeof config.keys !== "object" || Array.isArray(config.keys)) {
    throw new Error("Tenant secret keyring configuration is invalid.");
  }
  const keys = {};
  for (const [keyId, encoded] of Object.entries(config.keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new Error("Tenant secret keyring contains an invalid key ID.");
    keys[keyId] = decodeEncryptionKey(encoded, `key ${keyId}`);
  }
  if (!keys[config.activeKeyId]) throw new Error("Tenant secret keyring activeKeyId is not present in keys.");
  return { activeKeyId: config.activeKeyId, keys };
}

function encryptWithKey(plaintext, key, keyId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return {
    version: 2,
    algorithm: "aes-256-gcm",
    keyId,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function encryptSecret(plaintext, keyValue) {
  if (arguments.length > 1) {
    return encryptWithKey(plaintext, decodeEncryptionKey(keyValue), "default");
  }
  const keyring = parseEncryptionKeyring();
  if (keyring) return encryptWithKey(plaintext, keyring.keys[keyring.activeKeyId], keyring.activeKeyId);
  return encryptWithKey(plaintext, decodeEncryptionKey(process.env.TENANT_SECRET_ENCRYPTION_KEY), "default");
}

function decryptWithKey(record, key) {
  if (!record || record.algorithm !== "aes-256-gcm" ||
      typeof record.iv !== "string" || typeof record.tag !== "string" ||
      typeof record.ciphertext !== "string") {
    throw new Error("Tenant secret format or encryption key is invalid.");
  }
  const iv = Buffer.from(record.iv, "base64");
  const tag = Buffer.from(record.tag, "base64");
  const ciphertext = Buffer.from(record.ciphertext, "base64");
  if (iv.length !== 12 || tag.length !== 16 ||
      iv.toString("base64") !== record.iv || tag.toString("base64") !== record.tag ||
      ciphertext.toString("base64") !== record.ciphertext) {
    throw new Error("Tenant secret format or encryption key is invalid.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function decryptSecret(record, keyValue) {
  if (!record || ![1, 2].includes(record.version)) {
    throw new Error("Tenant secret format or encryption key is invalid.");
  }
  if (record.version === 1) {
    const legacyValue = arguments.length > 1 ? keyValue : process.env.TENANT_SECRET_ENCRYPTION_KEY;
    return decryptWithKey(record, decodeEncryptionKey(legacyValue));
  }
  if (arguments.length > 1) {
    return decryptWithKey(record, decodeEncryptionKey(keyValue));
  }
  const keyring = parseEncryptionKeyring();
  if (keyring) {
    const key = keyring.keys[record.keyId];
    if (!key) throw new Error(`Tenant secret encryption key "${String(record.keyId || "unknown")}" is unavailable.`);
    return decryptWithKey(record, key);
  }
  if (record.keyId !== "default") {
    throw new Error(`Tenant secret encryption key "${String(record.keyId)}" is unavailable.`);
  }
  return decryptWithKey(record, decodeEncryptionKey(process.env.TENANT_SECRET_ENCRYPTION_KEY));
}

function rotateEncryptedSecret(record, options = {}) {
  const plaintext = options.sourceKeyValue === undefined
    ? decryptSecret(record)
    : decryptSecret(record, options.sourceKeyValue);
  if (typeof options.targetKeyring === "string") {
    const target = parseEncryptionKeyring(options.targetKeyring);
    return encryptWithKey(plaintext, target.keys[target.activeKeyId], target.activeKeyId);
  }
  if (options.targetKeyring && typeof options.targetKeyring === "object") {
    const { activeKeyId, keys } = options.targetKeyring;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(activeKeyId || "") || !keys || !keys[activeKeyId]) {
      throw new Error("Target tenant secret keyring is invalid.");
    }
    const key = Buffer.isBuffer(keys[activeKeyId]) ? keys[activeKeyId] : decodeEncryptionKey(keys[activeKeyId], `key ${activeKeyId}`);
    if (key.length !== 32) throw new Error("Target tenant secret key must contain 32 bytes.");
    return encryptWithKey(plaintext, key, activeKeyId);
  }
  throw new Error("A target tenant secret keyring is required for rotation.");
}

async function resolvePhoneNumberOrganization(db, phoneNumberId) {
  if (!validId(phoneNumberId)) throw httpError("Invalid WhatsApp phone number ID.", 400);
  const mapping = await db.collection("whatsappPhoneNumbers").doc(phoneNumberId).get();
  if (!mapping.exists || mapping.data().status !== "active" || !validId(mapping.data().organizationId)) throw httpError("No active organization is connected to this WhatsApp number.", 404);
  return requireOrganizationForWebhook(db, mapping.data().organizationId);
}

async function requireOrganizationForWebhook(db, organizationId) {
  const ref = db.collection("organizations").doc(organizationId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== "active") throw httpError("WhatsApp organization is inactive.", 403);
  return { id: organizationId, ref, ...snap.data() };
}


async function saveWhatsAppConnection(db, organization, input) {
  if (!organization?.id || !organization.ref) throw httpError("Organization context is required.", 400);
  const phoneNumberId = String(input?.phoneNumberId || "").trim();
  const accessToken = String(input?.accessToken || "").trim();
  const displayPhoneNumber = String(input?.displayPhoneNumber || "").trim().slice(0, 40);
  const verifiedName = String(input?.verifiedName || "").trim().slice(0, 100);
  if (!validId(phoneNumberId) || !/^EAA[A-Za-z0-9_-]+$/.test(accessToken) || accessToken.length > 4096) {
    throw httpError("A valid WhatsApp Phone Number ID and access token are required.", 400);
  }
  const encrypted = encryptSecret(accessToken);
  const phoneRef = db.collection("whatsappPhoneNumbers").doc(phoneNumberId);
  const settingsRef = organization.ref.collection("settings").doc("whatsapp");
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(phoneRef);
    if (existing.exists && existing.data().status !== "disconnected" && existing.data().organizationId !== organization.id) {
      throw httpError("This WhatsApp phone number is already connected to another organization.", 409);
    }
    const connectionData = {
      phoneNumberId,
      accessToken: encrypted,
      displayPhoneNumber,
      verifiedName,
      connected: true,
      updatedAt: new Date()
    };
    // Keep the legacy primary connection while maintaining an independent
    // encrypted credential record for every connected phone number.
    transaction.set(settingsRef.collection("numbers").doc(phoneNumberId), connectionData, { merge: true });
    transaction.set(settingsRef, connectionData, { merge: true });
    transaction.set(phoneRef, {
      organizationId: organization.id,
      status: "active",
      updatedAt: new Date()
    }, { merge: true });
  });
  return { phoneNumberId, displayPhoneNumber, verifiedName, connected: true };
}


async function disconnectWhatsAppConnection(db, organization, phoneNumberId) {
  if (!organization?.id || !organization.ref) throw httpError("Organization context is required.", 400);
  if (!validId(phoneNumberId)) throw httpError("A valid WhatsApp Phone Number ID is required.", 400);
  const settingsRef = organization.ref.collection("settings").doc("whatsapp");
  const numberRef = settingsRef.collection("numbers").doc(phoneNumberId);
  const mappingRef = db.collection("whatsappPhoneNumbers").doc(phoneNumberId);
  await db.runTransaction(async (transaction) => {
    const [numberSnapshot, legacySnapshot, mappingSnapshot] = await Promise.all([
      transaction.get(numberRef), transaction.get(settingsRef), transaction.get(mappingRef)
    ]);
    const numberData = numberSnapshot.exists ? numberSnapshot.data() : null;
    const legacyData = legacySnapshot.exists ? legacySnapshot.data() : null;
    const ownsMapping = mappingSnapshot.exists && mappingSnapshot.data().organizationId === organization.id;
    if ((!numberData || numberData.connected !== true) &&
        !(legacyData?.phoneNumberId === phoneNumberId && legacyData.connected === true)) {
      throw httpError("This WhatsApp number is not connected to this workspace.", 404);
    }
    if (numberSnapshot.exists) transaction.set(numberRef, { connected: false, disconnectedAt: new Date(), updatedAt: new Date() }, { merge: true });
    if (legacyData?.phoneNumberId === phoneNumberId) {
      transaction.set(settingsRef, { connected: false, disconnectedAt: new Date(), updatedAt: new Date() }, { merge: true });
    }
    if (ownsMapping) transaction.set(mappingRef, { status: "disconnected", updatedAt: new Date() }, { merge: true });
  });
  return { phoneNumberId, connected: false };
}

async function getWhatsAppCredentials(db, organizationId, phoneNumberId) {
  if (!validId(organizationId)) throw httpError("A valid organization ID is required.", 400);
  const settingsRef = db.collection("organizations").doc(organizationId).collection("settings").doc("whatsapp");
  const snapshot = phoneNumberId
    ? await settingsRef.collection("numbers").doc(phoneNumberId).get()
    : await settingsRef.get();
  if (!snapshot.exists || snapshot.data().connected !== true) {
    throw httpError("WhatsApp is not connected for this organization.", 404);
  }
  const data = snapshot.data();
  return {
    phoneNumberId: data.phoneNumberId,
    accessToken: decryptSecret(data.accessToken),
    displayPhoneNumber: data.displayPhoneNumber || "",
    verifiedName: data.verifiedName || ""
  };
}

async function listWhatsAppConnections(db, organizationId) {
  if (!validId(organizationId)) throw httpError("A valid organization ID is required.", 400);
  const snapshot = await db.collection("organizations").doc(organizationId)
    .collection("settings").doc("whatsapp").collection("numbers").get();
  const items = snapshot.docs.map((item) => {
    const data = item.data();
    return {
      phoneNumberId: item.id,
      displayPhoneNumber: data.displayPhoneNumber || "",
      verifiedName: data.verifiedName || "",
      connected: data.connected === true,
      updatedAt: data.updatedAt || null
    };
  });
  if (!items.length) {
    const legacy = await db.collection("organizations").doc(organizationId)
      .collection("settings").doc("whatsapp").get();
    if (legacy.exists && legacy.data().connected === true) {
      const data = legacy.data();
      items.push({
        phoneNumberId: data.phoneNumberId,
        displayPhoneNumber: data.displayPhoneNumber || "",
        verifiedName: data.verifiedName || "",
        connected: true,
        updatedAt: data.updatedAt || null
      });
    }
  }
  return items;
}

module.exports = { ROLES, ROLE_PERMISSIONS, requireOrganization, requirePermission, encryptSecret, decryptSecret, parseEncryptionKeyring, rotateEncryptedSecret, resolvePhoneNumberOrganization, saveWhatsAppConnection, disconnectWhatsAppConnection, getWhatsAppCredentials, listWhatsAppConnections };
