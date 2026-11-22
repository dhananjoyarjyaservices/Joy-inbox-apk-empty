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
  if (!org.exists || !member.exists || member.data().status !== "active" || !ROLES.has(member.data().role)) {
    throw httpError("You are not an active member of this organization.", 403);
  }
  return { ...org.data(), id: organizationId, ref: org.ref, memberRef, role: member.data().role, uid: decoded.uid };
}

function requirePermission(organization, permission) {
  if (!organization || !ROLE_PERMISSIONS[organization.role]?.has(permission)) throw httpError("Insufficient organization permissions.", 403);
}

function encryptSecret(plaintext, keyValue = process.env.TENANT_SECRET_ENCRYPTION_KEY) {
  if (!keyValue) throw new Error("TENANT_SECRET_ENCRYPTION_KEY is not configured.");
  const key = Buffer.from(keyValue, "base64");
  if (key.length !== 32) throw new Error("TENANT_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function decryptSecret(record, keyValue = process.env.TENANT_SECRET_ENCRYPTION_KEY) {
  if (!keyValue) throw new Error("TENANT_SECRET_ENCRYPTION_KEY is not configured.");
  const key = Buffer.from(keyValue, "base64");
  if (key.length !== 32 || record?.algorithm !== "aes-256-gcm" || record.version !== 1) throw new Error("Tenant secret format or encryption key is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function resolvePhoneNumberOrganization(db, phoneNumberId) {
  if (!validId(phoneNumberId)) throw httpError("Invalid WhatsApp phone number ID.", 400);
  const mapping = await db.collection("whatsappPhoneNumbers").doc(phoneNumberId).get();
  if (!mapping.exists || !validId(mapping.data().organizationId)) throw httpError("No organization is connected to this WhatsApp number.", 404);
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
    if (existing.exists && existing.data().organizationId !== organization.id) {
      throw httpError("This WhatsApp phone number is already connected to another organization.", 409);
    }
    transaction.set(settingsRef, {
      phoneNumberId,
      accessToken: encrypted,
      displayPhoneNumber,
      verifiedName,
      connected: true,
      updatedAt: new Date()
    }, { merge: true });
    transaction.set(phoneRef, {
      organizationId: organization.id,
      status: "active",
      updatedAt: new Date()
    }, { merge: true });
  });
  return { phoneNumberId, displayPhoneNumber, verifiedName, connected: true };
}

async function getWhatsAppCredentials(db, organizationId) {
  if (!validId(organizationId)) throw httpError("A valid organization ID is required.", 400);
  const snapshot = await db.collection("organizations").doc(organizationId)
    .collection("settings").doc("whatsapp").get();
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

module.exports = { ROLES, ROLE_PERMISSIONS, requireOrganization, requirePermission, encryptSecret, decryptSecret, resolvePhoneNumberOrganization, saveWhatsAppConnection, getWhatsAppCredentials };
