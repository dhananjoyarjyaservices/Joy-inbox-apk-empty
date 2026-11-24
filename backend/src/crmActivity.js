"use strict";

const TRACKED_FIELDS = ["title", "stageId", "stageName", "ownerUid", "value", "currency", "source", "nextFollowUpAt", "contactId"];

function summarizeLead(lead = {}) {
  const result = {};
  for (const key of TRACKED_FIELDS) {
    const value = lead[key];
    if (value instanceof Date) result[key] = value.toISOString();
    else if (value && typeof value.toDate === "function") result[key] = value.toDate().toISOString();
    else if (value !== undefined && value !== null) result[key] = value;
    else result[key] = null;
  }
  return result;
}

function buildCrmActivityEvent({ organizationId, leadId, actorUid, action, before, after, at = new Date() }) {
  if (!organizationId || !leadId || !actorUid || !["created", "updated", "deleted"].includes(action)) {
    const error = new Error("CRM activity event details are invalid.");
    error.statusCode = 400;
    throw error;
  }
  const previous = before ? summarizeLead(before) : null;
  const current = after ? summarizeLead(after) : null;
  const changedFields = action === "updated"
    ? TRACKED_FIELDS.filter(key => JSON.stringify(previous?.[key] ?? null) !== JSON.stringify(current?.[key] ?? null))
    : [];
  return {
    organizationId,
    leadId,
    actorUid,
    action,
    changedFields,
    before: previous,
    after: current,
    createdAt: at
  };
}

async function recordCrmActivity(db, input) {
  const event = buildCrmActivityEvent(input);
  const ref = db.collection("organizations").doc(input.organizationId).collection("crmActivity").doc();
  await ref.create(event);
  return { id: ref.id, ...event };
}

async function listCrmActivity(organization, leadId, limit = 50) {
  if (typeof leadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) {
    const error = new Error("A valid CRM lead ID is required.");
    error.statusCode = 400;
    throw error;
  }
  const lead = await organization.ref.collection("crmLeads").doc(leadId).get();
  if (!lead.exists) {
    const error = new Error("Lead was not found.");
    error.statusCode = 404;
    throw error;
  }
  const snapshot = await organization.ref.collection("crmActivity")
    .where("leadId", "==", leadId).orderBy("createdAt", "desc").limit(limit).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

module.exports = { TRACKED_FIELDS, summarizeLead, buildCrmActivityEvent, recordCrmActivity, listCrmActivity };
