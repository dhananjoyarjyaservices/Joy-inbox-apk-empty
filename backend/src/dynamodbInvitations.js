"use strict";

const crypto = require("crypto");
const dynamodb = require("./dynamodb");
const {
  INVITATION_TTL_MS,
  normalizeInvitationEmail,
  invitationDocumentId,
  createInvitationUrl
} = require("./tenantInvitations");

function invitationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function invitationKey(organizationId, email) {
  return {
    PK: dynamodb.workspaceKey(organizationId).PK,
    SK: "INVITATION#" + invitationDocumentId(email)
  };
}

function requireInvitationManager(actor) {
  if (!actor?.uid || !["owner", "admin"].includes(actor.role)) {
    throw invitationError("Only workspace owners and admins can manage invitations.", 403);
  }
}

async function createWorkspaceInvitation(organization, actor, input, options = {}) {
  requireInvitationManager(actor);
  const email = normalizeInvitationEmail(input?.email);
  const role = String(input?.role || "agent").toLowerCase();
  if (!["admin", "agent"].includes(role)) throw invitationError("Only admin or agent roles can be invited.");
  if (role === "admin" && actor.role !== "owner") throw invitationError("Only the workspace owner can invite an admin.", 403);
  const now = options.now ? options.now() : new Date();
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const inviteUrl = createInvitationUrl(
    options.frontendBaseUrl || process.env.FRONTEND_BASE_URL,
    organization.id,
    token
  );
  const key = invitationKey(organization.id, email);
  const existing = await dynamodb.getItem("workspaces", key, { consistentRead: true });
  if (existing && existing.status === "pending" && new Date(existing.expiresAt).getTime() > now.getTime()) {
    throw invitationError("A pending invitation already exists for this email.", 409);
  }
  const item = {
    ...key,
    entityType: "INVITATION",
    organizationId: organization.id,
    email,
    role,
    status: "pending",
    tokenHash,
    invitedBy: String(actor.uid),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
    updatedAt: now.toISOString()
  };
  await dynamodb.putItem("workspaces", item, { ifAbsent: !existing });
  return {
    email, role, status: "pending",
    expiresAt: item.expiresAt,
    token,
    inviteUrl
  };
}

async function listWorkspaceInvitations(organizationId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const page = await dynamodb.queryPartition("workspaces", organizationId, "ORG#" + organizationId, {
    limit: safeLimit,
    sortKeyBeginsWith: "INVITATION#",
    scanIndexForward: false
  });
  const now = Date.now();
  return page.items.map(item => ({
    id: item.SK.slice("INVITATION#".length),
    email: String(item.email || ""),
    role: String(item.role || "agent"),
    status: item.status === "pending" && new Date(item.expiresAt).getTime() <= now ? "expired" : String(item.status || "unknown"),
    invitedBy: String(item.invitedBy || ""),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt
  }));
}

async function revokeWorkspaceInvitation(organizationId, actor, email) {
  requireInvitationManager(actor);
  const normalizedEmail = normalizeInvitationEmail(email);
  const key = invitationKey(organizationId, normalizedEmail);
  const existing = await dynamodb.getItem("workspaces", key, { consistentRead: true });
  if (!existing || existing.status !== "pending" || new Date(existing.expiresAt).getTime() <= Date.now()) {
    throw invitationError("A pending invitation for this email was not found.", 404);
  }
  const now = new Date().toISOString();
  await dynamodb.getDocumentClient().send(new (require("@aws-sdk/lib-dynamodb").UpdateCommand)({
    TableName: dynamodb.getTableName("workspaces"),
    Key: key,
    UpdateExpression: "SET #status = :revoked, revokedBy = :actor, revokedAt = :now, updatedAt = :now",
    ConditionExpression: "#status = :pending AND tokenHash = :tokenHash",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":revoked": "revoked", ":pending": "pending", ":actor": actor.uid, ":now": now, ":tokenHash": existing.tokenHash }
  }));
  return { email: normalizedEmail, status: "revoked" };
}

module.exports = {
  invitationKey,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation
};
