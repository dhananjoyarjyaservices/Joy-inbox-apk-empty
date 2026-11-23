const crypto = require("crypto");
const { getDb } = require("./firebase");

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const MAX_CAMPAIGNS_PER_RUN = 10;
const MAX_RECIPIENTS_PER_CAMPAIGN = 20;
const MAX_ATTEMPTS = 4;
const LEASE_MS = 5 * 60 * 1000;

function deliveryEnabled() {
  return process.env.CAMPAIGN_DELIVERY_ENABLED === "true";
}

function retryDelayMs(attempt) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attempt - 1)));
}

function decryptAccessToken(record) {
  const keyHex = String(process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("WhatsApp encryption key is not configured.");
  if (!record || !record.iv || !record.authTag || !record.ciphertext) throw new Error("Encrypted WhatsApp credentials are incomplete.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function verifyApprovedTemplate(connection, campaign, accessToken) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(connection.wabaId)}/message_templates`);
  url.searchParams.set("name", campaign.templateName);
  url.searchParams.set("fields", "name,language,status,components");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body?.error?.message || "Could not verify WhatsApp template.").slice(0, 240));
  return (body.data || []).some((item) => item.name === campaign.templateName &&
    item.language === campaign.language && item.status === "APPROVED");
}

async function sendTemplate(phone, campaign, connection, accessToken) {
  const components = campaign.bodyParameters?.length ? [{
    type: "body",
    parameters: campaign.bodyParameters.map((value) => ({ type: "text", text: String(value) }))
  }] : [];
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(connection.phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone.replace(/\D/g, ""),
      type: "template",
      template: { name: campaign.templateName, language: { code: campaign.language }, ...(components.length ? { components } : {}) }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(body?.error?.message || "WhatsApp template send failed.").slice(0, 240));
    error.definitive = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw error;
  }
  const messageId = body?.messages?.[0]?.id;
  if (!messageId) throw new Error("WhatsApp did not return a message ID.");
  return messageId;
}

async function claimRecipient(db, campaignRef, recipientRef, now) {
  return db.runTransaction(async (tx) => {
    const [campaignSnap, recipientSnap] = await Promise.all([tx.get(campaignRef), tx.get(recipientRef)]);
    if (!campaignSnap.exists || !recipientSnap.exists) return null;
    const campaign = campaignSnap.data();
    const recipient = recipientSnap.data();
    if (campaign.status !== "scheduled" || recipient.status !== "queued") return null;
    const scheduledAt = campaign.scheduledAt?.toDate ? campaign.scheduledAt.toDate() : new Date(campaign.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt > now) return null;
    const nextAttemptAt = recipient.nextAttemptAt?.toDate ? recipient.nextAttemptAt.toDate() : recipient.nextAttemptAt ? new Date(recipient.nextAttemptAt) : null;
    if (nextAttemptAt && nextAttemptAt > now) return null;
    tx.update(recipientRef, {
      status: "sending",
      claimedAt: now,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attemptCount: (recipient.attemptCount || 0) + 1,
      updatedAt: now
    });
    return { campaign, recipient: { ...recipient, attemptCount: (recipient.attemptCount || 0) + 1 } };
  });
}

async function processCampaign(db, campaignDoc, now) {
  const campaignRef = campaignDoc.ref;
  const campaign = campaignDoc.data();
  const orgRef = campaignRef.parent.parent;
  if (!orgRef) return { skipped: true, reason: "invalid_campaign_path" };
  const [orgSnap, connectionSnap] = await Promise.all([
    orgRef.get(),
    orgRef.collection("whatsappConnections").doc("primary").get()
  ]);
  if (!orgSnap.exists || orgSnap.data().status !== "active" || !connectionSnap.exists ||
      connectionSnap.data().status !== "credentials_verified") {
    return { skipped: true, reason: "organisation_or_connection_unavailable" };
  }
  const connection = connectionSnap.data();
  const accessToken = decryptAccessToken(connection.accessTokenEncrypted);
  const approved = await verifyApprovedTemplate(connection, campaign, accessToken);
  if (!approved) {
    await campaignRef.set({ deliveryError: "template_not_approved_or_language_missing", updatedAt: now }, { merge: true });
    return { skipped: true, reason: "template_not_approved" };
  }

  const recipients = await campaignRef.collection("recipients").where("status", "==", "queued").limit(MAX_RECIPIENTS_PER_CAMPAIGN).get();
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  for (const recipientDoc of recipients.docs) {
    const recipientRef = recipientDoc.ref;
    const claimed = await claimRecipient(db, campaignRef, recipientRef, new Date());
    if (!claimed) continue;
    const recipient = claimed.recipient;
    const phone = String(recipient.phone || "").replace(/\D/g, "");
    const contactRef = orgRef.collection("contacts").doc(phone);
    const [freshCampaign, contactSnap] = await Promise.all([campaignRef.get(), contactRef.get()]);
    const contact = contactSnap.exists ? contactSnap.data() : {};
    const tags = Array.isArray(contact.tags) ? contact.tags : [];
    const requiredTags = Array.isArray(claimed.campaign.audience?.tags) ? claimed.campaign.audience.tags : [];
    const consentValid = contact.whatsappOptIn === true && Boolean(contact.whatsappOptInAt) && contact.whatsappOptOut !== true &&
      requiredTags.every((tag) => tags.includes(tag));
    if (!freshCampaign.exists || freshCampaign.data().status !== "scheduled" || !consentValid) {
      await recipientRef.set({
        status: "cancelled",
        cancellationReason: !consentValid ? "consent_or_audience_changed" : "campaign_cancelled",
        cancelledAt: new Date(),
        updatedAt: new Date()
      }, { merge: true });
      suppressed += 1;
      continue;
    }
    try {
      const messageId = await sendTemplate(phone, claimed.campaign, connection, accessToken);
      const sentAt = new Date();
      const chatRef = orgRef.collection("chats").doc(phone);
      const messageRef = chatRef.collection("messages").doc(messageId);
      const batch = db.batch();
      batch.set(recipientRef, { status: "sent", messageId, sentAt, leaseUntil: null, updatedAt: sentAt }, { merge: true });
      batch.set(messageRef, {
        messageId, chatId: phone, direction: "outgoing", type: "template",
        templateName: claimed.campaign.templateName, language: claimed.campaign.language,
        text: "", timestamp: sentAt, status: "sent", source: "campaign", campaignId: campaignRef.id
      });
      batch.set(chatRef, {
        organisationId: orgRef.id, customerPhone: phone,
        lastMessage: "Template message", lastMessageAt: sentAt,
        lastMessageDirection: "outgoing", updatedAt: sentAt
      }, { merge: true });
      await batch.commit();
      sent += 1;
    } catch (error) {
      const attempt = recipient.attemptCount || 1;
      const retryable = error.definitive !== true && attempt < MAX_ATTEMPTS;
      const failedAt = new Date();
      await recipientRef.set({
        status: retryable ? "queued" : "failed",
        lastError: String(error.message || "Delivery failed").slice(0, 240),
        nextAttemptAt: retryable ? new Date(failedAt.getTime() + retryDelayMs(attempt)) : null,
        failedAt: retryable ? null : failedAt,
        leaseUntil: null,
        updatedAt: failedAt
      }, { merge: true });
      if (!retryable) failed += 1;
    }
  }
  return { sent, suppressed, failed, considered: recipients.size };
}

async function runCampaignDelivery(db, now = new Date()) {
  if (!deliveryEnabled()) return { enabled: false, processedCampaigns: 0, message: "Campaign delivery is disabled. Set CAMPAIGN_DELIVERY_ENABLED=true only after production checks." };
  const due = await db.collectionGroup("campaigns")
    .where("status", "==", "scheduled")
    .where("scheduledAt", "<=", now)
    .limit(MAX_CAMPAIGNS_PER_RUN)
    .get();
  const results = [];
  for (const doc of due.docs) {
    try {
      results.push({ campaignId: doc.id, ...(await processCampaign(db, doc, now)) });
    } catch (error) {
      console.error("Campaign worker error:", doc.id, String(error.message || error).slice(0, 240));
      results.push({ campaignId: doc.id, error: String(error.message || "worker_error").slice(0, 160) });
    }
  }
  return { enabled: true, processedCampaigns: results.length, results };
}

exports.handler = async () => {
  const result = await runCampaignDelivery(getDb());
  return { statusCode: 200, body: JSON.stringify(result) };
};
exports.deliveryEnabled = deliveryEnabled;
exports.retryDelayMs = retryDelayMs;
exports.claimRecipient = claimRecipient;
exports.runCampaignDelivery = runCampaignDelivery;
