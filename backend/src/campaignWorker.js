"use strict";

const crypto = require("crypto");
const { getDb } = require("./firebase");
const { getWhatsAppCredentials } = require("./tenancy");
const { suppressionDocumentId } = require("./campaignCompliance");
const { isDefinitiveWhatsAppSendRejection } = require("./whatsapp");
const { reserveOutboundMessage, finishOutboundReservation } = require("./tenantUsage");

const MAX_CAMPAIGNS_PER_RUN = 5;
const MAX_RECIPIENTS_PER_CAMPAIGN = 10;
const RECIPIENT_LEASE_MS = 2 * 60 * 1000;
const MAX_RATE_LIMIT_ATTEMPTS = 5;

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function retryDelayMs(attempt) {
  return Math.min(15 * 60 * 1000, 1000 * (2 ** Math.max(0, Math.min(10, Number(attempt || 1) - 1))));
}

function classifyCampaignSendError(error, attempts) {
  if (Number(error?.metaStatusCode) === 429 && attempts < MAX_RATE_LIMIT_ATTEMPTS) return "retry";
  if (error?.definitive === true || (Number.isInteger(error?.metaStatusCode) &&
      isDefinitiveWhatsAppSendRejection(Number(error.metaStatusCode)))) return "failed";
  return "uncertain";
}

function buildTemplatePayload(campaign, recipient) {
  const variables = Array.isArray(recipient.variables) ? recipient.variables : [];
  const components = variables.length ? [{
    type: "body",
    parameters: variables.map(value => ({ type: "text", text: String(value) }))
  }] : [];
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient.phone,
    type: "template",
    template: {
      name: campaign.templateName,
      language: { code: campaign.language },
      ...(components.length ? { components } : {})
    }
  };
}

async function claimCampaignRecipient(db, campaignRef, recipientRef, now) {
  return db.runTransaction(async transaction => {
    const [campaignSnapshot, recipientSnapshot] = await Promise.all([
      transaction.get(campaignRef),
      transaction.get(recipientRef)
    ]);
    if (!campaignSnapshot.exists || !recipientSnapshot.exists) return null;
    const campaign = campaignSnapshot.data();
    const recipient = recipientSnapshot.data();
    if (!["queued", "sending"].includes(campaign.status) || recipient.status !== "pending") return null;
    if (recipient.retryAt && timestampMillis(recipient.retryAt) > now.getTime()) return null;
    const attempts = Number(recipient.attempts || 0) + 1;
    transaction.update(campaignRef, { status: "sending", startedAt: campaign.startedAt || now, updatedAt: now });
    transaction.update(recipientRef, {
      status: "sending",
      attempts,
      leaseUntil: new Date(now.getTime() + RECIPIENT_LEASE_MS),
      startedAt: now,
      updatedAt: now
    });
    return { ...recipient, attempts };
  });
}

async function finishRecipient(db, campaignRef, recipientRef, recipient, outcome, details = {}, dependencies = {}) {
  const now = dependencies.now ? dependencies.now() : new Date();
  const organizationRef = campaignRef.parent.parent;
  const recipientPhone = String(recipient.phone || "");
  const recipientId = recipientRef.id;
  return db.runTransaction(async transaction => {
    const [campaignSnapshot, recipientSnapshot] = await Promise.all([
      transaction.get(campaignRef),
      transaction.get(recipientRef)
    ]);
    if (!campaignSnapshot.exists || !recipientSnapshot.exists) return false;
    const campaign = campaignSnapshot.data();
    const current = recipientSnapshot.data();
    if (current.status !== "sending") return current.status === outcome;
    const patch = {
      status: outcome,
      leaseUntil: null,
      updatedAt: now,
      ...details
    };
    if (outcome === "sent") patch.sentAt = now;
    if (outcome === "sent" || (outcome === "uncertain" && details.messageId)) patch.deliveryStatus = "sent";
    if (outcome === "failed" || outcome === "uncertain") patch.finishedAt = now;
    transaction.update(recipientRef, patch);
    const counters = {
      sent: "sentCount",
      failed: "failedCount",
      uncertain: "uncertainCount",
      skipped: "skippedCount"
    };
    const counter = counters[outcome];
    if (counter) transaction.update(campaignRef, {
      [counter]: Number(campaign[counter] || 0) + 1,
      updatedAt: now
    });
    if ((outcome === "sent" || outcome === "uncertain") && details.messageId) {
      const chatRef = organizationRef.collection("chats").doc(recipientPhone);
      const messageRef = chatRef.collection("messages").doc(details.messageId);
      transaction.set(messageRef, {
        messageId: details.messageId,
        chatId: recipientPhone,
        organizationId: campaign.organizationId,
        direction: "outgoing",
        type: "template",
        text: "Template: " + String(campaign.templateName || ""),
        templateName: campaign.templateName,
        templateLanguage: campaign.language,
        templateVariables: { body: Array.isArray(recipient.variables) ? recipient.variables : [] },
        timestamp: now,
        status: "sent",
        ...(outcome === "uncertain" ? { persistenceUncertain: true } : {}),
        source: "campaign",
        campaignId: campaignRef.id,
        phoneNumberId: campaign.phoneNumberId,
        sender: "campaign"
      });
      transaction.set(chatRef, {
        customerPhone: recipientPhone,
        phoneNumberId: campaign.phoneNumberId,
        lastMessage: "Template: " + String(campaign.templateName || ""),
        lastMessageAt: now,
        lastMessageDirection: "outgoing",
        updatedAt: now
      }, { merge: true });
    }
    return true;
  });
}

async function markExpiredCampaignRecipient(db, campaignRef, recipientRef, now) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(recipientRef);
    if (!snapshot.exists) return false;
    const recipient = snapshot.data();
    if (recipient.status !== "sending" || timestampMillis(recipient.leaseUntil) > now.getTime()) return false;
    const campaignSnapshot = await transaction.get(campaignRef);
    if (!campaignSnapshot.exists) return false;
    const campaign = campaignSnapshot.data();
    transaction.update(recipientRef, {
      status: "uncertain",
      leaseUntil: null,
      error: "Worker lease expired during delivery. Check WhatsApp before manually retrying; automatic resend was prevented.",
      finishedAt: now,
      updatedAt: now
    });
    transaction.update(campaignRef, {
      uncertainCount: Number(campaign.uncertainCount || 0) + 1,
      updatedAt: now
    });
    return true;
  });
}

async function verifyApprovedTemplate(campaign, credentials, fetchImpl = fetch) {
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(campaign.wabaId)}/message_templates`);
  url.searchParams.set("fields", "name,status,language,category,components");
  url.searchParams.set("name", campaign.templateName);
  url.searchParams.set("limit", "100");
  const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${credentials.accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Meta template verification failed.");
    error.definitive = isDefinitiveWhatsAppSendRejection(response.status);
    error.metaStatusCode = response.status;
    throw error;
  }
  const approved = (Array.isArray(payload.data) ? payload.data : []).find(item =>
    item.name === campaign.templateName &&
    item.language === campaign.language &&
    item.status === "APPROVED" &&
    String(item.category || "").toUpperCase() === String(campaign.category || "").toUpperCase()
  );
  if (!approved) {
    const error = new Error("Campaign template is no longer approved for this language and category.");
    error.definitive = true;
    throw error;
  }
  const components = Array.isArray(approved.components) ? approved.components : [];
  const bodyText = components.find(item => item.type === "BODY")?.text || "";
  const header = components.find(item => item.type === "HEADER");
  const headerText = header?.format === "TEXT" ? header.text || "" : "";
  const headerVariables = [...String(headerText).matchAll(/\{\{\s*(\d+)\s*\}\}/g)];
  const dynamicButtons = components.some(item => item.type === "BUTTONS" && Array.isArray(item.buttons) &&
    item.buttons.some(button => button.type === "URL" && String(button.url || "").includes("{{")));
  if ((header && header.format !== "TEXT") || headerVariables.length || dynamicButtons) {
    const error = new Error("Campaign template uses a header or button parameter not supported by this campaign worker.");
    error.definitive = true;
    throw error;
  }
  const indexes = [...String(bodyText).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
  return indexes.length ? Math.max(...indexes) : 0;
}

async function sendCampaignRecipient(campaign, recipient, credentials, fetchImpl = fetch) {
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const response = await fetchImpl(
    `https://graph.facebook.com/${version}/${encodeURIComponent(credentials.phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildTemplatePayload(campaign, recipient))
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.messages?.[0]?.id) {
    const error = new Error(payload.error?.message || "Meta did not confirm campaign message delivery.");
    error.metaStatusCode = response.status;
    error.definitive = !response.ok && isDefinitiveWhatsAppSendRejection(response.status);
    error.retryable = response.status === 429;
    throw error;
  }
  return { messageId: payload.messages[0].id };
}

async function processCampaign(db, campaignRef, dependencies = {}) {
  const now = dependencies.now ? dependencies.now() : new Date();
  const fetchImpl = dependencies.fetch || fetch;
  const campaignSnapshot = await campaignRef.get();
  if (!campaignSnapshot.exists) return { campaignId: campaignRef.id, skipped: true };
  const campaign = campaignSnapshot.data();
  if (!["queued", "sending"].includes(campaign.status)) return { campaignId: campaignRef.id, skipped: true };
  const organizationRef = campaignRef.parent.parent;
  if (!organizationRef || !campaign.organizationId || !campaign.phoneNumberId) {
    await campaignRef.set({ status: "failed", error: "Campaign workspace or WhatsApp connection is missing.", updatedAt: now }, { merge: true });
    return { campaignId: campaignRef.id, failed: true };
  }

  const credentials = await (dependencies.getCredentials || getWhatsAppCredentials)(db, campaign.organizationId, campaign.phoneNumberId);
  let requiredVariables;
  try {
    requiredVariables = await verifyApprovedTemplate(campaign, credentials, fetchImpl);
  } catch (error) {
    const verificationError = String(error.message || "Template verification failed.").slice(0, 300);
    if (Number(error.metaStatusCode) === 429 || error.definitive !== true) {
      // No recipient send has been attempted, so transient verification errors
      // are safe to retry on the next scheduled worker invocation.
      await campaignRef.set({
        verificationError,
        verificationRetryAt: now,
        updatedAt: now
      }, { merge: true });
      return { campaignId: campaignRef.id, retryingVerification: true, error: verificationError };
    }
    await campaignRef.set({
      status: "failed",
      error: verificationError,
      updatedAt: now
    }, { merge: true });
    return { campaignId: campaignRef.id, failed: true, error: verificationError };
  }

  const recipientsRef = campaignRef.collection("recipients");
  const [pendingSnapshot, staleSnapshot] = await Promise.all([
    recipientsRef.where("status", "==", "pending").orderBy("updatedAt", "asc").limit(MAX_RECIPIENTS_PER_CAMPAIGN * 3).get(),
    recipientsRef.where("status", "==", "sending").limit(MAX_RECIPIENTS_PER_CAMPAIGN * 3).get()
  ]);
  let sent = 0, failed = 0, skipped = 0, uncertain = 0, retried = 0;
  for (const stale of staleSnapshot.docs) {
    if (timestampMillis(stale.get("leaseUntil")) <= now.getTime() &&
        await markExpiredCampaignRecipient(db, campaignRef, stale.ref, now)) uncertain += 1;
  }

  for (const document of pendingSnapshot.docs) {
    if (sent + failed + skipped + uncertain + retried >= MAX_RECIPIENTS_PER_CAMPAIGN) break;
    const currentCampaign = await campaignRef.get();
    if (!currentCampaign.exists || !["queued", "sending"].includes(currentCampaign.get("status"))) break;
    const recipient = await claimCampaignRecipient(db, campaignRef, document.ref, now);
    if (!recipient) continue;

    let acceptedMessageId = "";
    let quotaReservation = null;
    try {
      if (recipient.optedIn !== true || !recipient.consentSource ||
          !Number.isFinite(Date.parse(String(recipient.consentAt || ""))) ||
          Date.parse(String(recipient.consentAt || "")) > now.getTime()) {
        await finishRecipient(db, campaignRef, document.ref, recipient, "skipped", {
          reason: "missing_or_invalid_opt_in_evidence"
        }, dependencies);
        skipped += 1;
        continue;
      }

      const latestCampaign = await campaignRef.get();
      const latestStatus = latestCampaign.exists ? latestCampaign.get("status") : "cancelled";
      if (!["queued", "sending"].includes(latestStatus)) {
        if (latestStatus === "cancelled") {
          await finishRecipient(db, campaignRef, document.ref, recipient, "skipped", {
            reason: "campaign_cancelled_before_send"
          }, dependencies);
          skipped += 1;
        } else {
          await document.ref.update({ status: "pending", leaseUntil: null, updatedAt: now });
        }
        break;
      }

      const variables = Array.isArray(recipient.variables) ? recipient.variables : [];
      if (variables.length !== requiredVariables) {
        await finishRecipient(db, campaignRef, document.ref, recipient, "failed", {
          error: "Recipient template variable count does not match the approved template."
        }, dependencies);
        failed += 1;
        continue;
      }

      // Read the current campaign state and opt-out suppression together
      // immediately before Meta send; a new STOP after draft creation is honored.
      const suppressionRef = organizationRef.collection("campaignSuppressions")
        .doc(suppressionDocumentId(recipient.phone));
      const preSendState = await db.runTransaction(async transaction => {
        const [suppressionSnapshot, campaignSnapshot] = await Promise.all([
          transaction.get(suppressionRef),
          transaction.get(campaignRef)
        ]);
        return {
          suppressed: suppressionSnapshot.exists && suppressionSnapshot.get("status") !== "active",
          campaignStatus: campaignSnapshot.exists ? campaignSnapshot.get("status") : "cancelled"
        };
      });
      if (preSendState.suppressed) {
        await finishRecipient(db, campaignRef, document.ref, recipient, "skipped", {
          reason: "whatsapp_opt_out_suppression"
        }, dependencies);
        skipped += 1;
        continue;
      }

      const finalCampaignStatus = preSendState.campaignStatus;
      if (!["queued", "sending"].includes(finalCampaignStatus)) {
        if (finalCampaignStatus === "cancelled") {
          await finishRecipient(db, campaignRef, document.ref, recipient, "skipped", {
            reason: "campaign_cancelled_before_send"
          }, dependencies);
          skipped += 1;
        } else {
          await document.ref.update({ status: "pending", leaseUntil: null, updatedAt: now });
        }
        break;
      }

      quotaReservation = await reserveOutboundMessage(db, campaign.organizationId, `campaign_${campaignRef.id}_${document.id}`);
      const result = await (dependencies.sendRecipient || sendCampaignRecipient)(campaign, recipient, credentials, fetchImpl);
      acceptedMessageId = String(result.messageId || "");
      await finishOutboundReservation(db, quotaReservation, "sent");
      await finishRecipient(db, campaignRef, document.ref, recipient, "sent", {
        messageId: acceptedMessageId
      }, dependencies);
      sent += 1;
    } catch (error) {
      if (quotaReservation) {
        const definitiveFailure = error?.definitive === true || Number(error?.metaStatusCode) === 429;
        await finishOutboundReservation(db, quotaReservation, definitiveFailure ? "failed" : "sent");
      }
      if (error?.code === "MESSAGE_QUOTA_EXCEEDED") {
        await finishRecipient(db, campaignRef, document.ref, recipient, "skipped", {
          reason: "message_quota_exceeded", error: String(error.message || "Workspace message quota reached.").slice(0, 300)
        }, dependencies);
        await campaignRef.set({ status: "paused", pauseReason: "message_quota_exceeded", updatedAt: now }, { merge: true });
        skipped += 1;
        break;
      }
      const disposition = classifyCampaignSendError(error, Number(recipient.attempts || 1));
      const details = {
        error: String(error.message || "Campaign send failed.").slice(0, 300),
        ...(acceptedMessageId ? { messageId: acceptedMessageId } : {})
      };
      if (disposition === "retry") {
        details.status = "pending";
        details.retryAt = new Date(now.getTime() + retryDelayMs(recipient.attempts));
        details.leaseUntil = null;
        await document.ref.update({ ...details, updatedAt: now });
        retried += 1;
      } else {
        await finishRecipient(db, campaignRef, document.ref, recipient, disposition, details, dependencies);
        if (disposition === "uncertain") uncertain += 1;
        else failed += 1;
      }
    }
  }

  const [remainingPending, remainingSending] = await Promise.all([
    recipientsRef.where("status", "==", "pending").limit(1).get(),
    recipientsRef.where("status", "==", "sending").limit(1).get()
  ]);
  if (!remainingPending.size && !remainingSending.size) {
    const latest = await campaignRef.get();
    if (latest.exists && ["queued", "sending"].includes(latest.get("status"))) {
      const value = latest.data();
      const finalStatus = Number(value.sentCount || 0) > 0 ? "completed" : "failed";
      await campaignRef.set({ status: finalStatus, completedAt: now, updatedAt: now }, { merge: true });
    }
  }
  return { campaignId: campaignRef.id, sent, failed, skipped, uncertain, retried };
}

async function runScheduledCampaigns(options = {}) {
  const db = options.db || getDb();
  const now = options.now || new Date();
  const limit = Math.max(1, Math.min(MAX_CAMPAIGNS_PER_RUN, Number(options.limit) || MAX_CAMPAIGNS_PER_RUN));
  const scheduled = await db.collectionGroup("campaigns")
    .where("status", "==", "scheduled")
    .where("scheduledAt", "<=", now)
    .orderBy("scheduledAt", "asc")
    .limit(limit)
    .get();
  for (const document of scheduled.docs) {
    await db.runTransaction(async transaction => {
      const current = await transaction.get(document.ref);
      if (current.exists && current.get("status") === "scheduled" &&
          timestampMillis(current.get("scheduledAt")) <= now.getTime()) {
        transaction.update(document.ref, { status: "queued", queuedAt: now, updatedAt: now });
      }
    });
  }

  const [queued, sending] = await Promise.all([
    db.collectionGroup("campaigns").where("status", "==", "queued").orderBy("createdAt", "asc").limit(limit).get(),
    db.collectionGroup("campaigns").where("status", "==", "sending").orderBy("updatedAt", "asc").limit(limit).get()
  ]);
  const docs = [...queued.docs, ...sending.docs].slice(0, limit);
  const results = [];
  for (const document of docs) {
    try {
      results.push(await processCampaign(db, document.ref, options.dependencies || {}));
    } catch (error) {
      console.error("Campaign worker failed:", { campaignId: document.id, error: String(error.message || error) });
      results.push({ campaignId: document.id, error: String(error.message || "Campaign worker failed.") });
    }
  }
  return { scanned: docs.length, results };
}

async function handler(event = {}) {
  if (event.source && event.source !== "aws.events" && event.source !== "aws.scheduler") {
    return { statusCode: 400, body: "Unsupported campaign worker invocation source." };
  }
  return runScheduledCampaigns();
}

module.exports = {
  MAX_CAMPAIGNS_PER_RUN,
  MAX_RECIPIENTS_PER_CAMPAIGN,
  RECIPIENT_LEASE_MS,
  timestampMillis,
  retryDelayMs,
  classifyCampaignSendError,
  buildTemplatePayload,
  claimCampaignRecipient,
  finishRecipient,
  markExpiredCampaignRecipient,
  verifyApprovedTemplate,
  sendCampaignRecipient,
  processCampaign,
  runScheduledCampaigns,
  handler
};
