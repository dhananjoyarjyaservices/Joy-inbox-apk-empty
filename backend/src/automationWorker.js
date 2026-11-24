"use strict";

const { getDb } = require("./firebase");
const { getWhatsAppCredentials } = require("./tenancy");
const { sendWhatsAppText } = require("./whatsapp");
const { reserveOutboundMessage, finishOutboundReservation } = require("./tenantUsage");

const MAX_JOBS_PER_INVOCATION = 25;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60 * 1000;

function retryDelayMs(attempt) {
  const safeAttempt = Math.max(1, Math.min(MAX_ATTEMPTS, Number(attempt) || 1));
  return Math.min(15 * 60 * 1000, 1000 * (2 ** (safeAttempt - 1)));
}

function getFailureDisposition(error, sendAttempted, attempts) {
  const rateLimited = Number(error?.metaStatusCode) === 429;
  const definitive = error?.definitive === true;
  const explicitlyRetryable = error?.retryable === true;
  if (sendAttempted && !definitive && !rateLimited) return "uncertain";
  if ((rateLimited || (!definitive && explicitlyRetryable)) && attempts < MAX_ATTEMPTS) return "queued";
  return "failed";
}

function automationRuleAllowsQueue(ruleSnapshot) {
  return Boolean(ruleSnapshot && ruleSnapshot.exists === true && ruleSnapshot.data()?.enabled === true);
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

async function claimQueueJob(db, jobRef, now) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef);
    if (!snapshot.exists) return null;
    const job = snapshot.data();
    if (job.status !== "queued" || timestampMillis(job.dueAt) > now.getTime()) return null;
    const attempts = Number(job.attempts || 0) + 1;
    transaction.update(jobRef, {
      status: "sending",
      attempts,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      startedAt: now,
      updatedAt: now
    });
    return { ...job, attempts };
  });
}

async function processClaimedJob(db, jobRef, job, organizationRef, dependencies = {}) {
  const sendText = dependencies.sendWhatsAppText || sendWhatsAppText;
  const getCredentials = dependencies.getWhatsAppCredentials || getWhatsAppCredentials;
  const now = dependencies.now ? dependencies.now() : new Date();
  const runRef = organizationRef.collection("automationRuns").doc(job.runId);
  const chatRef = organizationRef.collection("chats").doc(job.customerPhone);

  let sendAttempted = false;
  let quotaReservation = null;
  try {
    const runSnapshot = await runRef.get();
    if (!runSnapshot.exists) throw Object.assign(new Error("Automation run was not found."), { definitive: true });
    const run = runSnapshot.data();
    const ruleRef = organizationRef.collection("automationRules").doc(String(job.ruleId || ""));
    const ruleSnapshot = await ruleRef.get();
    if (!automationRuleAllowsQueue(ruleSnapshot)) {
      await jobRef.update({ status: "skipped", reason: "automation_rule_disabled_or_deleted", leaseUntil: null, updatedAt: now });
      await runRef.set({ status: "skipped", reason: "automation_rule_disabled_or_deleted", updatedAt: now }, { merge: true });
      return "skipped";
    }
    const completedSteps = Number(run.completedSteps || 0);
    if (completedSteps < Number(job.stepIndex || 0)) {
      await jobRef.update({ status: "queued", dueAt: new Date(now.getTime() + 10000), leaseUntil: null, updatedAt: now });
      return "deferred";
    }
    if (timestampMillis(job.windowExpiresAt) && timestampMillis(job.windowExpiresAt) <= now.getTime()) {
      await jobRef.update({ status: "skipped", reason: "outside_whatsapp_service_window", leaseUntil: null, updatedAt: now });
      await runRef.set({ status: "skipped", reason: "outside_whatsapp_service_window", updatedAt: now }, { merge: true });
      return "skipped";
    }

    const credentials = await getCredentials(db, job.organizationId, job.phoneNumberId || undefined);
    quotaReservation = await reserveOutboundMessage(db, job.organizationId, `automation_queue_${job.runId}_${Number(job.stepIndex || 0) + 1}`);
    sendAttempted = true;
    const result = await sendText(job.customerPhone, job.text, undefined, credentials);
    await finishOutboundReservation(db, quotaReservation, "sent");
    const sentAt = new Date();
    const batch = db.batch();
    batch.set(chatRef.collection("messages").doc(result.messageId), {
      messageId: result.messageId,
      chatId: job.customerPhone,
      organizationId: job.organizationId,
      direction: "outgoing",
      type: "text",
      text: job.text,
      timestamp: sentAt,
      status: "sent",
      source: "automation",
      automationRuleId: job.ruleId,
      automationStep: Number(job.stepIndex || 0) + 1,
      phoneNumberId: credentials.phoneNumberId || null,
      sender: "system"
    });
    batch.set(chatRef, {
      lastMessage: job.text,
      lastMessageAt: sentAt,
      lastMessageDirection: "outgoing",
      ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}),
      updatedAt: sentAt
    }, { merge: true });
    batch.update(jobRef, {
      status: "sent",
      responseMessageId: result.messageId,
      sentAt,
      leaseUntil: null,
      updatedAt: sentAt
    });
    batch.set(runRef, {
      responseMessageIds: [...(Array.isArray(run.responseMessageIds) ? run.responseMessageIds : []), result.messageId],
      completedSteps: Number(job.stepIndex || 0) + 1,
      totalSteps: Number(job.totalSteps || 1),
      status: Number(job.stepIndex || 0) + 1 >= Number(job.totalSteps || 1) ? "sent" : "sending",
      updatedAt: sentAt,
      ...(Number(job.stepIndex || 0) + 1 >= Number(job.totalSteps || 1) ? { sentAt } : {})
    }, { merge: true });
    await batch.commit();
    return "sent";
  } catch (error) {
    if (quotaReservation) {
      await finishOutboundReservation(db, quotaReservation, error?.definitive === true || Number(error?.metaStatusCode) === 429 ? "failed" : "sent");
    }
    const attempts = Number(job.attempts || 1);
    const disposition = getFailureDisposition(error, sendAttempted, attempts);
    const failedAt = new Date();
    const patch = {
      status: disposition,
      leaseUntil: null,
      error: String(error?.message || "Automation queue delivery failed.").slice(0, 300),
      updatedAt: failedAt,
      ...(disposition === "queued" ? { dueAt: new Date(failedAt.getTime() + retryDelayMs(attempts)) } : {})
    };
    if (disposition === "uncertain") {
      patch.error = "WhatsApp send was attempted but delivery could not be confirmed. Manual review is required; automatic resend was prevented.";
    }
    await jobRef.update(patch);
    if (disposition !== "queued") {
      await runRef.set({
        status: "partially_failed",
        ...(disposition === "uncertain" ? { uncertainStep: Number(job.stepIndex || 0) + 1 } : { failedStep: Number(job.stepIndex || 0) + 1 }),
        error: patch.error,
        updatedAt: failedAt
      }, { merge: true });
    }
    console.error("Automation queue job ended:", { jobId: jobRef.id, status: disposition, error: patch.error });
    return disposition;
  }
}

async function markExpiredQueueJobUncertain(db, stale, now) {
  const data = stale.data();
  const organizationRef = stale.ref.parent.parent;
  if (!organizationRef || !data.runId) return false;
  const runRef = organizationRef.collection("automationRuns").doc(data.runId);
  return db.runTransaction(async (transaction) => {
    const current = await transaction.get(stale.ref);
    if (!current.exists || current.data().status !== "sending" ||
        timestampMillis(current.data().leaseUntil) > now.getTime()) return false;
    transaction.update(stale.ref, {
      status: "uncertain",
      leaseUntil: null,
      error: "Worker lease expired during send. Delivery outcome needs manual review; automatic resend was prevented.",
      updatedAt: now
    });
    transaction.set(runRef, {
      status: "partially_failed",
      error: "A queued step has an uncertain delivery outcome and needs manual review.",
      failedStep: Number(data.stepIndex || 0) + 1,
      updatedAt: now
    }, { merge: true });
    return true;
  });
}

async function processAutomationQueue(options = {}) {
  const db = options.db || getDb();
  const now = options.now || new Date();
  const limit = Math.max(1, Math.min(MAX_JOBS_PER_INVOCATION, Number(options.limit) || MAX_JOBS_PER_INVOCATION));
  const staleSnapshot = await db.collectionGroup("automationQueue")
    .where("status", "==", "sending")
    .where("leaseUntil", "<=", now)
    .orderBy("leaseUntil", "asc")
    .limit(limit * 4)
    .get();
  let uncertain = 0;
  for (const stale of staleSnapshot.docs) {
    if (await markExpiredQueueJobUncertain(db, stale, now)) uncertain += 1;
  }
  const snapshot = await db.collectionGroup("automationQueue")
    .where("status", "==", "queued")
    .where("dueAt", "<=", now)
    .orderBy("dueAt", "asc")
    .limit(limit)
    .get();
  const dueJobs = snapshot.docs;
  const results = { scanned: snapshot.size, due: dueJobs.length, sent: 0, failed: 0, skipped: 0, deferred: 0, retried: 0, claimed: 0, uncertain };
  for (const document of dueJobs) {
    const organizationRef = document.ref.parent.parent;
    const data = document.data();
    if (!organizationRef || !data.runId || !data.organizationId || !data.customerPhone || !data.text) continue;
    const job = await claimQueueJob(db, document.ref, now);
    if (!job) continue;
    results.claimed += 1;
    const outcome = await processClaimedJob(db, document.ref, job, organizationRef, options.dependencies || {});
    if (outcome === "sent") results.sent += 1;
    else if (outcome === "failed") results.failed += 1;
    else if (outcome === "skipped") results.skipped += 1;
    else if (outcome === "deferred") results.deferred += 1;
    else if (outcome === "queued") results.retried += 1;
  }
  return results;
}

async function handler(event = {}) {
  if (event.source && event.source !== "aws.events" && event.source !== "aws.scheduler") {
    return { statusCode: 400, body: "Unsupported worker invocation source." };
  }
  const result = await processAutomationQueue();
  console.log("Automation queue worker completed:", result);
  return result;
}

module.exports = {
  MAX_JOBS_PER_INVOCATION,
  MAX_ATTEMPTS,
  retryDelayMs,
  timestampMillis,
  automationRuleAllowsQueue,
  getFailureDisposition,
  claimQueueJob,
  markExpiredQueueJobUncertain,
  processClaimedJob,
  processAutomationQueue,
  handler
};
