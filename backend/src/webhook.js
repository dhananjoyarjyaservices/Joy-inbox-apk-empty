
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

  if (!verifyToken) {
    return {
      statusCode: 500,
      body: "Webhook verify token is not configured."
    };
  }

  if (mode === "subscribe" && token === verifyToken) {
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
  const mediaId = mediaMessage.id || "";
  let media = null;
  let mediaError = "";

  if (mediaId) {
    try {
      media = await downloadWhatsAppMedia(
        mediaId,
        phone,
        messageId,
        mediaMessage.filename
      );
    } catch (error) {
      mediaError =
        error instanceof Error ? error.message : "Media could not be retrieved.";
      console.error("Incoming media retrieval failed:", mediaError);
    }
  }

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
      mediaId: media?.mediaId || mediaId || null,
      mediaStoragePath: media?.storagePath || null,
      mediaMimeType: media?.mimeType || mediaMessage.mime_type || null,
      mediaSize: media?.size || Number(mediaMessage.file_size) || null,
      mediaFilename: String(mediaMessage.filename || "").slice(0, 180) || null,
      mediaSha256: media?.sha256 || null,
      mediaDownloadError: mediaError || null,
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

async function updateTenantMessageStatus(organization, status) {
  const messageId = String(status.id || "");
  const recipient = normalizePhoneNumber(status.recipient_id);
  const nextStatus = status.status;
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(messageId) || !recipient ||
      !["sent", "delivered", "read", "failed"].includes(nextStatus)) return;
  const ref = organization.ref.collection("chats").doc(recipient).collection("messages").doc(messageId);
  await ref.update({ status: nextStatus, statusUpdatedAt: new Date() }).catch((error) => {
    if (error.code !== 5 && error.code !== "not-found") throw error;
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
  receiveWebhook
};
