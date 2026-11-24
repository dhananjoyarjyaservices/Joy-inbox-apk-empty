"use strict";

const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;
const { encryptSecret, decryptSecret } = require("./tenancy");

const WEBHOOK_EVENTS = new Set([
  "contact.upserted",
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed"
]);
const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 2 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("ff") || normalized.startsWith("::ffff:") &&
        isPrivateAddress(normalized.slice(7));
  }
  return true;
}

function normalizeWebhookUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw httpError("Webhook URL is required and must be 2048 characters or fewer.", 400);
  let url;
  try { url = new URL(value.trim()); } catch { throw httpError("Enter a valid HTTPS webhook URL.", 400); }
  const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || !hostname ||
      hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") ||
      hostname.endsWith(".test") || hostname === "metadata.google.internal") {
    throw httpError("Webhook endpoints must use HTTPS on a public host without embedded credentials.", 400);
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw httpError("Private or local network webhook destinations are not allowed.", 400);
  }
  return url.toString();
}

function normalizeWebhookInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Webhook details are required.", 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 80) throw httpError("Webhook name must be between 2 and 80 characters.", 400);
  const url = normalizeWebhookUrl(input.url);
  if (!Array.isArray(input.events) || !input.events.length || input.events.length > WEBHOOK_EVENTS.size ||
      input.events.some(event => !WEBHOOK_EVENTS.has(event))) {
    throw httpError("Select at least one supported webhook event.", 400);
  }
  return { name, url, events: [...new Set(input.events)] };
}

function toIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function createOrganizationWebhook(db, organizationId, actorUid, input, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId || "") || typeof actorUid !== "string" || !actorUid) {
    throw httpError("A valid workspace and signed-in user are required.", 400);
  }
  const definition = normalizeWebhookInput(input);
  const id = crypto.randomUUID();
  const secret = "joywhsec_" + crypto.randomBytes(32).toString("base64url");
  await db.collection("organizations").doc(organizationId).collection("webhookSubscriptions").doc(id).create({
    ...definition,
    secretEncrypted: encryptSecret(secret),
    status: "active",
    createdBy: actorUid,
    createdAt: new Date(now),
    updatedAt: new Date(now)
  });
  return {
    webhook: { id, ...definition, status: "active", createdAt: new Date(now).toISOString() },
    secret
  };
}

async function listOrganizationWebhooks(db, organizationId) {
  const snapshot = await db.collection("organizations").doc(organizationId)
    .collection("webhookSubscriptions").orderBy("createdAt", "desc").limit(100).get();
  return snapshot.docs.map(document => {
    const data = document.data();
    return {
      id: document.id,
      name: data.name,
      url: data.url,
      events: Array.isArray(data.events) ? data.events : [],
      status: data.status,
      createdAt: toIso(data.createdAt),
      updatedAt: toIso(data.updatedAt),
      lastDeliveryAt: toIso(data.lastDeliveryAt)
    };
  });
}

async function revokeOrganizationWebhook(db, organizationId, webhookId, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(webhookId || "")) throw httpError("A valid webhook ID is required.", 400);
  const ref = db.collection("organizations").doc(organizationId).collection("webhookSubscriptions").doc(webhookId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw httpError("Webhook subscription was not found in this workspace.", 404);
  await ref.set({ status: "revoked", revokedAt: new Date(now), updatedAt: new Date(now) }, { merge: true });
  return { id: webhookId, status: "revoked" };
}

async function enqueueOrganizationWebhookEvent(db, organizationId, event, eventId, payload, now = Date.now()) {
  if (!WEBHOOK_EVENTS.has(event)) return { queued: 0 };
  if (typeof eventId !== "string" || !eventId || eventId.length > 200) throw httpError("A stable webhook event ID is required.", 400);
  const serialized = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) throw httpError("Webhook event payload is too large.", 413);
  const subscriptions = await db.collection("organizations").doc(organizationId)
    .collection("webhookSubscriptions").where("status", "==", "active").get();
  let queued = 0;
  for (const subscription of subscriptions.docs) {
    const data = subscription.data() || {};
    if (!Array.isArray(data.events) || !data.events.includes(event)) continue;
    const id = crypto.createHash("sha256")
      .update([organizationId, subscription.id, event, eventId].join(":"))
      .digest("hex");
    const ref = db.collection("webhookDeliveryQueue").doc(id);
    try {
      await ref.create({
        organizationId,
        subscriptionId: subscription.id,
        event,
        eventId,
        payload: JSON.parse(serialized),
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now)
      });
      queued += 1;
    } catch (error) {
      if (error.code !== 6 && error.code !== "already-exists" && !/already exists/i.test(error.message || "")) throw error;
    }
  }
  return { queued };
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  return new Date(value).getTime() || 0;
}

async function resolvePublicWebhookHost(hostname, lookupImpl = dns.lookup) {
  hostname = String(hostname || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw httpError("Webhook destination resolves to a private network address.", 400);
    return;
  }
  const records = await lookupImpl(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || !records.length || records.some(record => isPrivateAddress(record.address))) {
    throw httpError("Webhook destination must resolve only to public IP addresses.", 400);
  }
}

async function processPendingWebhookDeliveries(db, {
  fetchImpl = fetch,
  lookupImpl = dns.lookup,
  now = Date.now(),
  limit = 50
} = {}) {
  const snapshot = await db.collection("webhookDeliveryQueue")
    .where("status", "in", ["pending", "processing"])
    .limit(Math.min(100, Math.max(1, limit)))
    .get();
  let delivered = 0;
  let retried = 0;
  let failed = 0;
  for (const document of snapshot.docs) {
    const current = document.data() || {};
    const due = current.status === "pending"
      ? millis(current.nextAttemptAt) <= now
      : millis(current.lockUntil) <= now;
    if (!due) continue;
    const ref = db.collection("webhookDeliveryQueue").doc(document.id);
    let attempt = 0;
    const claimed = await db.runTransaction(async transaction => {
      const latest = await transaction.get(ref);
      if (!latest.exists) return false;
      const data = latest.data() || {};
      const ready = data.status === "pending"
        ? millis(data.nextAttemptAt) <= now
        : data.status === "processing" && millis(data.lockUntil) <= now;
      if (!ready) return false;
      attempt = Number(data.attempts || 0) + 1;
      transaction.set(ref, { status: "processing", attempts: attempt, lockUntil: new Date(now + 60_000), updatedAt: new Date(now) }, { merge: true });
      return true;
    });
    if (!claimed) continue;

    try {
      const subscriptionRef = db.collection("organizations").doc(current.organizationId)
        .collection("webhookSubscriptions").doc(current.subscriptionId);
      const subscription = await subscriptionRef.get();
      if (!subscription.exists || subscription.data()?.status !== "active") {
        await ref.set({ status: "cancelled", lockUntil: null, updatedAt: new Date(now) }, { merge: true });
        continue;
      }
      const config = subscription.data();
      const endpoint = normalizeWebhookUrl(config.url);
      const hostname = new URL(endpoint).hostname;
      await resolvePublicWebhookHost(hostname, lookupImpl);
      const secret = decryptSecret(config.secretEncrypted);
      const body = JSON.stringify({
        id: document.id,
        event: current.event,
        createdAt: toIso(current.createdAt),
        data: current.payload
      });
      const signature = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Joy-Event": current.event,
          "X-Joy-Delivery": document.id,
          "X-Joy-Timestamp": String(Math.floor(now / 1000)),
          "X-Joy-Signature": signature,
          "User-Agent": "Joy-Inbox-Webhooks/1.0"
        },
        body,
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`Webhook endpoint returned HTTP ${response.status}.`);
      await ref.set({ status: "delivered", responseStatus: response.status, deliveredAt: new Date(now), lockUntil: null, updatedAt: new Date(now) }, { merge: true });
      await subscriptionRef.set({ lastDeliveryAt: new Date(now) }, { merge: true });
      delivered += 1;
    } catch (error) {
      const terminal = attempt >= MAX_ATTEMPTS;
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      await ref.set({
        status: terminal ? "failed" : "pending",
        nextAttemptAt: new Date(now + delay),
        lockUntil: null,
        lastError: String(error.message || "Webhook delivery failed.").slice(0, 240),
        updatedAt: new Date(now)
      }, { merge: true });
      if (terminal) failed += 1;
      else retried += 1;
    }
  }
  return { delivered, retried, failed };
}

module.exports = {
  WEBHOOK_EVENTS,
  normalizeWebhookUrl,
  normalizeWebhookInput,
  createOrganizationWebhook,
  listOrganizationWebhooks,
  revokeOrganizationWebhook,
  enqueueOrganizationWebhookEvent,
  resolvePublicWebhookHost,
  processPendingWebhookDeliveries
};
