"use strict";

const { DEFAULT_PIPELINE_STAGES, normalizeCrmLead } = require("./crm");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function apiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function leadCollection(db, organizationId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId || "")) throw apiError("API key workspace is invalid.", 403);
  return db.collection("organizations").doc(organizationId).collection("crmLeads");
}

function normalizePageSize(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") return DEFAULT_PAGE_SIZE;
  const value = Number(rawLimit);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw apiError(`Page limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return value;
}

function encodeLeadCursor(document) {
  const data = document.data() || {};
  const updatedAt = typeof data.updatedAt?.toDate === "function"
    ? data.updatedAt.toDate()
    : new Date(data.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) {
    throw apiError("A lead cannot be used as a pagination cursor because its update timestamp is invalid.", 500);
  }
  return Buffer.from(JSON.stringify({ v: 1, updatedAt: updatedAt.toISOString(), id: document.id }), "utf8").toString("base64url");
}

function decodeLeadCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw apiError("Pagination cursor is invalid.");
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw apiError("Pagination cursor is invalid.");
  }
  const date = new Date(decoded?.updatedAt);
  if (decoded?.v !== 1 || !ID_PATTERN.test(decoded?.id || "") || !Number.isFinite(date.getTime())) {
    throw apiError("Pagination cursor is invalid.");
  }
  return { updatedAt: date, id: decoded.id };
}

async function listPublicLeads(db, organizationId, rawLimit = DEFAULT_PAGE_SIZE, rawCursor = null) {
  const limit = normalizePageSize(rawLimit);
  const cursor = decodeLeadCursor(rawCursor);
  let query = leadCollection(db, organizationId)
    .orderBy("updatedAt", "desc")
    .orderBy("__name__", "desc");
  if (cursor) query = query.startAfter(cursor.updatedAt, cursor.id);
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const docs = snapshot.docs.slice(0, limit);
  return {
    data: docs.map(doc => ({ id: doc.id, ...doc.data() })),
    pagination: {
      limit,
      returned: docs.length,
      hasMore,
      nextCursor: hasMore && docs.length ? encodeLeadCursor(docs[docs.length - 1]) : null
    }
  };
}

async function savePublicLead(db, organizationId, input, resourceId = "") {
  if (resourceId && !ID_PATTERN.test(resourceId)) throw apiError("A valid lead ID is required.");
  const organizationRef = db.collection("organizations").doc(organizationId);
  const [fieldSnapshot, stageSnapshot] = await Promise.all([
    organizationRef.collection("crmFields").get(),
    organizationRef.collection("crmStages").get()
  ]);
  const definitions = fieldSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const existingStages = new Map(stageSnapshot.docs.map(doc => [doc.id, doc.data()]));
  {
    const now = new Date();
    const refs = DEFAULT_PIPELINE_STAGES.map(stage => organizationRef.collection("crmStages").doc(stage.id));
    await db.runTransaction(async transaction => {
      const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) transaction.create(refs[index], { ...DEFAULT_PIPELINE_STAGES[index], createdAt: now, updatedAt: now });
      });
    });
    DEFAULT_PIPELINE_STAGES.forEach(stage => {
      if (!existingStages.has(stage.id)) existingStages.set(stage.id, stage);
    });
  }
  const lead = normalizeCrmLead(input, definitions);
  const stage = existingStages.get(lead.stageId);
  if (!stage || stage.active === false) throw apiError("Choose an active stage from this workspace's sales pipeline.");
  if (lead.contactId) {
    const contact = await organizationRef.collection("contacts").doc(lead.contactId).get();
    if (!contact.exists) throw apiError("The linked contact was not found in this workspace.", 404);
  }
  if (lead.ownerUid) {
    const owner = await organizationRef.collection("members").doc(lead.ownerUid).get();
    if (!owner.exists || owner.data()?.status !== "active") throw apiError("Lead owner must be an active workspace member.");
  }
  const collection = leadCollection(db, organizationId);
  const now = new Date();
  if (resourceId) {
    const ref = collection.doc(resourceId);
    const existing = await ref.get();
    if (!existing.exists) throw apiError("Lead was not found in this workspace.", 404);
    await ref.set({ ...lead, updatedAt: now }, { merge: true });
    return { id: resourceId, ...lead };
  }
  const ref = collection.doc();
  await ref.set({ ...lead, createdAt: now, updatedAt: now });
  return { id: ref.id, ...lead };
}

async function deletePublicLead(db, organizationId, resourceId) {
  if (!ID_PATTERN.test(resourceId || "")) throw apiError("A valid lead ID is required.");
  const ref = leadCollection(db, organizationId).doc(resourceId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw apiError("Lead was not found in this workspace.", 404);
  await ref.delete();
  return { id: resourceId, deleted: true };
}

module.exports = { listPublicLeads, savePublicLead, deletePublicLead, normalizePageSize, encodeLeadCursor, decodeLeadCursor };
