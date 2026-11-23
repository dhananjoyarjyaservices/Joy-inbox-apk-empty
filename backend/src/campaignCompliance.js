"use strict";

const crypto = require("crypto");

const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "remove",
  "optout"
]);

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function suppressionDocumentId(phone) {
  const normalized = normalizePhone(phone);
  if (!/^[1-9][0-9]{7,14}$/.test(normalized)) {
    throw new Error("A valid international phone number is required for suppression.");
  }
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function isWhatsAppOptOutMessage(value) {
  const text = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (!text || text.length > 160) return false;
  const token = text.replace(/[.!?,;:]+$/g, "").replace(/[\s_-]+/g, "");
  if (OPT_OUT_KEYWORDS.has(token)) return true;
  return /^(please)?(stop|unsubscribe|remove|optout)(sending|messages|me)?$/.test(token) ||
    /^(please)?stop(sending|messaging)(you|me)?(messages)?$/.test(token) ||
    /^(please)?(donot|dont)(send|message)(me)?$/.test(token);
}

async function recordCampaignOptOut(db, organizationId, phone, inboundMessageId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(organizationId || ""))) {
    throw new Error("A valid organization ID is required.");
  }
  const normalized = normalizePhone(phone);
  const id = suppressionDocumentId(normalized);
  const ref = db.collection("organizations").doc(organizationId)
    .collection("campaignSuppressions").doc(id);
  const now = new Date();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) {
      transaction.set(ref, {
        status: "opted_out",
        source: "whatsapp_inbound",
        optedOutAt: snapshot.data()?.optedOutAt || now,
        lastOptOutAt: now,
        lastInboundMessageId: String(inboundMessageId || "").slice(0, 256),
        updatedAt: now
      }, { merge: true });
      return;
    }
    transaction.create(ref, {
      phone: normalized,
      status: "opted_out",
      source: "whatsapp_inbound",
      optedOutAt: now,
      lastOptOutAt: now,
      lastInboundMessageId: String(inboundMessageId || "").slice(0, 256),
      createdAt: now,
      updatedAt: now
    });
  });
  return { id, phone: normalized, status: "opted_out" };
}

async function filterSuppressedCampaignRecipients(db, organizationId, recipients) {
  if (!Array.isArray(recipients)) throw new Error("Campaign recipients must be an array.");
  const organizationRef = db.collection("organizations").doc(organizationId);
  const eligible = [];
  let suppressed = 0;
  for (let offset = 0; offset < recipients.length; offset += 100) {
    const chunk = recipients.slice(offset, offset + 100);
    const refs = chunk.map((recipient) => organizationRef.collection("campaignSuppressions")
      .doc(suppressionDocumentId(recipient.phone)));
    const snapshots = await Promise.all(refs.map((ref) => ref.get()));
    chunk.forEach((recipient, index) => {
      if (snapshots[index].exists && snapshots[index].data()?.status !== "active") suppressed += 1;
      else eligible.push(recipient);
    });
  }
  return { recipients: eligible, suppressed };
}

module.exports = {
  normalizePhone,
  suppressionDocumentId,
  isWhatsAppOptOutMessage,
  recordCampaignOptOut,
  filterSuppressedCampaignRecipients
};
