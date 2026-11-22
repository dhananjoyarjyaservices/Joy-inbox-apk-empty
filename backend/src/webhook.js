
const { getDb } = require("./firebase");
const { verifyMetaSignature, getRawBody } = require("./security");
const { normalizePhoneNumber, sendWhatsAppText } = require("./whatsapp");
const { resolvePhoneNumberOrganization, getWhatsAppCredentials } = require("./tenancy");

function getVerifyToken() {
  return (
    process.env.WHATSAPP_VERIFY_TOKEN ||
    process.env.VERIFY_TOKEN
  );
}

function getQueryParameters(event) {
  if (event.queryStringParameters) {
    return event.queryStringParameters;
  }

  const params = new URLSearchParams(
    event.rawQueryString || ""
  );

  return Object.fromEntries(params.entries());
}

async function saveTenantIncomingMessage(db, organization, message, contactName) {
  const phone = normalizePhoneNumber(message.from);
  const messageId = String(message.id || "");
  if (!phone || !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId)) return false;

  const chatRef = organization.ref.collection("chats").doc(phone);
  const messageRef = chatRef.collection("messages").doc(messageId);
  const timestamp = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
  if (Number.isNaN(timestamp.getTime())) return false;
  const mediaMessage = message[message.type] || {};
  const text = message.type === "text"
    ? String(message.text?.body || "")
    : String(mediaMessage.caption || mediaMessage.title ||
      (message.type === "location" && message.location
        ? `${message.location.latitude}, ${message.location.longitude}`
        : `${message.type || "Unsupported"} message`));

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(messageRef);
    if (existing.exists) return false;
    const chatSnapshot = await transaction.get(chatRef);
    const previousUnread = chatSnapshot.exists ? Number(chatSnapshot.data().unreadCount || 0) : 0;
    const contextMessageId = typeof message.context?.id === "string" &&
      /^[A-Za-z0-9._:-]{1,256}$/.test(message.context.id) ? message.context.id : "";
    let replyFields = {};
    if (contextMessageId) {
      const contextRef = chatRef.collection("messages").doc(contextMessageId);
      const contextSnapshot = await transaction.get(contextRef);
      if (contextSnapshot.exists) {
        const original = contextSnapshot.data();
        replyFields = {
          replyToMessageId: contextSnapshot.id,
          replyToMessageText: String(original.text || ""),
          replyToMessageSender: original.direction === "outgoing" ? "You" : String(original.sender || phone),
          replyToMessageType: String(original.type || "unknown")
        };
      }
    }
    transaction.set(messageRef, {
      messageId,
      chatId: phone,
      organizationId: organization.id,
      direction: "incoming",
      type: String(message.type || "unknown"),
      text,
      timestamp,
      status: "received",
      source: "whatsapp",
      sender: phone,
      mediaId: mediaMessage.id || null,
      mediaMimeType: mediaMessage.mime_type || null,
      mediaSize: Number(mediaMessage.file_size) || null,
      mediaFilename: String(mediaMessage.filename || "").slice(0, 180) || null,
      mediaSha256: String(mediaMessage.sha256 || "").slice(0, 128) || null,
      ...replyFields
    });
    transaction.set(chatRef, {
      customerPhone: phone,
      customerName: contactName || phone,
      lastMessage: text,
      lastMessageAt: timestamp,
      lastMessageDirection: "incoming",
      unreadCount: previousUnread + 1,
      pinned: chatSnapshot.exists ? Boolean(chatSnapshot.data().pinned) : false,
      archived: chatSnapshot.exists ? Boolean(chatSnapshot.data().archived) : false,
      updatedAt: new Date()
    }, { merge: true });
    return true;
  });
}

async function maybeSendTenantGreeting(db, organization, credentials, phone, inboundMessage) {
  const settingsSnapshot = await organization.ref.collection("settings").doc("greeting").get();
  const settings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
  const greetingText = String(settings.text || "").trim();
  if (!settings.enabled || !greetingText || greetingText.length > 1024) return;
  const chatRef = organization.ref.collection("chats").doc(phone);
  const inboundTime = Number(inboundMessage.timestamp)
    ? new Date(Number(inboundMessage.timestamp) * 1000) : new Date();
  const withinWindow = inboundTime.getTime() <= Date.now() + 5 * 60 * 1000 &&
    Date.now() - inboundTime.getTime() < 24 * 60 * 60 * 1000;
  const claimed = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(chatRef);
    if (!snapshot.exists || snapshot.data().greetingAttemptedFor) return false;
    transaction.set(chatRef, {
      greetingAttemptedFor: inboundMessage.id,
      greetingStatus: withinWindow ? "sending" : "outside_service_window",
      greetingAttemptedAt: new Date()
    }, { merge: true });
    return true;
  });
  if (!claimed || !withinWindow) return;
  try {
    const result = await sendWhatsAppText(phone, greetingText, undefined, credentials);
    const timestamp = new Date();
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(chatRef);
      if (current.data()?.greetingAttemptedFor !== inboundMessage.id) return;
      transaction.set(chatRef.collection("messages").doc(result.messageId), {
        messageId: result.messageId,
        chatId: phone,
        organizationId: organization.id,
        direction: "outgoing",
        type: "text",
        text: greetingText,
        timestamp,
        status: "sent",
        source: "greeting",
        sender: "system"
      });
      transaction.set(chatRef, {
        greetingStatus: "sent",
        greetingSentAt: timestamp,
        lastMessage: greetingText,
        lastMessageAt: timestamp,
        lastMessageDirection: "outgoing",
        updatedAt: timestamp
      }, { merge: true });
    });
  } catch (error) {
    await chatRef.set({
      greetingStatus: "failed",
      greetingLastError: String(error?.message || "Greeting could not be sent.").slice(0, 300),
      greetingFailedAt: new Date()
    }, { merge: true });
  }
}

const MESSAGE_STATUS_RANK = { failed: 0, sent: 1, delivered: 2, read: 3 };

function shouldApplyMessageStatus(currentStatus, nextStatus) {
  if (!Object.prototype.hasOwnProperty.call(MESSAGE_STATUS_RANK, nextStatus)) return false;
  return MESSAGE_STATUS_RANK[nextStatus] > (MESSAGE_STATUS_RANK[currentStatus] ?? -1);
}

async function updateTenantMessageStatus(organization, status) {
  const messageId = String(status.id || "");
  const recipient = normalizePhoneNumber(status.recipient_id);
  const nextStatus = status.status;
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(messageId) || !recipient ||
      !Object.prototype.hasOwnProperty.call(MESSAGE_STATUS_RANK, nextStatus)) return;
  const ref = organization.ref.collection("chats").doc(recipient).collection("messages").doc(messageId);
  await ref.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || !shouldApplyMessageStatus(snapshot.data()?.status, nextStatus)) return;
    transaction.update(ref, { status: nextStatus, statusUpdatedAt: new Date() });
  });
}

async function processWebhookPayload(payload) {
  const db = getDb();
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) {
        console.warn("Ignoring WhatsApp webhook change without metadata.phone_number_id.");
        continue;
      }
      let organization;
      let credentials;
      try {
        organization = await resolvePhoneNumberOrganization(db, String(phoneNumberId));
        credentials = await getWhatsAppCredentials(db, organization.id);
      } catch (error) {
        console.warn("Ignoring webhook for an unlinked or inactive WhatsApp number:", error.message);
        continue;
      }
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        const contact = contacts.find((item) => item.wa_id === message.from);
        const name = contact?.profile?.name || message.from;
        const created = await saveTenantIncomingMessage(db, organization, message, name);
        if (created) {
          await maybeSendTenantGreeting(db, organization, credentials, normalizePhoneNumber(message.from), message);
        }
      }
      for (const status of value.statuses || []) {
        await updateTenantMessageStatus(organization, status);
      }
    }
  }
}

async function receiveWebhook(event) {
  // Handle signature verification errors safely.
  try {
    if (!verifyMetaSignature(event)) {
      return {
        statusCode: 401,
        body: "Invalid webhook signature."
      };
    }
  } catch (error) {
    console.error(
      "Webhook signature verification failed:",
      error
    );

    return {
      statusCode: 500,
      body: "Webhook signature verification failed."
    };
  }

  let payload;

  try {
    const rawBody = getRawBody(event).toString("utf8");

    payload = JSON.parse(rawBody);

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new Error("Invalid webhook payload.");
    }
  } catch (error) {
    console.error("Webhook payload parsing failed:", error);

    return {
      statusCode: 400,
      body: "Invalid JSON payload."
    };
  }

  try {
    await processWebhookPayload(payload);

    return {
      statusCode: 200,
      body: "EVENT_RECEIVED"
    };
  } catch (error) {
    console.error("Webhook processing failed:", error);

    return {
      statusCode: 500,
      body: "Webhook processing failed."
    };
  }
}

module.exports = {
  verifyWebhook,
  receiveWebhook,
  saveTenantIncomingMessage,
  updateTenantMessageStatus,
  shouldApplyMessageStatus,
  processWebhookPayload
};
