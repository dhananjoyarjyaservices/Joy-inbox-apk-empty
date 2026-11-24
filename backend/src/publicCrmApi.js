"use strict";

const { DEFAULT_PIPELINE_STAGES, normalizeCrmLead } = require("./crm");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function apiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function leadCollection(db, organizationId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId || "")) throw apiError("API key workspace is invalid.", 403);
  return db.collection("organizations").doc(organizationId).collection("crmLeads");
}

async function listPublicLeads(db, organizationId, rawLimit = 50) {
  const limit = Number.isInteger(Number(rawLimit)) ? Math.min(100, Math.max(1, Number(rawLimit))) : 50;
  const snapshot = await leadCollection(db, organizationId).orderBy("updatedAt", "desc").limit(limit + 1).get();
  const docs = snapshot.docs.slice(0, limit);
  return { data: docs.map(doc => ({ id: doc.id, ...doc.data() })), pagination: { limit, returned: docs.length, hasMore: snapshot.docs.length > limit } };
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
  if (!existingStages.size) {
    const now = new Date();
    const refs = DEFAULT_PIPELINE_STAGES.map(stage => organizationRef.collection("crmStages").doc(stage.id));
    await db.runTransaction(async transaction => {
      const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) transaction.create(refs[index], { ...DEFAULT_PIPELINE_STAGES[index], createdAt: now, updatedAt: now });
      });
    });
    DEFAULT_PIPELINE_STAGES.forEach(stage => existingStages.set(stage.id, stage));
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

module.exports = { listPublicLeads, savePublicLead, deletePublicLead };
