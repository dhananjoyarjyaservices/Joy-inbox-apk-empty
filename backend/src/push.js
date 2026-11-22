const crypto = require("crypto");
const { getDb, getFirebaseAdmin } = require("./firebase");
const { OWNER_UID } = require("./owner");

const DEVICE_COLLECTION = "fcmTokens";
const MAX_MULTICAST_SIZE = 500;

function hashInstallationId(installationId) {
  return crypto.createHash("sha256").update(installationId).digest("hex");
}

function getDeviceCollection(db, ownerUid = OWNER_UID) {
  return db.collection(DEVICE_COLLECTION).doc(ownerUid).collection("devices");
}

function getDeviceDocument(db, ownerUid, installationId) {
  return getDeviceCollection(db, ownerUid).doc(hashInstallationId(installationId));
}

function getTenantDeviceCollection(db, organizationId, uid) {
  return db.collection("organizations").doc(organizationId)
    .collection("members").doc(uid).collection("devices");
}

function getTenantDeviceDocument(db, organizationId, uid, installationId) {
  return getTenantDeviceCollection(db, organizationId, uid).doc(hashInstallationId(installationId));
}

async function removeInvalidTokens(collection, responses) {
  const batch = collection.firestore.batch();
  let removed = 0;
  responses.forEach((response) => {
    const code = response.error?.code;
    if (code === "messaging/invalid-registration-token" ||
        code === "messaging/registration-token-not-registered") {
      batch.delete(collection.doc(response.deviceId));
      removed += 1;
    }
  });
  if (removed) await batch.commit();
}

async function sendToDeviceCollection(admin, collection, data) {
  const snapshot = await collection.get();
  const devices = snapshot.docs.map((document) => ({
    deviceId: document.id,
    token: document.get("token")
  })).filter((device) => typeof device.token === "string" && device.token.length > 0);
  for (let offset = 0; offset < devices.length; offset += MAX_MULTICAST_SIZE) {
    const group = devices.slice(offset, offset + MAX_MULTICAST_SIZE);
    const result = await admin.messaging().sendEachForMulticast({
      tokens: group.map((device) => device.token),
      data,
      webpush: { headers: { Urgency: "high", TTL: "86400" } }
    });
    await removeInvalidTokens(collection, result.responses.map((response, index) => ({
      ...response,
      deviceId: group[index].deviceId
    })));
  }
}

async function sendIncomingTextNotification(phone, senderName, text, messageId) {
  const db = getDb();
  const collection = getDeviceCollection(db);
  const admin = getFirebaseAdmin();
  const title = String(senderName || `+${phone}`).slice(0, 100);
  const body = String(text || "New message").replace(/\s+/g, " ").trim().slice(0, 180);
  await sendToDeviceCollection(admin, collection, {
    type: "incoming_whatsapp_text", title, body, chatId: phone, messageId
  });
}

async function sendTenantIncomingTextNotification(organizationId, phone, senderName, text, messageId) {
  const db = getDb();
  const organizationRef = db.collection("organizations").doc(organizationId);
  const members = await organizationRef.collection("members").where("status", "==", "active").get();
  const admin = getFirebaseAdmin();
  const title = String(senderName || `+${phone}`).slice(0, 100);
  const body = String(text || "New message").replace(/\s+/g, " ").trim().slice(0, 180);
  const data = { type: "incoming_whatsapp_text", title, body, chatId: phone, messageId, organizationId };
  for (const member of members.docs) {
    if (!["owner", "admin", "agent"].includes(member.get("role"))) continue;
    await sendToDeviceCollection(admin, getTenantDeviceCollection(db, organizationId, member.id), data);
  }
}

function isValidInstallationId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isValidFcmToken(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/\s/.test(value);
}

module.exports = {
  getDeviceDocument,
  getTenantDeviceDocument,
  isValidFcmToken,
  isValidInstallationId,
  sendIncomingTextNotification,
  sendTenantIncomingTextNotification
};
