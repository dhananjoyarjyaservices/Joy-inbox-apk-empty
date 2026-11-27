"use strict";

function apiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function timestampToIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate()
    : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeCampaignPageSize(value) {
  if (value === undefined || value === null || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw apiError("Campaign page size must be an integer from 1 to 100.");
  }
  return limit;
}

function serializePublicCampaign(document) {
  const value = document.data() || {};
  return {
    id: document.id,
    name: String(value.name || ""),
    status: String(value.status || "draft"),
    templateName: String(value.templateName || ""),
    language: String(value.language || ""),
    category: String(value.category || ""),
    phoneNumberId: String(value.phoneNumberId || ""),
    recipientCount: Number(value.recipientCount || 0),
    skippedRecipients: Number(value.skippedRecipients || 0),
    sentCount: Number(value.sentCount || 0),
    failedCount: Number(value.failedCount || 0),
    uncertainCount: Number(value.uncertainCount || 0),
    deliveredCount: Number(value.deliveredCount || 0),
    readCount: Number(value.readCount || 0),
    deliveryFailedCount: Number(value.deliveryFailedCount || 0),
    skippedCount: Number(value.skippedCount || 0),
    scheduledAt: timestampToIso(value.scheduledAt),
    createdAt: timestampToIso(value.createdAt),
    updatedAt: timestampToIso(value.updatedAt)
  };
}

async function listPublicCampaigns(db, organizationId, options = {}) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId || "")) {
    throw apiError("A valid API key workspace is required.", 403);
  }
  const limit = normalizeCampaignPageSize(options.limit);
  const collection = db.collection("organizations").doc(organizationId).collection("campaigns");
  let query = collection.orderBy("createdAt", "desc");
  if (options.cursor) {
    const cursor = String(options.cursor);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) throw apiError("Invalid campaign cursor.");
    const cursorSnapshot = await collection.doc(cursor).get();
    if (!cursorSnapshot.exists) throw apiError("Campaign cursor was not found in this workspace.");
    query = query.startAfter(cursorSnapshot);
  }
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const documents = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
  return {
    data: documents.map(serializePublicCampaign),
    pagination: {
      limit,
      hasMore,
      nextCursor: hasMore && documents.length ? documents[documents.length - 1].id : null
    }
  };
}

module.exports = { listPublicCampaigns, normalizeCampaignPageSize, serializePublicCampaign };
