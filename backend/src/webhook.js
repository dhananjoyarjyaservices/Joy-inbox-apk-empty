
const crypto = require("crypto");
const { getDb } = require("./firebase");
const { verifyMetaSignature, getRawBody } = require("./security");
const { normalizePhoneNumber, sendWhatsAppText } = require("./whatsapp");
const { OWNER_UID } = require("./owner");
const { sendIncomingTextNotification } = require("./push");

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

function shouldSuppressInbound(deletionSnapshot, timestamp) {
  if (!deletionSnapshot.exists) return false;
  const deletion = deletionSnapshot.data() || {};
  if (deletion.deleting === true) return true;

  const deletedAtValue = deletion.deletedAt;
  if (!deletedAtValue) return false;
  const deletedAt = deletedAtValue?.toDate
    ? deletedAtValue.toDate()
    : deletedAtValue instanceof Date
      ? deletedAtValue
      : new Date(deletedAtValue);
  return !Number.isNaN(deletedAt.getTime()) && timestamp.getTime() <= deletedAt.getTime();
}

async function verifyWebhook(event) {
  const params = getQueryParameters(event);

  const mode = params["hub.mode"];
  const token = params["hub.verify_token"];
  const challenge = params["hub.challenge"];

  const verifyToken = getVerifyToken();

  let validToken = Boolean(verifyToken && token === verifyToken);
  if (!validToken && mode === "subscribe" && token) {
    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const matches = await getDb().collectionGroup("whatsappConnections")
      .where("webhookVerifyTokenHash", "==", tokenHash).limit(1).get();
    validToken = !matches.empty;
  }

  if (mode === "subscribe" && validToken) {
    return {
      statusCode: 200,
      body: challenge || ""
    };
  }

  return {
    statusCode: 403,
    body: "Webhook verification failed."
  };
}

async function saveIncomingMessage(message, contactName) {
  const db = getDb();

  const phone = normalizePhoneNumber(message.from);
  const messageId = message.id;

  if (!phone || !messageId) {
    return false;
  }

  const timestamp = message.timestamp
    ? new Date(Number(message.timestamp) * 1000)
    : new Date();
  const contextMessageId =
    typeof message.context?.id === "string" &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(message.context.id)
      ? message.context.id
      : "";
  let contextMessageData = null;
  let replyToMessageDocumentId = contextMessageId;
  if (contextMessageId) {
    const contextSnapshot = await db
      .collection("chats")
      .doc(phone)
      .collection("messages")
      .doc(contextMessageId)
      .get();
    if (contextSnapshot.exists) {
      contextMessageData = contextSnapshot.data();
      replyToMessageDocumentId = contextSnapshot.id;
    }
  }
  const deletedChatRef = db.collection("deletedChats").doc(phone);
  const deletionSnapshot = await deletedChatRef.get();
  if (shouldSuppressInbound(deletionSnapshot, timestamp)) return false;

  const mediaMessage = message[message.type] || {};
  const text =
    message.type === "text"
      ? String(message.text?.body || "")
      : String(
          mediaMessage.caption ||
          mediaMessage.title ||
          (message.type === "location" && message.location
            ? `${message.location.latitude}, ${message.location.longitude}`
            : `${message.type || "Unsupported"} message`)
        );
  // Incoming customer media is intentionally not downloaded or persisted.
  const chatRef = db.collection("chats").doc(phone);

  const messageRef = chatRef
    .collection("messages")
    .doc(messageId);

  if ((await messageRef.get()).exists) {
    return false;
  }

  let created = false;
  await db.runTransaction(async (transaction) => {
    created = false;
    const existingMessage = await transaction.get(messageRef);

    if (existingMessage.exists) {
      return;
    }

    const currentDeletion = await transaction.get(deletedChatRef);
    if (shouldSuppressInbound(currentDeletion, timestamp)) return;

    created = true;

    const chatSnapshot = await transaction.get(chatRef);

    const previousUnread = chatSnapshot.exists
      ? Number(chatSnapshot.data().unreadCount || 0)
      : 0;

    transaction.set(messageRef, {
      messageId,
      chatId: phone,
      direction: "incoming",
      type: String(message.type || "unknown"),
      text,
      timestamp,
      status: "received",
      source: "whatsapp",
      sender: phone,
      mediaStoragePath: null,
      mediaDownloadError: message.type !== "text"
        ? "Customer media is not stored by Joy Inbox."
        : null,
      ...(contextMessageId ? {
        replyToMessageId: replyToMessageDocumentId,
        replyToMessageText: String(contextMessageData?.text || ""),
        replyToMessageSender: contextMessageData?.direction === "outgoing"
          ? "You"
          : String(contextMessageData?.sender || contactName || phone),
        replyToMessageType: String(contextMessageData?.type || "unknown")
      } : {})
    });

    transaction.set(
      chatRef,
      {
        customerPhone: phone,
        customerName: contactName || phone,
        lastMessage: text,
        lastMessageAt: timestamp,
        lastMessageDirection: "incoming",
        unreadCount: previousUnread + 1,
        pinned: chatSnapshot.exists
          ? Boolean(chatSnapshot.data().pinned)
          : false,
        archived: chatSnapshot.exists
          ? Boolean(chatSnapshot.data().archived)
          : false,
        updatedAt: new Date()
      },
      { merge: true }
    );
  });

  if (!created) return false;

  try {
    const contactRef = db
      .collection("users")
      .doc(OWNER_UID)
      .collection("contacts")
      .doc(phone);
    await db.runTransaction(async (transaction) => {
      const contactSnapshot = await transaction.get(contactRef);
      const contact = {
        phone: `+${phone}`,
        phoneId: phone,
        source: contactSnapshot.exists
          ? contactSnapshot.data().source || "whatsapp"
          : "whatsapp",
        lastSeenAt: new Date(),
        updatedAt: new Date()
      };
      if (!contactSnapshot.exists) {
        contact.name = contactName || `+${phone}`;
        contact.email = "";
        contact.notes = "";
        contact.createdAt = new Date();
      }
      transaction.set(contactRef, contact, { merge: true });
    });
  } catch (error) {
    console.error("WhatsApp contact sync failed:", error);
  }

  return created;
}

async function maybeSendGreeting(phone, inboundMessage) {
  const db = getDb();
  const settingsSnapshot = await db
    .collection("users")
    .doc(OWNER_UID)
    .collection("settings")
    .doc("greeting")
    .get();
  const settings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
  const greetingText = String(settings.text || "").trim();
  if (!settings.enabled || !greetingText || greetingText.length > 1024) return;

  const chatRef = db.collection("chats").doc(phone);
  const inboundTime = Number(inboundMessage.timestamp)
    ? new Date(Number(inboundMessage.timestamp) * 1000)
    : new Date();
  const isWithinServiceWindow =
    inboundTime.getTime() <= Date.now() + 5 * 60 * 1000 &&
    Date.now() - inboundTime.getTime() < 24 * 60 * 60 * 1000;

  const claimed = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(chatRef);
    if (!snapshot.exists || snapshot.data().greetingAttemptedFor) return false;
    const deletionSnapshot = await transaction.get(db.collection("deletedChats").doc(phone));
    if (shouldSuppressInbound(deletionSnapshot, inboundTime)) return false;

    transaction.set(chatRef, {
      greetingAttemptedFor: inboundMessage.id,
      greetingStatus: isWithinServiceWindow ? "sending" : "outside_service_window",
      greetingAttemptedAt: new Date(),
      greetingLastError: isWithinServiceWindow
        ? null
        : "Greeting was not sent: the inbound message is outside the 24-hour service window."
    }, { merge: true });
    return true;
  });
  if (!claimed || !isWithinServiceWindow) return;

  try {
    const result = await sendWhatsAppText(phone, greetingText);
    const timestamp = new Date();
    await db.runTransaction(async (transaction) => {
      const currentChat = await transaction.get(chatRef);
      if (currentChat.data()?.greetingAttemptedFor !== inboundMessage.id) return;
      const messageRef = chatRef.collection("messages").doc(result.messageId);
      transaction.set(messageRef, {
        messageId: result.messageId,
        chatId: phone,
        direction: "outgoing",
        type: "text",
        text: greetingText,
        timestamp,
        status: "sent",
        source: "greeting",
        sender: "owner"
      });
      transaction.set(chatRef, {
        greetingStatus: "sent",
        greetingSentAt: timestamp,
        greetingLastError: null,
        lastMessage: greetingText,
        lastMessageAt: timestamp,
        lastMessageDirection: "outgoing",
        updatedAt: timestamp
      }, { merge: true });
    });
  } catch (error) {
    const message = String(error?.message || "Greeting could not be sent.").slice(0, 300);
    console.error("Greeting send failed:", message);
    await chatRef.set({
      greetingStatus: "failed",
      greetingLastError: message,
      greetingFailedAt: new Date()
    }, { merge: true });
  }
}

async function updateMessageStatus(status) {
  const db = getDb();

  const messageId = status.id;
  const recipient = normalizePhoneNumber(status.recipient_id);
  const nextStatus = status.status;

  if (
    !messageId ||
    !recipient ||
    !["sent", "delivered", "read", "failed"].includes(nextStatus)
  ) {
    return;
  }

  const messageRef = db
    .collection("chats")
    .doc(recipient)
    .collection("messages")
    .doc(messageId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(messageRef);
    if (!snapshot.exists) return;

    const currentStatus = snapshot.data().status;
    const rank = { failed: 0, sent: 1, delivered: 2, read: 3 };
    if (rank[nextStatus] <= (rank[currentStatus] ?? -1)) {
      return;
    }

    transaction.update(messageRef, {
      status: nextStatus,
      statusUpdatedAt: new Date()
    });
  });
}



function decryptOrganisationWhatsAppToken(record) {
  const keyHex = process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("WhatsApp credential encryption key is not configured.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function maybeRunOrganisationAutomation(orgId, phone, message, contactName) {
  if (!message || !message.id || !phone) return;
  const db = getDb();
  const orgRef = db.collection("organisations").doc(orgId);
  const [settingsSnapshot, connectionSnapshot, contactSnapshot] = await Promise.all([
    orgRef.collection("automation").doc("settings").get(),
    orgRef.collection("whatsappConnections").doc("primary").get(),
    orgRef.collection("contacts").doc(phone).get()
  ]);
  if (!settingsSnapshot.exists || !connectionSnapshot.exists) return;
  const settings = settingsSnapshot.data() || {};
  const connection = connectionSnapshot.data() || {};
  if (!connection.accessTokenEncrypted || !connection.phoneNumberId) return;
  const priorContact = contactSnapshot.exists ? contactSnapshot.data() : {};
  if (priorContact.whatsappOptOut === true) return;
  const body = message.type === "text" ? String(message.text?.body || "").trim() : "";
  let action = null;
  const lastAwayAt = priorContact.awaySentAt?.toDate
    ? priorContact.awaySentAt.toDate()
    : priorContact.awaySentAt ? new Date(priorContact.awaySentAt) : null;
  const awayWindowElapsed = !lastAwayAt || Number.isNaN(lastAwayAt.getTime())
    || Date.now() - lastAwayAt.getTime() >= 24 * 60 * 60 * 1000;
  if (settings.awayEnabled && settings.awayText && awayWindowElapsed) {
    action = { kind: "away", text: settings.awayText };
  } else if (!priorContact.greetingSentAt && settings.greetingEnabled && settings.greetingText) {
    action = { kind: "greeting", text: settings.greetingText };
  } else if (body && Array.isArray(settings.keywordRules)) {
    const normalized = body.toLowerCase();
    const rule = settings.keywordRules.find((item) =>
      item.enabled !== false && item.keyword &&
      normalized.includes(String(item.keyword).toLowerCase())
    );
    if (rule) action = { kind: "keyword", text: rule.reply };
  }
  if (!action || !action.text) return;

  const eventId = crypto.createHash("sha256")
    .update(String(message.id) + ":" + action.kind).digest("hex");
  const eventRef = orgRef.collection("automationEvents").doc(eventId);
  const contactRef = orgRef.collection("contacts").doc(phone);
  const claimed = await db.runTransaction(async (tx) => {
    const [eventSnapshot, currentContactSnapshot] = await Promise.all([
      tx.get(eventRef), tx.get(contactRef)
    ]);
    if (eventSnapshot.exists) return false;
    const currentContact = currentContactSnapshot.exists ? currentContactSnapshot.data() : {};
    if (action.kind === "greeting" && currentContact.greetingSentAt) return false;
    if (action.kind === "away" && currentContact.awaySentAt) {
      const sentAt = currentContact.awaySentAt.toDate
        ? currentContact.awaySentAt.toDate()
        : new Date(currentContact.awaySentAt);
      if (!Number.isNaN(sentAt.getTime()) && Date.now() - sentAt.getTime() < 24 * 60 * 60 * 1000) return false;
    }
    tx.create(eventRef, {
      messageId: message.id, customerPhone: phone, kind: action.kind,
      status: "processing", createdAt: new Date()
    });
    if (action.kind === "greeting") tx.set(contactRef, { greetingSentAt: new Date() }, { merge: true });
    if (action.kind === "away") tx.set(contactRef, { awaySentAt: new Date() }, { merge: true });
    return true;
  });
  if (!claimed) return;

  try {
    const sent = await sendWhatsAppText(phone, action.text, null, credentials);
    const now = new Date();
    const chatRef = orgRef.collection("chats").doc(phone);
    await chatRef.collection("messages").doc(sent.messageId).set({
      messageId: sent.messageId, chatId: phone, direction: "outgoing",
      type: "text", text: action.text, timestamp: now, status: "sent",
      source: "automation", automationKind: action.kind, sender: "business"
    });
    await chatRef.set({
      organisationId: orgId, customerPhone: phone, customerName: contactName,
      lastMessage: action.text, lastMessageAt: now,
      lastMessageDirection: "outgoing", updatedAt: now
    }, { merge: true });
    await eventRef.set({
      status: "sent", outgoingMessageId: sent.messageId, completedAt: now
    }, { merge: true });
  } catch (error) {
    await eventRef.set({
      status: "failed",
      error: String(error.message || "Send failed").slice(0, 250),
      completedAt: new Date()
    }, { merge: true });
    console.error("Organisation automation send failed:", error);
  }
}

function shouldAdvanceDeliveryStatus(current, next) {
  const rank = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5, cancelled: 6 };
  if (!Object.prototype.hasOwnProperty.call(rank, next)) return false;
  if (current === "read" || current === "cancelled" || current === "failed") return false;
  if (next === "failed") return current !== "delivered" && current !== "read";
  return rank[next] > (rank[current] ?? -1);
}

async function updateCampaignRecipientStatus(db, orgId, phone, messageId, nextStatus, timestamp) {
  const matches = await db.collectionGroup("recipients")
    .where("messageId", "==", messageId).limit(10).get();
  for (const recipientDoc of matches.docs) {
    const campaignRef = recipientDoc.ref.parent.parent;
    if (!campaignRef || campaignRef.parent.parent?.id !== orgId) continue;
    await db.runTransaction(async (tx) => {
      const [recipientSnap, campaignSnap] = await Promise.all([
        tx.get(recipientDoc.ref), tx.get(campaignRef)
      ]);
      if (!recipientSnap.exists || !campaignSnap.exists) return;
      const recipient = recipientSnap.data();
      if (normalizePhoneNumber(recipient.phone) !== phone) return;
      if (!shouldAdvanceDeliveryStatus(recipient.status, nextStatus)) return;
      tx.update(recipientDoc.ref, {
        status: nextStatus,
        statusUpdatedAt: timestamp,
        updatedAt: timestamp,
        ...(nextStatus === "failed" ? { failedAt: timestamp } : {}),
        ...(nextStatus === "delivered" ? { deliveredAt: timestamp } : {}),
        ...(nextStatus === "read" ? { readAt: timestamp } : {})
      });
      tx.set(campaignRef, {
        lastDeliveryStatusAt: timestamp,
        updatedAt: timestamp
      }, { merge: true });
    });
  }
}

async function processOrganisationWebhookChange(orgId, value) {
  const db = getDb();
  const orgRef = db.collection("organisations").doc(orgId);
  const contacts = value.contacts || [];

  for (const message of value.messages || []) {
    const phone = normalizePhoneNumber(message.from);
    if (!phone || !message.id) continue;
    const contact = contacts.find((item) => item.wa_id === message.from);
    const contactName = String(contact?.profile?.name || message.from || phone).slice(0, 100);
    const media = message[message.type] || {};
    const text = message.type === "text"
      ? String(message.text?.body || "").slice(0, 4096)
      : String(media.caption || media.title || (message.type === "location" && message.location
        ? String(message.location.latitude) + ", " + String(message.location.longitude)
        : String(message.type || "Unsupported") + " message")).slice(0, 4096);
    const timestamp = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
    if (Number.isNaN(timestamp.getTime())) continue;

    const chatRef = orgRef.collection("chats").doc(phone);
    const messageRef = chatRef.collection("messages").doc(message.id);
    await db.runTransaction(async (tx) => {
      const [existing, chat] = await Promise.all([tx.get(messageRef), tx.get(chatRef)]);
      if (existing.exists) return;
      const previousUnread = chat.exists ? Number(chat.data().unreadCount || 0) : 0;
      tx.create(messageRef, {
        messageId: message.id,
        chatId: phone,
        direction: "incoming",
        type: String(message.type || "unknown"),
        text,
        timestamp,
        status: "received",
        source: "whatsapp",
        sender: phone,
        mediaRetained: false
      });
      tx.set(chatRef, {
        organisationId: orgId,
        customerPhone: phone,
        customerName: contactName,
        lastMessage: text,
        lastMessageAt: timestamp,
        lastMessageDirection: "incoming",
        unreadCount: previousUnread + 1,
        updatedAt: new Date()
      }, { merge: true });
    });

    await orgRef.collection("contacts").doc(phone).set({
      phone: "+" + phone,
      phoneId: phone,
      name: contactName,
      source: "whatsapp",
      lastSeenAt: new Date(),
      updatedAt: new Date()
    }, { merge: true });

    const stopWords = new Set(["stop", "unsubscribe", "cancel", "end", "quit"]);
    const inboundText = message.type === "text" ? String(message.text?.body || "").trim().toLowerCase() : "";
    if (stopWords.has(inboundText)) {
      const contactRef = orgRef.collection("contacts").doc(phone);
      const eventRef = contactRef.collection("consentEvents").doc();
      await db.runTransaction(async (tx) => {
        tx.set(contactRef, {
          whatsappOptIn: false, whatsappOptOut: true,
          whatsappOptOutAt: new Date(), whatsappOptOutSource: "customer_keyword",
          updatedAt: new Date()
        }, { merge: true });
        tx.create(eventRef, {
          status: "opted_out", source: "customer_keyword",
          keyword: inboundText, actorUid: "customer", createdAt: new Date()
        });
      });
      continue;
    }

    await maybeRunOrganisationAutomation(orgId, phone, message, contactName);
  }

  for (const status of value.statuses || []) {
    const phone = normalizePhoneNumber(status.recipient_id);
    const messageId = String(status.id || "");
    const nextStatus = status.status;
    if (!phone || !messageId || !["sent", "delivered", "read", "failed"].includes(nextStatus)) continue;
    const messageRef = orgRef.collection("chats").doc(phone).collection("messages").doc(messageId);
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(messageRef);
      if (!snapshot.exists) return;
      const rank = { failed: 0, sent: 1, delivered: 2, read: 3 };
      const current = snapshot.data().status;
      if ((rank[nextStatus] ?? -1) <= (rank[current] ?? -1)) return;
      tx.update(messageRef, { status: nextStatus, statusUpdatedAt: new Date() });
    });
    await updateCampaignRecipientStatus(db, orgId, phone, messageId, nextStatus, new Date());
  }
}

async function processWebhookPayload(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || "");
      if (phoneNumberId) {
        const mapping = await getDb().collection("whatsappPhoneNumbers").doc(phoneNumberId).get();
        if (mapping.exists && mapping.data().orgId) {
          await processOrganisationWebhookChange(mapping.data().orgId, value);
          continue;
        }
      }

      const contacts = value.contacts || [];
      const messages = value.messages || [];

      for (const message of messages) {
        const contact = contacts.find(
          (item) => item.wa_id === message.from
        );

        const contactName =
          contact?.profile?.name || message.from;

        const created = await saveIncomingMessage(message, contactName);
        if (created) {
          if (message.type === "text") {
            try {
              await sendIncomingTextNotification(
                normalizePhoneNumber(message.from),
                contactName,
                message.text?.body,
                message.id
              );
            } catch (error) {
              console.error("Incoming message push notification failed:", error);
            }
          }

          await maybeSendGreeting(
            normalizePhoneNumber(message.from),
            message
          );
        }
      }

      for (const status of value.statuses || []) {
        await updateMessageStatus(status);
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
  shouldAdvanceDeliveryStatus
};
