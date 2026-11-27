const { getFirebaseAdmin, getDb } = require("./firebase");
const { sendTenantSlaOverdueNotification } = require("./push");
const { getOrganizationSlaSettings } = require("./slaSettings");
const { getTenantNotificationPreferences } = require("./notificationPreferences");

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return NaN;
}

async function checkOrganization(db, admin, organizationId) {
  const settings = await getOrganizationSlaSettings(db, organizationId);
  if (!settings.enabled) return 0;
  const targetMs = settings.targetMinutes * 60 * 1000;
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - targetMs));
  const chatsQuery = db.collection("organizations").doc(organizationId)
    .collection("chats")
    .where("responsePendingSince", "<=", cutoff);
  let cursor = null;
  let notified = 0;

  // Process up to 1,000 chats per organization per scheduled invocation.
  for (let page = 0; page < 10; page += 1) {
    let query = chatsQuery.orderBy("responsePendingSince").limit(100);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const document of snapshot.docs) {
      const chat = document.data();
      const assignedTo = typeof chat.assignedTo === "string" ? chat.assignedTo : "";
      const pendingMillis = timestampMillis(chat.responsePendingSince);
      if (!assignedTo || !Number.isFinite(pendingMillis) ||
          pendingMillis > Date.now() - targetMs ||
          chat.archived === true || chat.status === "resolved") continue;

      const notificationPreferences = await getTenantNotificationPreferences(db, organizationId, assignedTo);
      if (!notificationPreferences.sla) continue;

      const chatRef = document.ref;
      const claimed = await db.runTransaction(async (transaction) => {
        const latest = await transaction.get(chatRef);
        if (!latest.exists) return false;
        const current = latest.data();
        if (timestampMillis(current.responsePendingSince) !== pendingMillis ||
            current.assignedTo !== assignedTo || current.archived === true ||
            current.status === "resolved" ||
            current.slaOverdueNotifiedFor === pendingMillis ||
            (timestampMillis(current.slaOverdueRetryAfter) > Date.now())) return false;
        transaction.update(chatRef, {
          slaOverdueNotifiedFor: pendingMillis,
          slaOverdueNotifiedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return true;
      });
      if (!claimed) continue;

      try {
        const member = await db.collection("organizations").doc(organizationId)
          .collection("members").doc(assignedTo).get();
        if (!member.exists || member.get("status") !== "active" ||
            !["owner", "admin", "agent"].includes(member.get("role"))) {
          await clearClaim(db, admin, chatRef, pendingMillis);
          continue;
        }

        const delivered = await sendTenantSlaOverdueNotification(
          organizationId,
          assignedTo,
          document.id,
          String(chat.customerName || chat.customerPhone || document.id),
          notificationPreferences
        );
        if (delivered > 0) {
          notified += 1;
          await saveTenantSlaNotification(db, organizationId, assignedTo, document.id, pendingMillis, chat.customerName || chat.customerPhone || document.id);
          await chatRef.set({
            slaOverdueRetryAfter: admin.firestore.FieldValue.delete(),
            slaOverdueAttemptCount: admin.firestore.FieldValue.delete(),
            slaOverdueLastDeliveredAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          await clearClaim(db, admin, chatRef, pendingMillis);
        }
      } catch (error) {
        await clearClaim(db, admin, chatRef, pendingMillis);
        throw error;
      }
    }

    if (snapshot.size < 100) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  return notified;
}

async function clearClaim(db, admin, chatRef, pendingMillis, retry = true) {
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(chatRef);
    if (latest.exists && latest.get("slaOverdueNotifiedFor") === pendingMillis) {
      const attempt = Number(latest.get("slaOverdueAttemptCount") || 0) + 1;
      const delayMs = Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.min(attempt - 1, 6)));
      transaction.update(chatRef, {
        slaOverdueNotifiedFor: admin.firestore.FieldValue.delete(),
        slaOverdueNotifiedAt: admin.firestore.FieldValue.delete(),
        slaOverdueAttemptCount: attempt,
        ...(retry ? { slaOverdueRetryAfter: admin.firestore.Timestamp.fromDate(new Date(Date.now() + delayMs)) } : {})
      });
    }
  });
}

async function saveTenantSlaNotification(db, organizationId, uid, chatId, pendingMillis, senderName) {
  const notificationId = `sla_${pendingMillis}_${chatId}`;
  try {
    await db.collection("organizations").doc(organizationId)
      .collection("members").doc(uid).collection("notifications").doc(notificationId).set({
        type: "sla", title: "SLA response overdue",
        body: `A customer conversation needs your reply: ${String(senderName || chatId)}`,
        chatId, createdAt: new Date(), read: false
      }, { merge: true });
  } catch (error) {
    console.error("SLA notification history write failed:", error);
  }
  return notificationId;
}

async function runScheduledSlaChecks() {
  const admin = getFirebaseAdmin();
  const db = getDb();
  let organizationsChecked = 0;
  let notificationsSent = 0;
  let cursor = null;

  // Page organizations too, so large SaaS deployments are not limited to one page.
  while (true) {
    let query = db.collection("organizations").orderBy(admin.firestore.FieldPath.documentId()).limit(100);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const organization of snapshot.docs) {
      notificationsSent += await checkOrganization(db, admin, organization.id);
      organizationsChecked += 1;
    }
    if (snapshot.size < 100) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }

  return { success: true, organizationsChecked, notificationsSent };
}

module.exports = { runScheduledSlaChecks, saveTenantSlaNotification };
