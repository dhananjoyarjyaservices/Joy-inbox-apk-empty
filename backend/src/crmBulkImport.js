"use strict";

const { normalizeCrmLead } = require("./crm");

function importError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function importCrmLeads(db, organization, actorUid, rows, now = new Date()) {
  if (!organization || !organization.id || !organization.ref) throw importError("A valid workspace is required.", 400);
  if (organization.role === "agent") throw importError("Only workspace owners and admins can bulk import CRM leads.", 403);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) {
    throw importError("Import between 1 and 200 leads per CSV upload.", 400);
  }

  const [fieldSnapshot, stageSnapshot] = await Promise.all([
    organization.ref.collection("crmFields").get(),
    organization.ref.collection("crmStages").get()
  ]);
  const definitions = fieldSnapshot.docs.map(document => ({ id: document.id, ...document.data() }));
  const stages = new Map(stageSnapshot.docs.map(document => [document.id, document.data()]));
  const contacts = new Map();
  const members = new Map();
  const batch = db.batch();
  const items = [];
  const errors = [];

  for (let index = 0; index < rows.length; index += 1) {
    try {
      const lead = normalizeCrmLead(rows[index], definitions);
      const stage = stages.get(lead.stageId);
      if (!stage || stage.active === false) throw importError("Choose an active pipeline stage.");
      if (lead.contactId) {
        if (!contacts.has(lead.contactId)) {
          const snapshot = await organization.ref.collection("contacts").doc(lead.contactId).get();
          contacts.set(lead.contactId, snapshot.exists);
        }
        if (!contacts.get(lead.contactId)) throw importError("Linked contact was not found in this workspace.", 404);
      }
      if (lead.ownerUid) {
        if (!members.has(lead.ownerUid)) {
          const snapshot = await organization.ref.collection("members").doc(lead.ownerUid).get();
          members.set(lead.ownerUid, snapshot.exists && snapshot.data()?.status === "active");
        }
        if (!members.get(lead.ownerUid)) throw importError("Lead owner must be an active workspace member.");
      }

      const ref = organization.ref.collection("crmLeads").doc();
      const item = {
        ...lead,
        stageName: String(stage.name || ""),
        organizationId: organization.id,
        createdAt: now,
        updatedAt: now,
        createdBy: actorUid,
        updatedBy: actorUid
      };
      batch.set(ref, item);
      items.push({ id: ref.id, ...item });
    } catch (error) {
      errors.push({ row: index + 2, error: String(error.message || "Lead row is invalid.") });
    }
  }

  if (items.length) await batch.commit();
  return { imported: items.length, failed: errors.length, items, errors };
}

module.exports = { importCrmLeads };
