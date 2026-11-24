"use strict";

const crypto = require("crypto");

const API_KEY_PATTERN = /^joy_live_[A-Za-z0-9_-]{40,64}$/;
const API_KEY_ID_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_SCOPES = new Set(["contacts:read", "contacts:write", "leads:read", "leads:write", "messages:write", "templates:read", "campaigns:read", "campaigns:write"]);
const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;
const MAX_REQUESTS_PER_MINUTE = 60;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeApiKeyInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError("API key details are required.", 400);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 80) throw httpError("API key name must be between 2 and 80 characters.", 400);
  if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.length > ALLOWED_SCOPES.size ||
      input.scopes.some(scope => !ALLOWED_SCOPES.has(scope))) {
    throw httpError("Choose at least one supported API permission.", 400);
  }
  const scopes = [...new Set(input.scopes)];
  const expiryDays = input.expiryDays === undefined ? DEFAULT_EXPIRY_DAYS : Number(input.expiryDays);
  if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > MAX_EXPIRY_DAYS) {
    throw httpError("API keys must expire within 1–365 days.", 400);
  }
  return { name, scopes, expiryDays };
}

async function createOrganizationApiKey(db, organizationId, actorUid, input, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId || "") || typeof actorUid !== "string" || !actorUid) {
    throw httpError("A valid workspace and signed-in user are required.", 400);
  }
  const definition = normalizeApiKeyInput(input);
  const token = "joy_live_" + crypto.randomBytes(32).toString("base64url");
  const keyHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now + definition.expiryDays * 24 * 60 * 60 * 1000);
  await db.collection("publicApiKeys").doc(keyHash).create({
    organizationId,
    name: definition.name,
    keyPrefix: token.slice(0, 16),
    scopes: definition.scopes,
    status: "active",
    createdBy: actorUid,
    createdAt: new Date(now),
    expiresAt
  });
  return {
    id: keyHash,
    name: definition.name,
    keyPrefix: token.slice(0, 16),
    scopes: definition.scopes,
    status: "active",
    createdAt: new Date(now).toISOString(),
    expiresAt: expiresAt.toISOString(),
    apiKey: token
  };
}

async function listOrganizationApiKeys(db, organizationId) {
  const snapshot = await db.collection("publicApiKeys")
    .where("organizationId", "==", organizationId)
    .limit(100)
    .get();
  return snapshot.docs.map(document => {
    const data = document.data();
    return {
      id: document.id,
      name: data.name,
      keyPrefix: data.keyPrefix,
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
      status: data.status,
      createdAt: toIso(data.createdAt),
      expiresAt: toIso(data.expiresAt),
      lastUsedAt: toIso(data.lastUsedAt),
      revokedAt: toIso(data.revokedAt)
    };
  }).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

async function revokeOrganizationApiKey(db, organizationId, keyId, now = Date.now()) {
  if (!API_KEY_ID_PATTERN.test(keyId || "")) throw httpError("A valid API key ID is required.", 400);
  const ref = db.collection("publicApiKeys").doc(keyId);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.organizationId !== organizationId) {
      throw httpError("API key was not found in this workspace.", 404);
    }
    if (snapshot.data()?.status === "revoked") return;
    transaction.set(ref, { status: "revoked", revokedAt: new Date(now), updatedAt: new Date(now) }, { merge: true });
  });
  return { id: keyId, status: "revoked" };
}

async function consumeApiRateLimit(db, keyHash, organizationId, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  const dateKey = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const rateRef = db.collection("publicApiRateLimits").doc(`${keyHash}_${minute}`);
  const usageRef = db.collection("publicApiUsageDaily").doc(`${keyHash}_${dateKey}`);
  const limited = await db.runTransaction(async transaction => {
    const [rateSnapshot, usageSnapshot] = await Promise.all([
      transaction.get(rateRef),
      transaction.get(usageRef)
    ]);
    const count = rateSnapshot.exists ? Number(rateSnapshot.data()?.count || 0) : 0;
    const usage = usageSnapshot.exists ? usageSnapshot.data() || {} : {};
    const isLimited = count >= MAX_REQUESTS_PER_MINUTE;
    if (!isLimited) {
      transaction.set(rateRef, {
        keyHash,
        organizationId,
        minute,
        count: count + 1,
        expiresAt: new Date((minute + 61) * 60000),
        updatedAt: new Date(now)
      }, { merge: true });
    }
    transaction.set(usageRef, {
      keyHash,
      organizationId,
      dateKey,
      requestCount: Number(usage.requestCount || 0) + 1,
      rateLimitedCount: Number(usage.rateLimitedCount || 0) + (isLimited ? 1 : 0),
      expiresAt: new Date(now + 400 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(now)
    }, { merge: true });
    return isLimited;
  });
  if (limited) throw httpError("API rate limit exceeded. Try again in the next minute.", 429);
}

async function listOrganizationApiUsage(db, organizationId, options = {}) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId || "")) throw httpError("A valid workspace is required.", 400);
  const rawDays = options.days === undefined ? 30 : Number(options.days);
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 90) throw httpError("Usage history must be between 1 and 90 days.", 400);
  const fromDate = new Date(options.now === undefined ? Date.now() : options.now);
  fromDate.setUTCHours(0, 0, 0, 0);
  fromDate.setUTCDate(fromDate.getUTCDate() - (rawDays - 1));
  const fromKey = fromDate.toISOString().slice(0, 10).replace(/-/g, "");
  const toKey = new Date(options.now === undefined ? Date.now() : options.now).toISOString().slice(0, 10).replace(/-/g, "");
  const snapshot = await db.collection("publicApiUsageDaily")
    .where("organizationId", "==", organizationId)
    .limit(10000)
    .get();
  const daily = snapshot.docs.map(document => {
    const data = document.data() || {};
    return {
      keyId: data.keyHash,
      date: data.dateKey,
      requests: Number(data.requestCount || 0),
      rateLimited: Number(data.rateLimitedCount || 0)
    };
  }).filter(item => item.date >= fromKey && item.date <= toKey)
    .sort((a, b) => b.date.localeCompare(a.date) || a.keyId.localeCompare(b.keyId));
  const totals = daily.reduce((result, item) => {
    result.requests += item.requests;
    result.rateLimited += item.rateLimited;
    return result;
  }, { requests: 0, rateLimited: 0 });
  return { periodDays: rawDays, totals, daily };
}

async function authenticateOrganizationApiKey(db, authorization, now = Date.now()) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw httpError("A valid Joy Inbox API key is required.", 401);
  }
  const token = authorization.slice(7).trim();
  if (!API_KEY_PATTERN.test(token)) throw httpError("A valid Joy Inbox API key is required.", 401);
  const keyHash = crypto.createHash("sha256").update(token).digest("hex");
  const keyRef = db.collection("publicApiKeys").doc(keyHash);
  const snapshot = await keyRef.get();
  if (!snapshot.exists) throw httpError("API key is invalid or revoked.", 401);
  const data = snapshot.data() || {};
  if (data.status !== "active") throw httpError("API key is invalid or revoked.", 401);
  const expiresAt = typeof data.expiresAt?.toDate === "function"
    ? data.expiresAt.toDate().getTime()
    : data.expiresAt instanceof Date ? data.expiresAt.getTime() : new Date(data.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw httpError("API key has expired. Create a new key.", 401);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(data.organizationId || "")) throw httpError("API key workspace is invalid.", 403);
  const organization = await db.collection("organizations").doc(data.organizationId).get();
  if (!organization.exists || organization.data()?.status !== "active") throw httpError("API key workspace is inactive.", 403);
  await consumeApiRateLimit(db, keyHash, data.organizationId, now);
  const lastUsedAt = typeof data.lastUsedAt?.toDate === "function"
    ? data.lastUsedAt.toDate().getTime()
    : data.lastUsedAt instanceof Date ? data.lastUsedAt.getTime() : 0;
  if (!lastUsedAt || now - lastUsedAt >= 5 * 60 * 1000) {
    await keyRef.set({ lastUsedAt: new Date(now) }, { merge: true });
  }
  return {
    keyId: keyHash,
    organizationId: data.organizationId,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    createdBy: data.createdBy
  };
}

async function runIdempotentApiRequest(db, authenticatedKey, idempotencyKey, request, operation, now = Date.now()) {
  if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === "") {
    return { ...(await operation()), replayed: false };
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length > 128 ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw httpError("Idempotency-Key must be 8–128 letters, numbers, dots, underscores, colons or hyphens.", 400);
  }
  if (!authenticatedKey?.keyId || !/^[a-f0-9]{64}$/.test(authenticatedKey.keyId)) {
    throw httpError("A valid authenticated API key is required.", 401);
  }
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(request ?? null)).digest("hex");
  const id = crypto.createHash("sha256").update(authenticatedKey.keyId + ":" + idempotencyKey).digest("hex");
  const ref = db.collection("publicApiIdempotency").doc(id);
  const expiresAt = new Date(now + 24 * 60 * 60 * 1000);
  const reservation = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) {
      const existing = snapshot.data() || {};
      const existingExpiry = existing.expiresAt?.toDate ? existing.expiresAt.toDate().getTime() : new Date(existing.expiresAt).getTime();
      if (Number.isFinite(existingExpiry) && existingExpiry > now) {
        if (existing.keyId !== authenticatedKey.keyId || existing.requestHash !== requestHash) {
          throw httpError("This Idempotency-Key was already used for a different request.", 409);
        }
        if (existing.status === "completed") return { replayed: true, result: existing.result, statusCode: existing.statusCode };
        throw httpError("A request with this Idempotency-Key is still processing. Retry shortly.", 409);
      }
    }
    transaction.set(ref, {
      keyId: authenticatedKey.keyId,
      organizationId: authenticatedKey.organizationId,
      requestHash,
      status: "processing",
      createdAt: new Date(now),
      expiresAt
    });
    return { replayed: false };
  });
  if (reservation.replayed) return { ...reservation.result, statusCode: reservation.statusCode, replayed: true };
  try {
    const result = await operation();
    const statusCode = Number.isInteger(result?.statusCode) ? result.statusCode : 200;
    const response = result && Object.prototype.hasOwnProperty.call(result, "data")
      ? { data: result.data }
      : result;
    await ref.set({ status: "completed", result: response, statusCode, completedAt: new Date(now) }, { merge: true });
    return { ...response, statusCode, replayed: false };
  } catch (error) {
    await ref.delete().catch(() => {});
    throw error;
  }
}

function requireApiScope(authenticatedKey, scope) {
  if (!authenticatedKey?.scopes?.includes(scope)) throw httpError("This API key does not have the required permission.", 403);
}

module.exports = {
  ALLOWED_SCOPES,
  MAX_REQUESTS_PER_MINUTE,
  listOrganizationApiUsage,
  runIdempotentApiRequest,
  normalizeApiKeyInput,
  createOrganizationApiKey,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  authenticateOrganizationApiKey,
  requireApiScope
};
