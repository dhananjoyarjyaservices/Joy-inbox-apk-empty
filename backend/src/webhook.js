const crypto = require("crypto");

const { getDb } = require("./firebase");
const { verifyMetaSignature, getRawBody } = require("./security");
const { normalizePhoneNumber, sendWhatsAppText } = require("./whatsapp");
const { resolvePhoneNumberOrganization, getWhatsAppCredentials } = require("./tenancy");
const { sendTenantIncomingTextNotification } = require("./push");
const { matchesAutomationRule } = require("./automationRules");

function getVerifyToken() {
  return (
    process.env.WHATSAPP_VERIFY_TOKEN ||
    process.env.VERIFY_TOKEN
  );
}

function verifyWebhook(event) {
  const params = getQueryParameters(event);
  const mode = params["hub.mode"];
  const token = params["hub.verify_token"];
  const challenge = params["hub.challenge"];
  const expectedToken = getVerifyToken();
  if (!expectedToken) {
    return { statusCode: 500, body: "Webhook verification token is not configured." };
  }
  const received = typeof token === "string" ? Buffer.from(token, "utf8") : Buffer.alloc(0);
  const expected = Buffer.from(expectedToken, "utf8");
  const tokenMatches = received.length === expected.length &&
    received.length > 0 &&
    crypto.timingSafeEqual(received, expected);
  if (mode === "subscribe" && tokenMatches &&
      typeof challenge === "string" && challenge.length > 0 && challenge.length <= 4096) {
    return { statusCode: 200, body: challenge };
  }
  return { statusCode: 403, body: "Webhook verification failed." };
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

async function saveTenantIncomingMessage(db, organization, message, contactName, phoneNumberId) {
  const phone = normalizePhoneNumber(message.from);
  const messageId = String(message.id || "");
  if (!phone || !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId)) return false;

  const chatRef = organization.ref.collection("chats").doc(phone);
  const messageRef = chatRef.collection("messages").doc(messageId);
  const timestamp = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
  if (Number.isNaN(timestamp.getTime())) return false;
  const messageType = typeof message.type === "string" ? message.type.slice(0, 40) : "unknown";
  const mediaMessage = message[messageType] && typeof message[messageType] === "object" ? message[messageType] : {};
  const rawText = messageType === "text"
    ? (typeof message.text?.body === "string" ? message.text.body : "")
    : (typeof mediaMessage.caption === "string" ? mediaMessage.caption
      : typeof mediaMessage.title === "string" ? mediaMessage.title
      : messageType === "location" && message.location
        ? String(message.location.latitude ?? "") + ", " + String(message.location.longitude ?? "")
        : messageType + " message");
  // Bound untrusted webhook fields before writing Firestore documents.
  const text = rawText.slice(0, 4096);
  const safeContactName = typeof contactName === "string" ? contactName.slice(0, 100) : phone;
  const mediaId = typeof mediaMessage.id === "string" ? mediaMessage.id.slice(0, 256) : null;
  const mediaMimeType = typeof mediaMessage.mime_type === "string" ? mediaMessage.mime_type.slice(0, 128) : null;
  const mediaFilename = typeof mediaMessage.filename === "string" ? mediaMessage.filename.slice(0, 180) : null;
  const mediaSha256 = typeof mediaMessage.sha256 === "string" ? mediaMessage.sha256.slice(0, 128) : null;
  const rawMediaSize = Number(mediaMessage.file_size);
  const mediaSize = Number.isSafeInteger(rawMediaSize) && rawMediaSize > 0 ? rawMediaSize : null;

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
      phoneNumberId: String(phoneNumberId || ""),
      direction: "incoming",
      type: messageType,
      text,
      timestamp,
      status: "received",
      source: "whatsapp",
      sender: phone,
      mediaId,
      mediaMimeType,
      mediaSize,
      mediaFilename,
      mediaSha256,
      ...replyFields
    });
    transaction.set(chatRef, {
      customerPhone: phone,
      ...(phoneNumberId ? { phoneNumberId: String(phoneNumberId) } : {}),
      customerName: safeContactName || phone,
      lastMessage: text,
      lastMessageAt: timestamp,
      lastMessageDirection: "incoming",
      ...(chatSnapshot.data()?.responsePendingSince ? {} : { responsePendingSince: timestamp }),
      unreadCount: previousUnread + 1,
      pinned: chatSnapshot.exists ? Boolean(chatSnapshot.data().pinned) : false,
      archived: chatSnapshot.exists ? Boolean(chatSnapshot.data().archived) : false,
      updatedAt: new Date()
    }, { merge: true });
    return true;
  });
}

async function maybeRunTenantKeywordAutomation(db, organization, credentials, phone, inboundMessage) {
  if (inboundMessage.type !== "text" || typeof inboundMessage.text?.body !== "string") return;
  const body = inboundMessage.text.body.trim().slice(0, 4096);
  if (!body) return;
  const rulesSnapshot = await organization.ref.collection("automationRules").limit(100).get();
  const rules = rulesSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }))
    .filter((rule) => rule.enabled === true && typeof rule.keyword === "string" && (typeof rule.response === "string" || (Array.isArray(rule.steps) && rule.steps.length > 0)))
    .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
  const rule = rules.find((item) => matchesAutomationRule(item, body));
  if (!rule) return;

  const inboundTimestamp = Number(inboundMessage.timestamp)
    ? new Date(Number(inboundMessage.timestamp) * 1000) : new Date();
  const withinWindow = inboundTimestamp.getTime() <= Date.now() + 5 * 60 * 1000 &&
    Date.now() - inboundTimestamp.getTime() < 24 * 60 * 60 * 1000;
  const steps = Array.isArray(rule.steps) && rule.steps.length
    ? rule.steps.slice(0, 5).map((step) => typeof step === "string"
      ? { message: step.trim(), delaySeconds: 0 }
      : { message: String(step?.message || "").trim(), delaySeconds: Number.isInteger(step?.delaySeconds) ? Math.max(0, Math.min(86400, step.delaySeconds)) : 0 }).filter((step) => step.message)
    : [{ message: String(rule.response || "").trim(), delaySeconds: 0 }].filter((step) => step.message);
  const runId = crypto.createHash("sha256").update(String(inboundMessage.id || "") + ":" + rule.id).digest("hex");
  const runRef = organization.ref.collection("automationRuns").doc(runId);
  const claimed = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(runRef);
    if (existing.exists) return false;
    transaction.create(runRef, {
      ruleId: rule.id,
      ruleName: String(rule.name || "Automation").slice(0, 80),
      inboundMessageId: String(inboundMessage.id || "").slice(0, 256),
      customerPhone: phone,
      status: withinWindow ? "sending" : "skipped",
      totalSteps: steps.length,
      completedSteps: 0,
      reason: withinWindow ? null : "outside_whatsapp_service_window",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    return true;
  });
  if (!claimed || !withinWindow) return;

  const responseMessageIds = [];
  const chatRef = organization.ref.collection("chats").doc(phone);
  const firstDelayedIndex = steps.findIndex((step, index) => index > 0 && step.delaySeconds > 0);
  const immediateCount = firstDelayedIndex < 0 ? steps.length : firstDelayedIndex;
  try {
    let lastMessage = "";
    let lastTimestamp = new Date();
    const batch = db.batch();
    for (let index = 0; index < immediateCount; index += 1) {
      const replyText = steps[index].message;
      const result = await sendWhatsAppText(phone, replyText, undefined, credentials);
      lastTimestamp = new Date();
      lastMessage = replyText;
      responseMessageIds.push(result.messageId);
      batch.set(chatRef.collection("messages").doc(result.messageId), {
        messageId: result.messageId, chatId: phone, organizationId: organization.id,
        direction: "outgoing", type: "text", text: replyText, timestamp: lastTimestamp, status: "sent",
        source: "automation", automationRuleId: rule.id, automationStep: index + 1,
        phoneNumberId: credentials.phoneNumberId || null, sender: "system"
      });
    }
    batch.set(chatRef, {
      lastMessage, lastMessageAt: lastTimestamp, lastMessageDirection: "outgoing",
      ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}), updatedAt: lastTimestamp
    }, { merge: true });
    const runUpdates = {
      responseMessageIds: [...responseMessageIds],
      completedSteps: immediateCount,
      totalSteps: steps.length,
      status: immediateCount === steps.length ? "sent" : "sending",
      updatedAt: lastTimestamp,
      ...(immediateCount === steps.length ? { sentAt: lastTimestamp } : {})
    };
    batch.set(runRef, runUpdates, { merge: true });
    let dueAt = lastTimestamp.getTime();
    for (let index = immediateCount; index < steps.length; index += 1) {
      dueAt += steps[index].delaySeconds * 1000;
      const queueRef = organization.ref.collection("automationQueue").doc(`${runId}_${index + 1}`);
      batch.set(queueRef, {
        runId, ruleId: rule.id, organizationId: organization.id, customerPhone: phone,
        phoneNumberId: credentials.phoneNumberId || null, stepIndex: index,
        totalSteps: steps.length, text: steps[index].message,
        delaySeconds: steps[index].delaySeconds,
        dueAt: new Date(dueAt),
        windowExpiresAt: new Date(inboundTimestamp.getTime() + 24 * 60 * 60 * 1000),
        status: "queued", attempts: 0, createdAt: lastTimestamp, updatedAt: lastTimestamp
      });
    }
    await batch.commit();
  } catch (error) {
    await runRef.set({
      status: responseMessageIds.length ? "partially_failed" : "failed",
      responseMessageIds, completedSteps: responseMessageIds.length, totalSteps: steps.length,
      error: String(error?.message || "Automation reply failed.").slice(0, 300), updatedAt: new Date()
    }, { merge: true });
    console.error("Tenant keyword automation failed:", error);
  }
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
        phoneNumberId: credentials.phoneNumberId || null,
        sender: "system"
      });
      transaction.set(chatRef, {
        greetingStatus: "sent",
        greetingSentAt: timestamp,
        lastMessage: greetingText,
        lastMessageAt: timestamp,
        lastMessageDirection: "outgoing",
        ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}),
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
  if (currentStatus === "failed") return false;
  if (nextStatus === "failed") return !["delivered", "read"].includes(currentStatus);
  if (currentStatus === "read") return false;
  if (currentStatus === "delivered") return nextStatus === "read";
  return MESSAGE_STATUS_RANK[nextStatus] > (MESSAGE_STATUS_RANK[currentStatus] ?? -1);
}

async function updateTenantMessageStatus(organization, status) {
  const messageId = String(status.id || "");
  const recipient = normalizePhoneNumber(status.recipient_id);
  const nextStatus = status.status;
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(messageId) || !recipient ||
      !Object.prototype.hasOwnProperty.call(MESSAGE_STATUS_RANK, nextStatus)) return;
  const ref = organization.ref.collection("chats").doc(recipient).collection("messages").doc(messageId);
  const metaError = Array.isArray(status.errors) ? status.errors[0] : null;
  const deliveryError = nextStatus === "failed" && metaError ? {
    code: String(metaError.code || "").slice(0, 40),
    title: String(metaError.title || "Message delivery failed.").slice(0, 160),
    message: String(metaError.message || metaError.error_data?.details || "WhatsApp could not deliver this message.").slice(0, 300),
    details: String(metaError.error_data?.details || "").slice(0, 300)
  } : null;
  await ref.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      // The send endpoint may still be committing the outgoing message.
      // Return a non-2xx webhook response so Meta can retry this status event.
      throw Object.assign(new Error("Outgoing message is not committed yet."), {
        statusCode: 503,
        retryable: true
      });
    }
    if (!shouldApplyMessageStatus(snapshot.data()?.status, nextStatus)) return;
    transaction.update(ref, {
      status: nextStatus,
      statusUpdatedAt: new Date(),
      ...(deliveryError ? { deliveryError } : {})
    });
  });
}

function isValidMetaWebhookPayload(payload) {
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
    typeof payload.object === "string" && Array.isArray(payload.entry));
}

function isIgnorableWebhookRoutingError(error) {
  return [400, 403, 404, 409].includes(Number(error?.statusCode));
}

async function processWebhookPayload(payload) {
  if (!isValidMetaWebhookPayload(payload)) {
    throw Object.assign(new Error("Invalid Meta webhook payload structure."), { statusCode: 400 });
  }
  if (payload.object !== "whatsapp_business_account") {
    console.warn("Ignoring unsupported Meta webhook object:", payload.object);
    return;
  }
  const db = getDb();
  for (const entry of payload.entry) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!change || change.field !== "messages" || !change.value || typeof change.value !== "object") continue;
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) {
        console.warn("Ignoring WhatsApp webhook change without metadata.phone_number_id.");
        continue;
      }
      let organization;
      let credentials;
      try {
        organization = await resolvePhoneNumberOrganization(db, String(phoneNumberId));
        credentials = await getWhatsAppCredentials(db, organization.id, String(phoneNumberId));
      } catch (error) {
        if (!isIgnorableWebhookRoutingError(error)) throw error;
        console.warn("Ignoring webhook for an unlinked or inactive WhatsApp number:", error.message);
        continue;
      }
      const contacts = Array.isArray(value.contacts) ? value.contacts.filter((item) => item && typeof item === "object") : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        const contact = contacts.find((item) => item.wa_id === message.from);
        const name = contact?.profile?.name || message.from;
        const created = await saveTenantIncomingMessage(db, organization, message, name, String(phoneNumberId));
        if (created) {
          const phone = normalizePhoneNumber(message.from);
          await maybeSendTenantGreeting(db, organization, credentials, phone, message);
          try {
            await maybeRunTenantKeywordAutomation(db, organization, credentials, phone, message);
          } catch (error) {
            // An automation failure must not make Meta retry an already-persisted inbound message.
            console.error("Tenant keyword automation processing failed:", error);
          }
          try {
            await sendTenantIncomingTextNotification(
              organization.id,
              phone,
              name,
              message.type === "text" ? String(message.text?.body || "") : `New ${message.type || "WhatsApp"} message`,
              String(message.id || "")
            );
          } catch (error) {
            // Notification delivery must never cause Meta to retry an already-saved message.
            console.error("Tenant push notification delivery failed:", error);
          }
        }
      }
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const status of statuses) {
        if (!status || typeof status !== "object" || Array.isArray(status)) continue;
        await updateTenantMessageStatus(organization, status);
      }
    }
  }
}

function getWebhookProcessingStatusCode(error) {
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599
    ? statusCode : 500;
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

    if (!isValidMetaWebhookPayload(payload)) {
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

    const statusCode = getWebhookProcessingStatusCode(error);
    return {
      statusCode,
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
  isValidMetaWebhookPayload,
  isIgnorableWebhookRoutingError,
  processWebhookPayload,
  getWebhookProcessingStatusCode
};
