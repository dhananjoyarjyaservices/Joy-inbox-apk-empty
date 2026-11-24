"use strict";

const crypto = require("crypto");

const API_KEY_PATTERN = /^joy_live_[A-Za-z0-9_-]{40,64}$/;
const API_KEY_ID_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_SCOPES = new Set(["contacts:read", "contacts:write"]);
const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;

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

async function authenticateOrganizationApiKey(db, authorization, now = Date.now()) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw httpError("A valid Joy Inbox API key is required.", 401);
  }
  const token = authorization.slice(7).trim();
  if (!API_KEY_PATTERN.test(token)) throw httpError("A valid Joy Inbox API key is required.", 401);
  const keyHash = crypto.createHash("sha256").update(token).digest("hex");
  const snapshot = await db.collection("publicApiKeys").doc(keyHash).get();
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
  return {
    keyId: keyHash,
    organizationId: data.organizationId,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    createdBy: data.createdBy
  };
}

function requireApiScope(authenticatedKey, scope) {
  if (!authenticatedKey?.scopes?.includes(scope)) throw httpError("This API key does not have the required permission.", 403);
}

module.exports = {
  ALLOWED_SCOPES,
  normalizeApiKeyInput,
  createOrganizationApiKey,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  authenticateOrganizationApiKey,
  requireApiScope
};
