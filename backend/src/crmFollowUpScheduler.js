"use strict";

const { getFirebaseAdmin, getDb } = require("./firebase");
const { sendTenantCrmFollowUpNotification } = require("./push");
const { getTenantNotificationPreferences } = require("./notificationPreferences");

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return NaN;
}

async function runScheduledCrmFollowUpReminders(options = {}) {
  const admin = options.admin || getFirebaseAdmin();
  const db = options.db || getDb();
  const now = options.now instanceof Date ? options.now : new Date();
  const notify = options.notify || sendTenantCrmFollowUpNotification;
  const cutoff = admin.firestore.Timestamp.fromDate(now);
  const deleteField = admin.firestore.FieldValue.delete();
  let organizationsChecked = 0;
  let leadsScanned = 0;
  let remindersSent = 0;
  let skipped = 0;
  let failed = 0;
  let organizationCursor = null;

  while (true) {
    let organizationsQuery = db.collection("organizations")
      .orderBy(admin.firestore.FieldPath.documentId()).limit(100);
    if (organizationCursor) organizationsQuery = organizationsQuery.startAfter(organizationCursor);
    const organizations = await organizationsQuery.get();
    if (organizations.empty || organizations.docs.length === 0) break;

    for (const organizationDocument of organizations.docs) {
      organizationsChecked += 1;
      const organizationId = organizationDocument.id;
      const organizationRef = db.collection("organizations").doc(organizationId);
      const dueLeads = await organizationRef.collection("crmLeads")
        .where("nextFollowUpAt", "<=", cutoff)
        .orderBy("nextFollowUpAt", "asc")
        .limit(100).get();

      for (const leadDocument of dueLeads.docs) {
        leadsScanned += 1;
        const lead = leadDocument.data();
        const ownerUid = typeof lead.ownerUid === "string" ? lead.ownerUid : "";
        const dueMillis = timestampMillis(lead.nextFollowUpAt);
        if (!ownerUid || !Number.isFinite(dueMillis) || dueMillis > now.getTime()) {
          skipped += 1;
          continue;
        }

        try {
          const stageSnapshot = await organizationRef.collection("crmStages").doc(String(lead.stageId || "")).get();
          const stage = stageSnapshot.exists ? stageSnapshot.data() : {};
          if (!stageSnapshot.exists || stage.active === false || stage.isWon === true || stage.isLost === true) {
            skipped += 1;
            continue;
          }

          const memberSnapshot = await organizationRef.collection("members").doc(ownerUid).get();
          const member = memberSnapshot.exists ? memberSnapshot.data() : {};
          if (!memberSnapshot.exists || member.status !== "active" ||
              !["owner", "admin", "agent"].includes(member.role)) {
            skipped += 1;
            continue;
          }

          const preferences = await getTenantNotificationPreferences(db, organizationId, ownerUid);
          if (!preferences.crm) {
            skipped += 1;
            continue;
          }

          const leadRef = leadDocument.ref;
          const claimed = await db.runTransaction(async transaction => {
            const latest = await transaction.get(leadRef);
            if (!latest.exists) return false;
            const current = latest.data();
            if (timestampMillis(current.nextFollowUpAt) !== dueMillis ||
                current.ownerUid !== ownerUid ||
                current.crmFollowUpReminderSentFor === dueMillis) return false;
            const activeClaim = timestampMillis(current.crmFollowUpReminderClaimedAt);
            if (current.crmFollowUpReminderClaimedFor === dueMillis &&
                Number.isFinite(activeClaim) && now.getTime() - activeClaim < 10 * 60 * 1000) return false;
            transaction.update(leadRef, {
              crmFollowUpReminderClaimedFor: dueMillis,
              crmFollowUpReminderClaimedAt: now
            });
            return true;
          });
          if (!claimed) {
            skipped += 1;
            continue;
          }

          const notificationId = `crm_followup_${leadDocument.id}_${dueMillis}`;
          await organizationRef.collection("members").doc(ownerUid)
            .collection("notifications").doc(notificationId).set({
              type: "crm_follow_up",
              title: "CRM follow-up is due",
              body: `Follow up with ${String(lead.title || "your lead").slice(0, 100)}`,
              leadId: leadDocument.id,
              organizationId,
              createdAt: now,
              read: false
            }, { merge: true });

          await notify(organizationId, ownerUid, leadDocument.id, lead.title || "your lead", preferences);
          await leadRef.set({
            crmFollowUpReminderSentFor: dueMillis,
            crmFollowUpReminderSentAt: now,
            crmFollowUpReminderClaimedFor: deleteField,
            crmFollowUpReminderClaimedAt: deleteField
          }, { merge: true });
          remindersSent += 1;
        } catch (error) {
          failed += 1;
          await db.runTransaction(async transaction => {
            const latest = await transaction.get(leadDocument.ref);
            if (!latest.exists) return;
            const current = latest.data();
            if (current.crmFollowUpReminderClaimedFor === dueMillis) {
              transaction.update(leadDocument.ref, {
                crmFollowUpReminderClaimedFor: deleteField,
                crmFollowUpReminderClaimedAt: deleteField
              });
            }
          });
          console.error("CRM follow-up reminder failed:", organizationId, leadDocument.id, error?.message || "unknown error");
        }
      }
    }

    if (organizations.docs.length < 100) break;
    organizationCursor = organizations.docs[organizations.docs.length - 1];
  }

  return { success: true, organizationsChecked, leadsScanned, remindersSent, skipped, failed };
}

module.exports = { runScheduledCrmFollowUpReminders, timestampMillis };
