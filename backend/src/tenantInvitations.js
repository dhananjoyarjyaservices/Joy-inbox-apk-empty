"use strict";

const crypto = require("crypto");

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITABLE_ROLES = new Set(["admin", "agent"]);

function invitationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeInvitationEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invitationError("A valid invitation email address is required.");
  }
  return email;
}

function invitationDocumentId(email) {
  return crypto.createHash("sha256").update(normalizeInvitationEmail(email)).digest("hex");
}

function invitationExpiry(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  return new Date(value);
}

function createInvitationUrl(baseUrl, organizationId, token) {
  if (!baseUrl) return null;
  let url;
  try { url = new URL(baseUrl); } catch { throw invitationError("FRONTEND_BASE_URL must be a valid HTTPS URL.", 503); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw invitationError("FRONTEND_BASE_URL must use HTTPS.", 503);
  }
  const inviteUrl = new URL("/setup", url);
  inviteUrl.searchParams.set("organizationId", organizationId);
  inviteUrl.searchParams.set("invite", token);
  return inviteUrl.toString();
}

async function createTenantInvitation(db, organizationId, actor, input, options = {}) {
  const email = normalizeInvitationEmail(input?.email);
  const role = String(input?.role || "agent").toLowerCase();
  if (!INVITABLE_ROLES.has(role)) throw invitationError("Only admin or agent roles can be invited.", 400);
  if (!actor?.uid) throw invitationError("Authentication required.", 401);
  const organizationRef = db.collection("organizations").doc(organizationId);
  const invitationRef = organizationRef.collection("invitations").doc(invitationDocumentId(email));
  const now = options.now ? options.now() : new Date();
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(invitationRef);
    if (snapshot.exists) {
      const existing = snapshot.data() || {};
      if (existing.status === "pending" && invitationExpiry(existing.expiresAt).getTime() > now.getTime()) {
        throw invitationError("A pending invitation already exists for this email.", 409);
      }
    }
    transaction.set(invitationRef, {
      email,
      role,
      status: "pending",
      tokenHash,
      invitedBy: String(actor.uid),
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      updatedAt: now
    });
  });
  return {
    email,
    role,
    status: "pending",
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
    token,
    inviteUrl: createInvitationUrl(options.frontendBaseUrl || process.env.FRONTEND_BASE_URL, organizationId, token)
  };
}

async function listTenantInvitations(db, organizationId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const snapshot = await db.collection("organizations").doc(organizationId)
    .collection("invitations").orderBy("createdAt", "desc").limit(safeLimit).get();
  return snapshot.docs.map(document => {
    const value = document.data() || {};
    return {
      id: document.id,
      email: String(value.email || ""),
      role: String(value.role || "agent"),
      status: String(value.status || "unknown"),
      invitedBy: String(value.invitedBy || ""),
      createdAt: invitationExpiry(value.createdAt).toISOString(),
      expiresAt: invitationExpiry(value.expiresAt).toISOString()
    };
  });
}

async function revokeTenantInvitation(db, organizationId, email, actorUid) {
  const normalizedEmail = normalizeInvitationEmail(email);
  const ref = db.collection("organizations").doc(organizationId)
    .collection("invitations").doc(invitationDocumentId(normalizedEmail));
  const now = new Date();
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.get("status") !== "pending") {
      throw invitationError("A pending invitation for this email was not found.", 404);
    }
    transaction.update(ref, { status: "revoked", revokedBy: String(actorUid || ""), revokedAt: now, updatedAt: now });
  });
  return { email: normalizedEmail, status: "revoked" };
}

async function acceptTenantInvitation(db, organizationId, token, decoded, options = {}) {
  if (!decoded?.uid || decoded.email_verified !== true) {
    throw invitationError("Sign in with a verified email address before accepting an invitation.", 403);
  }
  const email = normalizeInvitationEmail(decoded.email);
  const secretToken = String(token || "");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(secretToken)) throw invitationError("A valid invitation token is required.");
  const tokenHash = crypto.createHash("sha256").update(secretToken).digest("hex");
  const now = options.now ? options.now() : new Date();
  const organizationRef = db.collection("organizations").doc(organizationId);
  const invitationRef = organizationRef.collection("invitations").doc(invitationDocumentId(email));
  const memberRef = organizationRef.collection("members").doc(decoded.uid);
  const userOrganizationRef = db.collection("users").doc(decoded.uid)
    .collection("organizations").doc(organizationId);

  return db.runTransaction(async transaction => {
    const [organizationSnapshot, invitationSnapshot, memberSnapshot] = await Promise.all([
      transaction.get(organizationRef),
      transaction.get(invitationRef),
      transaction.get(memberRef)
    ]);
    if (!organizationSnapshot.exists || organizationSnapshot.get("status") !== "active") {
      throw invitationError("The invited workspace is not active.", 404);
    }
    if (!invitationSnapshot.exists) throw invitationError("Invitation was not found.", 404);
    const invitation = invitationSnapshot.data() || {};
    if (invitation.status !== "pending" || invitation.tokenHash !== tokenHash) {
      throw invitationError("Invitation is invalid, expired, revoked or already used.", 409);
    }
    if (invitationExpiry(invitation.expiresAt).getTime() <= now.getTime()) {
      throw invitationError("This invitation has expired.", 410);
    }
    if (normalizeInvitationEmail(invitation.email) !== email) {
      throw invitationError("This invitation belongs to a different email address.", 403);
    }
    if (memberSnapshot.exists && memberSnapshot.get("status") === "active") {
      throw invitationError("You are already an active member of this workspace.", 409);
    }
    const role = INVITABLE_ROLES.has(invitation.role) ? invitation.role : "agent";
    const member = {
      uid: decoded.uid,
      email,
      role,
      status: "active",
      invitedBy: String(invitation.invitedBy || ""),
      joinedAt: now,
      updatedAt: now
    };
    transaction.set(memberRef, member, { merge: true });
    transaction.set(userOrganizationRef, {
      organizationId,
      name: String(organizationSnapshot.get("name") || ""),
      role,
      status: "active",
      updatedAt: now
    }, { merge: true });
    transaction.update(invitationRef, {
      status: "accepted",
      acceptedBy: decoded.uid,
      acceptedAt: now,
      updatedAt: now,
      tokenHash: null
    });
    return { organizationId, role, status: "active" };
  });
}

module.exports = {
  INVITATION_TTL_MS,
  normalizeInvitationEmail,
  invitationDocumentId,
  createInvitationUrl,
  createTenantInvitation,
  listTenantInvitations,
  revokeTenantInvitation,
  acceptTenantInvitation
};
