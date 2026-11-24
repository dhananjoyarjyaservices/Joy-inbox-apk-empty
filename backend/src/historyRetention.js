"use strict";

const { getDb } = require("./firebase");
const { getBillingPlanCatalog } = require("./billing");

const MAX_ORGANIZATIONS_PER_RUN = 20;
const MAX_CHATS_PER_ORGANIZATION = 50;
const MAX_MESSAGES_PER_RUN = 400;

function subtractUtcMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function getRetentionCutoff(planKey, now = new Date(), plans = getBillingPlanCatalog()) {
  const plan = plans.find(item => item.key === planKey);
  if (!plan) return null;
  return subtractUtcMonths(now, plan.limits.historyMonths);
}

async function getCursorSnapshot(collection, cursor) {
  if (!cursor) return null;
  const snapshot = await collection.doc(cursor).get();
  return snapshot.exists ? snapshot : null;
}

async function runScheduledHistoryRetention(db = getDb(), options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const maxOrganizations = Math.min(Math.max(Number(options.maxOrganizations) || MAX_ORGANIZATIONS_PER_RUN, 1), 100);
  const maxChatsPerOrganization = Math.min(Math.max(Number(options.maxChatsPerOrganization) || MAX_CHATS_PER_ORGANIZATION, 1), 200);
  const maxMessages = Math.min(Math.max(Number(options.maxMessages) || MAX_MESSAGES_PER_RUN, 1), 450);
  const stateRef = db.collection("systemJobs").doc("historyRetention");
  const stateSnapshot = await stateRef.get();
  let organizationCursor = String(stateSnapshot.data()?.organizationCursor || "");
  const organizationsRef = db.collection("organizations");
  const organizationCursorSnapshot = await getCursorSnapshot(organizationsRef, organizationCursor);
  if (organizationCursor && !organizationCursorSnapshot) organizationCursor = "";
  let organizationQuery = organizationsRef.where("status", "==", "active").orderBy("__name__");
  if (organizationCursor) organizationQuery = organizationQuery.startAfter(organizationCursorSnapshot);
  const organizationPage = await organizationQuery.limit(maxOrganizations + 1).get();
  const organizations = organizationPage.docs.slice(0, maxOrganizations);
  let deletedMessages = 0;
  let processedOrganizations = 0;
  let processedChats = 0;
  let nextOrganizationCursor = organizationCursor;
  let stopForMessageLimit = false;

  for (let organizationIndex = 0; organizationIndex < organizations.length; organizationIndex += 1) {
    if (deletedMessages >= maxMessages) { stopForMessageLimit = true; break; }
    const organizationDocument = organizations[organizationIndex];
    const organization = organizationDocument.data();
    const organizationRef = organizationDocument.ref;
    const subscriptionSnapshot = await organizationRef.collection("billing").doc("subscription").get();
    if (!subscriptionSnapshot.exists) {
      nextOrganizationCursor = organizationDocument.id;
      processedOrganizations += 1;
      continue;
    }
    const subscription = subscriptionSnapshot.data() || {};
    if (!["active", "trialing"].includes(String(subscription.status || ""))) {
      nextOrganizationCursor = organizationDocument.id;
      processedOrganizations += 1;
      continue;
    }
    const cutoff = getRetentionCutoff(String(subscription.plan || ""), now);
    if (!cutoff) {
      nextOrganizationCursor = organizationDocument.id;
      processedOrganizations += 1;
      continue;
    }

    const chatStateRef = organizationRef.collection("systemJobs").doc("historyRetention");
    const chatStateSnapshot = await chatStateRef.get();
    let chatCursor = String(chatStateSnapshot.data()?.chatCursor || "");
    const chatsRef = organizationRef.collection("chats");
    const chatCursorSnapshot = await getCursorSnapshot(chatsRef, chatCursor);
    if (chatCursor && !chatCursorSnapshot) chatCursor = "";
    let chatQuery = chatsRef.orderBy("__name__");
    if (chatCursor) chatQuery = chatQuery.startAfter(chatCursorSnapshot);
    const chatPage = await chatQuery.limit(maxChatsPerOrganization + 1).get();
    const chats = chatPage.docs.slice(0, maxChatsPerOrganization);
    let nextChatCursor = chatCursor;
    let organizationCompleted = true;

    for (let chatIndex = 0; chatIndex < chats.length; chatIndex += 1) {
      const chatDocument = chats[chatIndex];
      const remaining = maxMessages - deletedMessages;
      if (remaining <= 0) {
        organizationCompleted = false;
        stopForMessageLimit = true;
        break;
      }
      const messagesRef = chatDocument.ref.collection("messages");
      const messageSnapshot = await messagesRef
        .where("timestamp", "<", cutoff)
        .orderBy("timestamp", "asc")
        .limit(Math.min(remaining, 400))
        .get();
      if (messageSnapshot.docs.length) {
        const batch = db.batch();
        for (const messageDocument of messageSnapshot.docs) batch.delete(messageDocument.ref);
        await batch.commit();
        deletedMessages += messageSnapshot.docs.length;
      }
      processedChats += 1;
      const pageWasFilled = messageSnapshot.docs.length === Math.min(remaining, 400);
      if (pageWasFilled) {
        // Revisit this chat next run until its old-message page is exhausted.
        organizationCompleted = false;
        stopForMessageLimit = true;
        break;
      }
      nextChatCursor = chatDocument.id;
    }

    if (organizationCompleted) {
      const chatsExhausted = chats.length < maxChatsPerOrganization;
      await chatStateRef.set({ chatCursor: chatsExhausted ? "" : nextChatCursor, updatedAt: now }, { merge: true });
      if (chatsExhausted) {
        nextOrganizationCursor = organizationDocument.id;
        processedOrganizations += 1;
      } else {
        // Revisit this organization on the next invocation to continue its chat pages.
        stopForMessageLimit = true;
      }
    } else {
      await chatStateRef.set({ chatCursor: nextChatCursor, updatedAt: now }, { merge: true });
    }
    if (stopForMessageLimit) break;
  }

  const organizationsExhausted = organizations.length < maxOrganizations && !stopForMessageLimit;
  await stateRef.set({
    organizationCursor: organizationsExhausted ? "" : nextOrganizationCursor,
    lastRunAt: now,
    lastDeletedMessages: deletedMessages,
    lastProcessedOrganizations: processedOrganizations,
    lastProcessedChats: processedChats,
    updatedAt: now
  }, { merge: true });
  return {
    deletedMessages,
    processedOrganizations,
    processedChats,
    nextOrganizationCursor: organizationsExhausted ? null : nextOrganizationCursor,
    stoppedAtBatchLimit: stopForMessageLimit
  };
}

async function handler() {
  const result = await runScheduledHistoryRetention();
  console.info("Scheduled Joy Inbox history retention completed:", JSON.stringify(result));
  return result;
}

module.exports = {
  MAX_ORGANIZATIONS_PER_RUN,
  MAX_CHATS_PER_ORGANIZATION,
  MAX_MESSAGES_PER_RUN,
  subtractUtcMonths,
  getRetentionCutoff,
  runScheduledHistoryRetention,
  handler
};
