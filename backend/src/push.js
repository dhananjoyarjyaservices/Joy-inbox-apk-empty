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

async function sendToDeviceCollection(admin, collection, data, deliveryContext = null) {
  const snapshot = await collection.get();
  const devices = snapshot.docs.map((document) => ({
    deviceId: document.id,
    token: document.get("token")
  })).filter((device) => typeof device.token === "string" && device.token.length > 0);
  let delivered = 0;
  const deliveryResults = [];
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
    result.responses.forEach((response, index) => deliveryResults.push({
      deviceId: group[index].deviceId, success: response.success,
      errorCode: response.success ? null : String(response.error?.code || "messaging/unknown-error"),
      attempts: 1
    }));
    const retryIndexes = result.responses.map((response, index) => ({ response, index }))
      .filter(({ response }) => !response.success &&
        ["messaging/server-unavailable", "messaging/internal-error", "messaging/unknown-error"].includes(response.error?.code))
      .map(({ index }) => index);
    if (retryIndexes.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const retry = await admin.messaging().sendEachForMulticast({
        tokens: retryIndexes.map(index => group[index].token),
        data,
        webpush: { headers: { Urgency: "high", TTL: "86400" } }
      });
      delivered += retry.responses.filter(response => response.success).length;
      retry.responses.forEach((response, retryIndex) => {
        const originalIndex = retryIndexes[retryIndex];
        const record = deliveryResults.find(item => item.deviceId === group[originalIndex].deviceId);
        if (record) {
          record.success = response.success;
          record.errorCode = response.success ? null : String(response.error?.code || "messaging/unknown-error");
          record.attempts = 2;
        }
      });
      await removeInvalidTokens(collection, retry.responses.map((response, index) => ({
        ...response,
        deviceId: group[retryIndexes[index]].deviceId
      })));
    }
    delivered += result.responses.filter(response => response.success).length;
  }
  if (deliveryContext && deliveryResults.length) {
    try {
      const logCollection = collection.firestore.collection("organizations").doc(deliveryContext.organizationId)
        .collection("members").doc(deliveryContext.uid).collection("notificationDeliveries");
      const batch = collection.firestore.batch();
      const now = new Date();
      deliveryResults.forEach(item => {
        const ref = logCollection.doc();
        batch.set(ref, {
          type: deliveryContext.type,
          status: item.success ? "delivered" : "failed",
          deviceId: item.deviceId,
          attempts: item.attempts,
          errorCode: item.errorCode,
          createdAt: now,
          updatedAt: now
        });
      });
      await batch.commit();
    } catch (error) {
      console.warn("Notification delivery log could not be saved:", error);
    }
  }
  return delivered;
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

async function sendTenantSlaOverdueNotification(organizationId, uid, phone, senderName, preferences = {}) {
  const db = getDb();
  const admin = getFirebaseAdmin();
  const title = "First reply SLA overdue";
  const body = `Customer ${String(senderName || `+${phone}`).slice(0, 90)} is waiting for your reply.`;
  return sendToDeviceCollection(admin, getTenantDeviceCollection(db, organizationId, uid), {
    type: "tenant_sla_overdue",
    title,
    body,
    chatId: String(phone),
    organizationId,
    soundEnabled: preferences.soundEnabled === false ? "false" : "true",
    desktopEnabled: preferences.desktopEnabled === false ? "false" : "true"
  }, { organizationId, uid, type: "sla" });
}

async function sendTenantCrmFollowUpNotification(organizationId, uid, leadId, leadTitle) {
  const db = getDb();
  const admin = getFirebaseAdmin();
  const title = "CRM follow-up is due";
  const body = `Follow up with ${String(leadTitle || "your lead").slice(0, 100)}.`;
  return sendToDeviceCollection(admin, getTenantDeviceCollection(db, organizationId, uid), {
    type: "crm_follow_up", title, body, leadId: String(leadId), organizationId
  }, { organizationId, uid, type: "crm_follow_up" });
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
    const { getTenantNotificationPreferences } = require("./notificationPreferences");
    const preferences = await getTenantNotificationPreferences(db, organizationId, member.id);
    if (!preferences.desktopEnabled && !preferences.soundEnabled) continue;
    await sendToDeviceCollection(admin, getTenantDeviceCollection(db, organizationId, member.id), {
      ...data,
      soundEnabled: preferences.soundEnabled ? "true" : "false",
      desktopEnabled: preferences.desktopEnabled ? "true" : "false"
    }, { organizationId, uid: member.id, type: "message" });
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
  sendTenantIncomingTextNotification,
  sendTenantSlaOverdueNotification,
  sendTenantCrmFollowUpNotification
};
