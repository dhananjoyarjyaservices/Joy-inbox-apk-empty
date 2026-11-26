"use strict";

const crypto = require("crypto");
const dynamodb = require("./dynamodb");

const OPT_IN_KEYWORDS = new Set(["start", "unstop", "subscribe"]);
const OPT_OUT_KEYWORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "remove", "optout"
]);

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function suppressionId(phone) {
  const normalized = normalizePhone(phone);
  if (!/^[1-9][0-9]{7,14}$/.test(normalized)) {
    const error = new Error("A valid international phone number is required for campaign suppression.");
    error.statusCode = 400;
    throw error;
  }
  const configuredKey = process.env.CAMPAIGN_SUPPRESSION_HASH_KEY;
  if (!configuredKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CAMPAIGN_SUPPRESSION_HASH_KEY must be configured in production.");
    }
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }
  const key = Buffer.from(configuredKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== configuredKey) {
    throw new Error("CAMPAIGN_SUPPRESSION_HASH_KEY must be a base64-encoded 32-byte key.");
  }
  return crypto.createHmac("sha256", key).update(normalized).digest("hex");
}

function isWhatsAppOptOutMessage(value) {
  const text = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (!text || text.length > 160) return false;
  const token = text.replace(/[.!?,;:]+$/g, "").replace(/[\s_-]+/g, "").replace(/[\'’]/g, "");
  if (OPT_OUT_KEYWORDS.has(token)) return true;
  return /^(please)?(stop|unsubscribe|remove|optout)(sending|messages|me)?$/.test(token) ||
    /^(please)?stop(sending|messaging)(you|me)?(messages)?$/.test(token) ||
    /^(please)?(donot|dont)(send|message)(me)?$/.test(token);
}

function isWhatsAppOptInMessage(value) {
  const text = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (!text || text.length > 40) return false;
  return OPT_IN_KEYWORDS.has(text.replace(/[.!?,;:]+$/g, "").replace(/[\s_-]+/g, ""));
}

async function recordCampaignConsent(organizationId, phone, inboundMessageId, status) {
  dynamodb.workspaceKey(organizationId);
  if (!["active", "opted_out"].includes(status)) {
    const error = new Error("A valid campaign consent status is required.");
    error.statusCode = 400;
    throw error;
  }
  const normalized = normalizePhone(phone);
  const hash = suppressionId(normalized);
  const now = new Date().toISOString();
  const item = {
    PK: "ORG#" + organizationId,
    SK: "CAMPAIGN_SUPPRESSION#" + hash,
    entityType: "CAMPAIGN_SUPPRESSION",
    organizationId,
    phoneHash: hash,
    status,
    source: status === "opted_out" ? "whatsapp_inbound" : "whatsapp_inbound_explicit_opt_in",
    ...(status === "opted_out" ? { optedOutAt: now, lastOptOutAt: now } : { optedInAt: now }),
    lastInboundMessageId: String(inboundMessageId || "").slice(0, 256),
    updatedAt: now
  };
  await dynamodb.putItem("customers", item);
  return { id: hash, status };
}

async function recordCampaignOptOut(organizationId, phone, inboundMessageId) {
  return recordCampaignConsent(organizationId, phone, inboundMessageId, "opted_out");
}

async function recordCampaignOptIn(organizationId, phone, inboundMessageId) {
  return recordCampaignConsent(organizationId, phone, inboundMessageId, "active");
}

async function isCampaignRecipientSuppressed(organizationId, phone) {
  dynamodb.workspaceKey(organizationId);
  const hash = suppressionId(phone);
  const record = await dynamodb.getItem("customers", {
    PK: "ORG#" + organizationId,
    SK: "CAMPAIGN_SUPPRESSION#" + hash
  }, { consistentRead: true });
  return Boolean(record && record.status === "opted_out");
}

module.exports = {
  normalizePhone,
  suppressionId,
  isWhatsAppOptInMessage,
  isWhatsAppOptOutMessage,
  recordCampaignOptIn,
  recordCampaignOptOut,
  isCampaignRecipientSuppressed
};
