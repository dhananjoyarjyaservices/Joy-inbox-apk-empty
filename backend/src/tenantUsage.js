"use strict";

const { getBillingPlanCatalog } = require("./billing");
const crypto = require("crypto");

function usageError(message, statusCode = 429, code = "MESSAGE_QUOTA_EXCEEDED") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.definitive = true;
  error.retryable = false;
  return error;
}

function asDate(value) {
  if (value && typeof value.toDate === "function") return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addUtcMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function getUsageWindow(subscription, now = new Date(), plans = getBillingPlanCatalog()) {
  const status = String(subscription?.status || "");
  if (!["active", "trialing"].includes(status)) {
    throw usageError("This workspace does not have an active subscription. Choose a plan to continue sending.", 402);
  }
  const planKey = String(subscription.plan || "unknown");
  const plan = plans.find(item => item.key === planKey);
  if (!plan) throw usageError("The subscribed plan could not be identified. Contact support before sending.", 503);
  if (status === "trialing") {
    const start = asDate(subscription.trialStart || subscription.currentPeriodStart);
    const end = asDate(subscription.trialEnd);
    if (!start || !end || now < start || now >= end) {
      throw usageError("The free trial is not currently active. Choose a plan to continue sending.", 402);
    }
    return {
      plan,
      start,
      end,
      key: "trial_" + start.getTime(),
      limit: Math.ceil(plan.limits.messages * 0.25),
      trial: true
    };
  }
  const cycleStart = asDate(subscription.currentPeriodStart);
  const cycleEnd = asDate(subscription.currentPeriodEnd);
  if (!cycleStart || !cycleEnd || cycleEnd <= cycleStart || now < cycleStart || now >= cycleEnd) {
    throw usageError("The billing period could not be verified. Sending is paused until subscription status is refreshed.", 503);
  }
  let monthIndex = 0;
  for (let month = 0; month < 12; month += 1) {
    const next = addUtcMonths(cycleStart, month + 1);
    if (now < next || next >= cycleEnd) break;
    monthIndex = month + 1;
  }
  const monthStart = addUtcMonths(cycleStart, monthIndex);
  const monthEnd = addUtcMonths(cycleStart, monthIndex + 1);
  const end = monthEnd < cycleEnd ? monthEnd : cycleEnd;
  return {
    plan,
    start: monthStart,
    end,
    key: "month_" + monthStart.getTime(),
    limit: plan.limits.messages,
    trial: false
  };
}

function getReservationId(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function getTenantMessageUsage(db, organizationId, subscription, now = new Date()) {
  if (!subscription || !["active", "trialing"].includes(String(subscription.status || ""))) return null;
  const window = getUsageWindow(subscription, now);
  const usageRef = db.collection("organizations").doc(organizationId)
    .collection("billingUsage").doc(window.key);
  const snapshot = await usageRef.get();
  const data = snapshot.exists ? snapshot.data() || {} : {};
  const used = Math.max(0, Number(data.messagesUsed || 0));
  const reserved = Math.max(0, Number(data.messagesReserved || 0));
  const percent = window.limit > 0 ? Math.min(100, Math.floor((used + reserved) / window.limit * 100)) : 100;
  const mediaBytesUsed = Math.max(0, Number(data.mediaBytesUsed || 0));
  const mediaBytesReserved = Math.max(0, Number(data.mediaBytesReserved || 0));
  const mediaLimitBytes = Math.ceil(window.plan.limits.mediaTransferGb * 1024 * 1024 * 1024 * (window.trial ? 0.25 : 1));
  const mediaPercent = mediaLimitBytes > 0 ? Math.min(100, Math.floor((mediaBytesUsed + mediaBytesReserved) / mediaLimitBytes * 100)) : 100;
  return {
    messagesUsed: used,
    messagesReserved: reserved,
    messageLimit: window.limit,
    percent,
    thresholdsReached: [80, 95, 100].filter(threshold => percent >= threshold),
    mediaBytesUsed,
    mediaBytesReserved,
    mediaLimitBytes,
    mediaPercent,
    mediaThresholdsReached: [80, 95, 100].filter(threshold => mediaPercent >= threshold),
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    trial: window.trial
  };
}

async function reserveMediaTransfer(db, organizationId, transferId, expectedBytes, now = new Date()) {
  const organizationRef = db.collection("organizations").doc(organizationId);
  const subscriptionRef = organizationRef.collection("billing").doc("subscription");
  const reservationRef = organizationRef.collection("billingMediaReservations").doc(getReservationId(transferId));
  return db.runTransaction(async transaction => {
    const subscriptionSnapshot = await transaction.get(subscriptionRef);
    if (!subscriptionSnapshot.exists) return { enforced: false, reservationRef: null };
    const subscription = subscriptionSnapshot.data() || {};
    const status = String(subscription.status || "");
    if (!status && !subscription.checkoutPlan) return { enforced: false, reservationRef: null };
    const window = getUsageWindow(subscription, now);
    const usageRef = organizationRef.collection("billingUsage").doc(window.key);
    const [usageSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(usageRef), transaction.get(reservationRef)
    ]);
    if (reservationSnapshot.exists) {
      const state = String(reservationSnapshot.get("state") || "");
      if (state === "committed" || state === "reserved") return { enforced: true, duplicate: true, reservationRef, usageRef };
    }
    const usage = usageSnapshot.exists ? usageSnapshot.data() || {} : {};
    const used = Math.max(0, Number(usage.mediaBytesUsed || 0));
    const reserved = Math.max(0, Number(usage.mediaBytesReserved || 0));
    const limit = Math.ceil(window.plan.limits.mediaTransferGb * 1024 * 1024 * 1024 * (window.trial ? 0.25 : 1));
    const available = Math.max(0, limit - used - reserved);
    const bytes = expectedBytes === null || expectedBytes === undefined
      ? available : Number(expectedBytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > available) {
      throw usageError("Media transfer limit reached for this service month. Upgrade your plan to transfer more media.", 429, "MEDIA_QUOTA_EXCEEDED");
    }
    transaction.set(usageRef, {
      plan: window.plan.key, periodKey: window.key, periodStart: window.start, periodEnd: window.end,
      mediaTransferLimitBytes: limit, mediaBytesUsed: used, mediaBytesReserved: reserved + bytes,
      trial: window.trial, updatedAt: now
    }, { merge: true });
    transaction.set(reservationRef, {
      state: "reserved", organizationId, periodKey: window.key, reservedBytes: bytes,
      createdAt: now, updatedAt: now
    }, { merge: true });
    return { enforced: true, duplicate: false, reservationRef, usageRef, reservedBytes: bytes };
  });
}

async function finishMediaTransfer(db, reservation, outcome, actualBytes, now = new Date()) {
  if (!reservation?.enforced || !reservation.reservationRef || !reservation.usageRef) return false;
  return db.runTransaction(async transaction => {
    const [reservationSnapshot, usageSnapshot] = await Promise.all([
      transaction.get(reservation.reservationRef), transaction.get(reservation.usageRef)
    ]);
    if (!reservationSnapshot.exists || String(reservationSnapshot.get("state") || "") !== "reserved") return false;
    const usage = usageSnapshot.exists ? usageSnapshot.data() || {} : {};
    const reserved = Math.max(0, Number(usage.mediaBytesReserved || 0));
    const used = Math.max(0, Number(usage.mediaBytesUsed || 0));
    const heldBytes = Math.max(0, Number(reservationSnapshot.get("reservedBytes") || 0));
    const actual = outcome === "sent" ? Math.max(0, Number(actualBytes ?? heldBytes)) : 0;
    transaction.set(reservation.usageRef, {
      mediaBytesReserved: Math.max(0, reserved - heldBytes),
      mediaBytesUsed: used + actual,
      updatedAt: now
    }, { merge: true });
    transaction.set(reservation.reservationRef, {
      state: outcome === "sent" ? "committed" : "released",
      actualBytes: actual, finishedAt: now, updatedAt: now
    }, { merge: true });
    return true;
  });
}

async function reserveOutboundMessage(db, organizationId, clientMessageId, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(organizationId || ""))) {
    throw usageError("A valid workspace is required for quota enforcement.", 400);
  }
  const organizationRef = db.collection("organizations").doc(organizationId);
  const subscriptionRef = organizationRef.collection("billing").doc("subscription");
  const reservationRef = organizationRef.collection("billingUsageReservations").doc(getReservationId(clientMessageId));
  return db.runTransaction(async transaction => {
    const subscriptionSnapshot = await transaction.get(subscriptionRef);
    if (!subscriptionSnapshot.exists) return { enforced: false, reservationRef: null };
    const subscription = subscriptionSnapshot.data() || {};
    const status = String(subscription.status || "");
    if (!status && !subscription.checkoutPlan) return { enforced: false, reservationRef: null };
    const window = getUsageWindow(subscription, now);
    const usageRef = organizationRef.collection("billingUsage").doc(window.key);
    const [usageSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(usageRef),
      transaction.get(reservationRef)
    ]);
    if (reservationSnapshot.exists) {
      const state = String(reservationSnapshot.get("state") || "");
      if (state === "committed" || state === "reserved") {
        return { enforced: true, duplicate: true, reservationRef, usageRef, limit: window.limit };
      }
    }
    const usage = usageSnapshot.exists ? usageSnapshot.data() || {} : {};
    const used = Math.max(0, Number(usage.messagesUsed || 0));
    const reserved = Math.max(0, Number(usage.messagesReserved || 0));
    if (used + reserved >= window.limit) {
      throw usageError(`Message limit reached (${window.limit.toLocaleString("en-IN")} messages for this service month). Upgrade your plan to continue sending.`);
    }
    transaction.set(usageRef, {
      plan: window.plan.key,
      periodKey: window.key,
      periodStart: window.start,
      periodEnd: window.end,
      messageLimit: window.limit,
      messagesUsed: used,
      messagesReserved: reserved + 1,
      trial: window.trial,
      updatedAt: now
    }, { merge: true });
    transaction.set(reservationRef, {
      state: "reserved",
      organizationId,
      periodKey: window.key,
      createdAt: now,
      updatedAt: now
    }, { merge: true });
    return { enforced: true, duplicate: false, reservationRef, usageRef, limit: window.limit };
  });
}

async function finishOutboundReservation(db, reservation, outcome, now = new Date()) {
  if (!reservation?.enforced || !reservation.reservationRef || !reservation.usageRef) return false;
  return db.runTransaction(async transaction => {
    const [reservationSnapshot, usageSnapshot] = await Promise.all([
      transaction.get(reservation.reservationRef),
      transaction.get(reservation.usageRef)
    ]);
    if (!reservationSnapshot.exists || String(reservationSnapshot.get("state") || "") !== "reserved") return false;
    const usage = usageSnapshot.exists ? usageSnapshot.data() || {} : {};
    const reserved = Math.max(0, Number(usage.messagesReserved || 0));
    const used = Math.max(0, Number(usage.messagesUsed || 0));
    transaction.set(reservation.usageRef, {
      messagesReserved: Math.max(0, reserved - 1),
      messagesUsed: outcome === "sent" ? used + 1 : used,
      updatedAt: now
    }, { merge: true });
    transaction.set(reservation.reservationRef, {
      state: outcome === "sent" ? "committed" : "released",
      finishedAt: now,
      updatedAt: now
    }, { merge: true });
    return true;
  });
}

async function recordInboundMessageUsage(db, organizationId, providerMessageId, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(organizationId || "")) || !providerMessageId) return false;
  const organizationRef = db.collection("organizations").doc(organizationId);
  const subscriptionRef = organizationRef.collection("billing").doc("subscription");
  const markerRef = organizationRef.collection("billingInboundUsageEvents").doc(getReservationId(providerMessageId));
  return db.runTransaction(async transaction => {
    const [subscriptionSnapshot, markerSnapshot] = await Promise.all([
      transaction.get(subscriptionRef),
      transaction.get(markerRef)
    ]);
    if (!subscriptionSnapshot.exists || markerSnapshot.exists) return false;
    const subscription = subscriptionSnapshot.data() || {};
    if (!["active", "trialing"].includes(String(subscription.status || ""))) return false;
    const window = getUsageWindow(subscription, now);
    const usageRef = organizationRef.collection("billingUsage").doc(window.key);
    const usageSnapshot = await transaction.get(usageRef);
    const usage = usageSnapshot.exists ? usageSnapshot.data() || {} : {};
    transaction.set(usageRef, {
      plan: window.plan.key,
      periodKey: window.key,
      periodStart: window.start,
      periodEnd: window.end,
      messageLimit: window.limit,
      messagesUsed: Math.max(0, Number(usage.messagesUsed || 0)) + 1,
      messagesReserved: Math.max(0, Number(usage.messagesReserved || 0)),
      trial: window.trial,
      updatedAt: now
    }, { merge: true });
    transaction.create(markerRef, { providerMessageId: String(providerMessageId).slice(0, 256), periodKey: window.key, createdAt: now });
    return true;
  });
}

module.exports = {
  usageError,
  addUtcMonths,
  getUsageWindow,
  getTenantMessageUsage,
  reserveMediaTransfer,
  finishMediaTransfer,
  reserveOutboundMessage,
  finishOutboundReservation,
  recordInboundMessageUsage
};
