const crypto = require("crypto");

const { getDb } = require("./firebase");
const { verifyMetaSignature, getRawBody } = require("./security");
const { normalizePhoneNumber, sendWhatsAppText } = require("./whatsapp");
const { resolvePhoneNumberOrganization, getWhatsAppCredentials } = require("./tenancy");
const { isWhatsAppOptInMessage, recordCampaignOptIn, isWhatsAppOptOutMessage, recordCampaignOptOut } = require("./campaignCompliance");
const { sendTenantIncomingTextNotification } = require("./push");
const { findMatchingAutomationRule, findMatchingOutOfOfficeRule, getOutOfOfficeSkipReason, selectAutomationBranch, isWithinAutomationSchedule } = require("./automationRules");
const { findMatchingFaqEntry } = require("./faqKnowledge");
const { reserveOutboundMessage, finishOutboundReservation, recordInboundMessageUsage } = require("./tenantUsage");
const { enqueueOrganizationWebhookEvent } = require("./publicWebhooks");

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
  const interactiveReply = messageType === "interactive"
    ? (message.interactive?.button_reply || message.interactive?.list_reply || null)
    : null;
  const buttonReply = messageType === "button" ? message.button || null : null;
  const rawText = messageType === "text"
    ? (typeof message.text?.body === "string" ? message.text.body : "")
    : interactiveReply && typeof interactiveReply.title === "string" ? interactiveReply.title
      : buttonReply && typeof buttonReply.text === "string" ? buttonReply.text
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
      ...(interactiveReply && typeof interactiveReply.id === "string" ? { interactiveReplyId: interactiveReply.id.slice(0, 256) } : {}),
      ...(buttonReply && typeof buttonReply.payload === "string" ? { interactiveReplyId: buttonReply.payload.slice(0, 256) } : {}),
      ...(interactiveReply || buttonReply ? { interactiveReplyTitle: String(interactiveReply?.title || buttonReply?.text || "").slice(0, 100) } : {}),
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
    .filter((rule) => typeof rule.keyword === "string" && (typeof rule.response === "string" || (Array.isArray(rule.steps) && rule.steps.length > 0)));
  const scheduleInstant = new Date();
  const regularRule = findMatchingAutomationRule(rules, body, scheduleInstant);
  let outOfOfficeRule = null;
  if (!regularRule) {
    const globalSettingsSnapshot = await organization.ref.collection("settings").doc("outOfOffice").get();
    const globalSettings = globalSettingsSnapshot.exists ? globalSettingsSnapshot.data() || {} : {};
    if (globalSettings.enabled === true && typeof globalSettings.message === "string" &&
        globalSettings.message.trim() && globalSettings.schedule &&
        !isWithinAutomationSchedule({ schedule: globalSettings.schedule }, scheduleInstant)) {
      outOfOfficeRule = {
        id: "workspace_out_of_office", name: "Workspace out-of-office",
        outOfOfficeMessage: globalSettings.message.trim(), enabled: true
      };
    } else {
      outOfOfficeRule = findMatchingOutOfOfficeRule(rules, body, scheduleInstant);
    }
  }
  let faqEntry = null;
  if (!regularRule && !outOfOfficeRule) {
    const faqSnapshot = await organization.ref.collection("faqEntries").limit(100).get();
    faqEntry = findMatchingFaqEntry(faqSnapshot.docs.map((document) => ({ id: document.id, ...document.data() })), body);
  }
  const rule = regularRule || outOfOfficeRule || (faqEntry ? {
    id: `faq_${faqEntry.id}`, name: `FAQ: ${faqEntry.question}`, response: faqEntry.answer,
    steps: [{ message: faqEntry.answer, delaySeconds: 0 }], enabled: true, priority: faqEntry.priority
  } : null);
  if (!rule) return;
  const isOutOfOffice = Boolean(outOfOfficeRule);
  const isFaq = Boolean(faqEntry);

  const inboundTimestamp = Number(inboundMessage.timestamp)
    ? new Date(Number(inboundMessage.timestamp) * 1000) : new Date();
  const withinWindow = inboundTimestamp.getTime() <= Date.now() + 5 * 60 * 1000 &&
    Date.now() - inboundTimestamp.getTime() < 24 * 60 * 60 * 1000;
  const selectedBranch = isOutOfOffice
    ? { branchName: "Out of office", branchIndex: null, steps: [{ message: rule.outOfOfficeMessage, delaySeconds: 0 }] }
    : selectAutomationBranch(rule, body);
  const selectedSteps = selectedBranch.steps;
  const steps = Array.isArray(selectedSteps) && selectedSteps.length
    ? selectedSteps.slice(0, 5).map((step) => typeof step === "string"
      ? { message: step.trim(), delaySeconds: 0 }
      : { message: String(step?.message || "").trim(), delaySeconds: Number.isInteger(step?.delaySeconds) ? Math.max(0, Math.min(86400, step.delaySeconds)) : 0 }).filter((step) => step.message)
    : [{ message: String(rule.response || "").trim(), delaySeconds: 0 }].filter((step) => step.message);
  const runId = crypto.createHash("sha256").update(String(inboundMessage.id || "") + ":" + rule.id + (isOutOfOffice ? ":ooo" : "")).digest("hex");
  const runRef = organization.ref.collection("automationRuns").doc(runId);
  const chatRef = organization.ref.collection("chats").doc(phone);
  const claimed = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(runRef);
    if (existing.exists) return false;
    const now = new Date();
    let skipReason = withinWindow ? null : "outside_whatsapp_service_window";
    if (isOutOfOffice && withinWindow) {
      const chatSnapshot = await transaction.get(chatRef);
      const chat = chatSnapshot.exists ? chatSnapshot.data() || {} : {};
      const outOfOfficeSkipReason = getOutOfOfficeSkipReason(chat, now);
      if (outOfOfficeSkipReason) {
        skipReason = outOfOfficeSkipReason;
      } else {
        transaction.set(chatRef, {
          outOfOfficeClaimedFor: runId,
          outOfOfficeClaimedAt: now
        }, { merge: true });
      }
    }
    transaction.create(runRef, {
      ruleId: rule.id,
      ruleName: String(rule.name || "Automation").slice(0, 80),
      branchName: selectedBranch.branchName,
      branchIndex: selectedBranch.branchIndex,
      mode: isOutOfOffice ? "out_of_office" : isFaq ? "faq" : "standard",
      ...(isFaq ? { faqEntryId: faqEntry.id } : {}),
      inboundMessageId: String(inboundMessage.id || "").slice(0, 256),
      customerPhone: phone,
      status: skipReason ? "skipped" : "sending",
      totalSteps: steps.length,
      completedSteps: 0,
      stepResults: steps.map((step, index) => ({ step: index + 1, status: skipReason ? "skipped" : "queued", delaySeconds: step.delaySeconds })),
      reason: skipReason,
      createdAt: now,
      updatedAt: now
    });
    return !skipReason;
  });
  if (!claimed || !withinWindow) return;

  const responseMessageIds = [];
  const firstDelayedIndex = steps.findIndex((step, index) => index > 0 && step.delaySeconds > 0);
  const immediateCount = firstDelayedIndex < 0 ? steps.length : firstDelayedIndex;
  const timestamp = new Date();
  try {
    const queueBatch = db.batch();
    let dueAt = timestamp.getTime();
    for (let index = immediateCount; index < steps.length; index += 1) {
      dueAt += steps[index].delaySeconds * 1000;
      const queueRef = organization.ref.collection("automationQueue").doc(`${runId}_${index + 1}`);
      queueBatch.set(queueRef, {
        runId, ruleId: rule.id, organizationId: organization.id, customerPhone: phone,
        phoneNumberId: credentials.phoneNumberId || null, stepIndex: index,
        branchName: selectedBranch.branchName, branchIndex: selectedBranch.branchIndex,
        totalSteps: steps.length, previousStepQueued: index > immediateCount, text: steps[index].message,
        delaySeconds: steps[index].delaySeconds, dueAt: new Date(dueAt),
        windowExpiresAt: new Date(inboundTimestamp.getTime() + 24 * 60 * 60 * 1000),
        status: "queued", attempts: 0, createdAt: timestamp, updatedAt: timestamp
      });
    }
    queueBatch.set(runRef, {
      responseMessageIds: [], completedSteps: 0, totalSteps: steps.length,
      status: "sending", updatedAt: timestamp
    }, { merge: true });
    await queueBatch.commit();

    for (let index = 0; index < immediateCount; index += 1) {
      const replyText = steps[index].message;
      const quotaReservation = await reserveOutboundMessage(db, organization.id, `automation_${runId}_${index + 1}`);
      let result;
      try {
        result = await sendWhatsAppText(phone, replyText, undefined, credentials);
        await finishOutboundReservation(db, quotaReservation, "sent");
      } catch (sendError) {
        await finishOutboundReservation(db, quotaReservation, sendError?.definitive === true ? "failed" : "sent");
        throw sendError;
      }
      const sentAt = new Date();
      responseMessageIds.push(result.messageId);
      const messageBatch = db.batch();
      messageBatch.set(chatRef.collection("messages").doc(result.messageId), {
        messageId: result.messageId, chatId: phone, organizationId: organization.id,
        direction: "outgoing", type: "text", text: replyText, timestamp: sentAt, status: "sent",
        source: isFaq ? "faq" : "automation", automationRuleId: isFaq ? null : rule.id,
        ...(isFaq ? { faqEntryId: faqEntry.id } : {}), automationStep: index + 1,
        phoneNumberId: credentials.phoneNumberId || null, sender: "system"
      });
      messageBatch.set(chatRef, {
        lastMessage: replyText, lastMessageAt: sentAt, lastMessageDirection: "outgoing",
        ...(isOutOfOffice ? { outOfOfficeSentAt: sentAt, outOfOfficeClaimedFor: null, outOfOfficeClaimedAt: null } : {}),
        ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}), updatedAt: sentAt
      }, { merge: true });
      messageBatch.set(runRef, {
        responseMessageIds: [...responseMessageIds],
        completedSteps: index + 1,
        totalSteps: steps.length,
        stepResults: steps.map((step, stepIndex) => ({ step: stepIndex + 1, status: stepIndex <= index ? "sent" : "queued", delaySeconds: step.delaySeconds, ...(stepIndex === index ? { sentAt } : {}) })),
        status: index + 1 === steps.length ? "sent" : "sending",
        updatedAt: sentAt,
        ...(index + 1 === steps.length ? { sentAt } : {})
      }, { merge: true });
      await messageBatch.commit();
    }
  } catch (error) {
    if (isOutOfOffice) {
      await db.runTransaction(async (transaction) => {
        const chatSnapshot = await transaction.get(chatRef);
        if (chatSnapshot.data()?.outOfOfficeClaimedFor === runId) {
          transaction.set(chatRef, { outOfOfficeClaimedFor: null, outOfOfficeClaimedAt: null }, { merge: true });
        }
      });
    }
    await runRef.set({
      status: responseMessageIds.length ? "partially_failed" : "failed",
      responseMessageIds, completedSteps: responseMessageIds.length, totalSteps: steps.length,
      stepResults: steps.map((step, index) => ({ step: index + 1, status: responseMessageIds.length > index ? "sent" : index === responseMessageIds.length ? "failed" : "queued", delaySeconds: step.delaySeconds, ...(index === responseMessageIds.length ? { error: String(error?.message || "Automation reply failed.").slice(0, 200) } : {}) })),
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
    const quotaReservation = await reserveOutboundMessage(db, organization.id, `greeting_${String(inboundMessage.id || "").slice(0, 220)}`);
    let result;
    try {
      result = await sendWhatsAppText(phone, greetingText, undefined, credentials);
      await finishOutboundReservation(db, quotaReservation, "sent");
    } catch (sendError) {
      await finishOutboundReservation(db, quotaReservation, sendError?.definitive === true ? "failed" : "sent");
      throw sendError;
    }
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

function getCampaignDeliveryCounterPatch(campaign, previousStatus, nextStatus) {
  const patch = {};
  const previous = previousStatus || "sent";
  if (nextStatus === "delivered" && !["delivered", "read", "failed"].includes(previous)) {
    patch.deliveredCount = Number(campaign.deliveredCount || 0) + 1;
  }
  if (nextStatus === "read") {
    if (!["delivered", "read", "failed"].includes(previous)) {
      patch.deliveredCount = Number(campaign.deliveredCount || 0) + 1;
    }
    if (previous !== "read") patch.readCount = Number(campaign.readCount || 0) + 1;
  }
  if (nextStatus === "failed" && !["delivered", "read", "failed"].includes(previous)) {
    patch.deliveryFailedCount = Number(campaign.deliveryFailedCount || 0) + 1;
  }
  return patch;
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
    const message = snapshot.data() || {};
    if (!shouldApplyMessageStatus(message.status, nextStatus)) return;
    const updatedAt = new Date();
    let campaignContext = null;
    if (message.source === "campaign" && /^[A-Za-z0-9_-]{1,128}$/.test(String(message.campaignId || ""))) {
      const campaignRef = organization.ref.collection("campaigns").doc(message.campaignId);
      const recipientId = crypto.createHash("sha256").update(recipient).digest("hex");
      const recipientRef = campaignRef.collection("recipients").doc(recipientId);
      const [campaignSnapshot, recipientSnapshot] = await Promise.all([
        transaction.get(campaignRef),
        transaction.get(recipientRef)
      ]);
      if (campaignSnapshot.exists && recipientSnapshot.exists) {
        campaignContext = {
          campaignRef,
          recipientRef,
          campaign: campaignSnapshot.data() || {},
          previousDeliveryStatus: recipientSnapshot.get("deliveryStatus") || message.status || "sent"
        };
      }
    }
    transaction.update(ref, {
      status: nextStatus,
      statusUpdatedAt: updatedAt,
      ...(deliveryError ? { deliveryError } : {})
    });
    if (campaignContext) {
      transaction.update(campaignContext.recipientRef, {
        deliveryStatus: nextStatus,
        deliveryUpdatedAt: updatedAt,
        ...(deliveryError ? { deliveryError } : {})
      });
      const counters = getCampaignDeliveryCounterPatch(
        campaignContext.campaign,
        campaignContext.previousDeliveryStatus,
        nextStatus
      );
      if (Object.keys(counters).length) {
        transaction.update(campaignContext.campaignRef, { ...counters, updatedAt });
      }
    }
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
        const phone = normalizePhoneNumber(message.from);
        // Run on every webhook delivery; the provider-message marker makes retries idempotent.
        await recordInboundMessageUsage(db, organization.id, String(message.id || ""));
        const inboundText = message.type === "text" ? String(message.text?.body || "")
          : message.type === "interactive" ? String(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "")
            : message.type === "button" ? String(message.button?.text || "") : "";
        if (created) {
          await enqueueOrganizationWebhookEvent(db, organization.id, "message.received", String(message.id || ""), {
            messageId: String(message.id || ""),
            phone,
            customerName: String(name || "").slice(0, 100),
            phoneNumberId: String(phoneNumberId),
            type: String(message.type || "unknown").slice(0, 40),
            text: String(inboundText || "").slice(0, 4096),
            timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString()
          }).catch(error => console.error("Inbound message webhook enqueue failed:", error.statusCode || "WEBHOOK_ENQUEUE_FAILED"));
        }
        if (isWhatsAppOptOutMessage(inboundText)) {
          // Re-apply suppression on webhook retries even when the inbound
          // message was already persisted before a previous suppression write failed.
          await recordCampaignOptOut(db, organization.id, phone, String(message.id || ""));
          continue;
        }
        if (isWhatsAppOptInMessage(inboundText)) {
          // START/UNSTOP is an explicit customer request to resume messages.
          // Keep this as a compliance event, not a greeting/keyword trigger.
          await recordCampaignOptIn(db, organization.id, phone, String(message.id || ""));
          continue;
        }
        if (created) {
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
              inboundText || `New ${message.type || "WhatsApp"} message`,
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
        const statusEvent = ({
          sent: "message.sent",
          delivered: "message.delivered",
          read: "message.read",
          failed: "message.failed"
        })[String(status.status || "").toLowerCase()];
        if (statusEvent) {
          const messageId = String(status.id || "");
          await enqueueOrganizationWebhookEvent(db, organization.id, statusEvent,
            `${messageId}:${String(status.status)}:${String(status.timestamp || "")}`,
            {
              messageId,
              recipient: normalizePhoneNumber(status.recipient_id || ""),
              phoneNumberId: String(phoneNumberId),
              status: String(status.status),
              timestamp: Number.isFinite(Number(status.timestamp)) && Number(status.timestamp) > 0 ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString(),
              errorCode: status.errors?.[0]?.code ? String(status.errors[0].code) : undefined,
              errorTitle: status.errors?.[0]?.title ? String(status.errors[0].title).slice(0, 200) : undefined
            }
          ).catch(error => console.error("Message status webhook enqueue failed:", error.statusCode || "WEBHOOK_ENQUEUE_FAILED"));
        }
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
  getCampaignDeliveryCounterPatch,
  isValidMetaWebhookPayload,
  isIgnorableWebhookRoutingError,
  processWebhookPayload,
  getWebhookProcessingStatusCode
};
