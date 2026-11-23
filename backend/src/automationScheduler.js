const { getFirebaseAdmin, getDb } = require("./firebase");
const { getWhatsAppCredentials } = require("./tenancy");
const { sendWhatsAppText } = require("./whatsapp");

function isValidScheduledStepIndex(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

async function runScheduledAutomationSteps(options = {}) {
  const admin = getFirebaseAdmin();
  const db = getDb();
  const now = Date.now();
  const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(100, options.limit)) : 50;
  const due = await db.collectionGroup("automationQueue")
    .where("status", "==", "queued")
    .where("dueAt", "<=", admin.firestore.Timestamp.fromMillis(now))
    .orderBy("dueAt", "asc")
    .limit(limit)
    .get();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const document of due.docs) {
    const queueRef = document.ref;
    const queued = document.data();
    const organizationId = String(queued.organizationId || queueRef.parent.parent?.id || "");
    const organizationRef = db.collection("organizations").doc(organizationId);
    const leaseUntil = admin.firestore.Timestamp.fromMillis(now + 2 * 60 * 1000);
    const claimed = await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(queueRef);
      if (!latest.exists || latest.get("status") !== "queued") return false;
      const currentLease = latest.get("claimedUntil");
      if (currentLease && typeof currentLease.toMillis === "function" && currentLease.toMillis() > Date.now()) return false;
      transaction.update(queueRef, { claimedUntil: leaseUntil, attempts: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) continue;

    const runRef = organizationRef.collection("automationRuns").doc(String(queued.runId || ""));
    const phone = String(queued.customerPhone || "");
    const stepIndex = Number(queued.stepIndex);
    const text = String(queued.text || "");
    try {
      if (!organizationId || !phone || !text || !isValidScheduledStepIndex(stepIndex)) {
        throw new Error("Queued automation step has invalid details.");
      }
      const runSnapshot = await runRef.get();
      const completedBeforeThisStep = Number(runSnapshot.exists ? runSnapshot.get("completedSteps") : 0);
      let previousStepSent = runSnapshot.exists && completedBeforeThisStep >= stepIndex;
      if (previousStepSent && queued.previousStepQueued === true) {
        const previousRef = organizationRef.collection("automationQueue").doc(`${queued.runId}_${stepIndex}`);
        const previous = await previousRef.get();
        previousStepSent = previous.exists && previous.get("status") === "sent";
      }
      if (!previousStepSent) {
        await queueRef.set({ status: "skipped", reason: "previous_step_not_sent", claimedUntil: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await runRef.set({ status: "partially_failed", reason: "previous_step_not_sent", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        skipped += 1;
        continue;
      }
      const windowExpiresAt = queued.windowExpiresAt && typeof queued.windowExpiresAt.toMillis === "function"
        ? queued.windowExpiresAt.toMillis() : 0;
      if (windowExpiresAt <= Date.now()) {
        await queueRef.set({ status: "skipped", reason: "outside_whatsapp_service_window", claimedUntil: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await runRef.set({ status: "skipped", reason: "outside_whatsapp_service_window", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        skipped += 1;
        continue;
      }
      const credentials = await getWhatsAppCredentials(db, organizationId, queued.phoneNumberId || undefined);
      const result = await sendWhatsAppText(phone, text, undefined, credentials);
      const timestamp = new Date();
      const chatRef = organizationRef.collection("chats").doc(phone);
      const batch = db.batch();
      batch.set(chatRef.collection("messages").doc(result.messageId), {
        messageId: result.messageId, chatId: phone, organizationId, direction: "outgoing",
        type: "text", text, timestamp, status: "sent", source: "automation",
        automationRuleId: queued.ruleId || null, automationStep: stepIndex + 1,
        phoneNumberId: credentials.phoneNumberId || null, sender: "system"
      });
      batch.set(chatRef, {
        lastMessage: text, lastMessageAt: timestamp, lastMessageDirection: "outgoing",
        ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}), updatedAt: timestamp
      }, { merge: true });
      batch.set(queueRef, { status: "sent", responseMessageId: result.messageId, sentAt: timestamp, claimedUntil: null, updatedAt: timestamp }, { merge: true });
      batch.set(runRef, {
        status: stepIndex + 1 >= Number(queued.totalSteps || 1) ? "sent" : "sending",
        completedSteps: admin.firestore.FieldValue.increment(1),
        responseMessageIds: admin.firestore.FieldValue.arrayUnion(result.messageId),
        ...(stepIndex + 1 >= Number(queued.totalSteps || 1) ? { sentAt: timestamp } : {}),
        updatedAt: timestamp
      }, { merge: true });
      await batch.commit();
      sent += 1;
    } catch (error) {
      await queueRef.set({
        status: "failed",
        error: String(error?.message || "Scheduled automation step failed.").slice(0, 300),
        claimedUntil: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await runRef.set({
        status: "partially_failed",
        error: String(error?.message || "Scheduled automation step failed.").slice(0, 300),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      failed += 1;
      console.error("Scheduled automation step failed:", error);
    }
  }
  return { scanned: due.size, sent, failed, skipped };
}

module.exports = { isValidScheduledStepIndex, runScheduledAutomationSteps };
