"use strict";

const crypto = require("crypto");
const { PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
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
  const inviteUrl = createInvitationUrl(options.frontendBaseUrl || process.env.FRONTEND_BASE_URL, organization.id, token);
  const key = invitationKey(organization.id, email);
  const item = {
    ...key, entityType: "INVITATION", organizationId: organization.id,
    email, role, status: "pending", tokenHash, invitedBy: String(actor.uid),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
    updatedAt: now.toISOString()
  };
  await dynamodb.getDocumentClient().send(new PutCommand({
    TableName: dynamodb.getTableName("workspaces"),
    Item: item,
    ConditionExpression: "attribute_not_exists(PK) OR (#status <> :pending OR expiresAt <= :now)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":pending": "pending", ":now": now.toISOString() }
  }));
  return { email, role, status: "pending", expiresAt: item.expiresAt, token, inviteUrl };
}

async function listWorkspaceInvitations(organizationId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const page = await dynamodb.queryPartition("workspaces", organizationId, "ORG#" + organizationId, {
    limit: safeLimit, sortKeyBeginsWith: "INVITATION#", scanIndexForward: false
  });
  const now = Date.now();
  return page.items.map(item => ({
    id: item.SK.slice("INVITATION#".length),
    email: String(item.email || ""), role: String(item.role || "agent"),
    status: item.status === "pending" && new Date(item.expiresAt).getTime() <= now ? "expired" : String(item.status || "unknown"),
    invitedBy: String(item.invitedBy || ""), createdAt: item.createdAt, expiresAt: item.expiresAt
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
  await dynamodb.getDocumentClient().send(new UpdateCommand({
    TableName: dynamodb.getTableName("workspaces"), Key: key,
    UpdateExpression: "SET #status = :revoked, revokedBy = :actor, revokedAt = :now, updatedAt = :now",
    ConditionExpression: "#status = :pending AND tokenHash = :tokenHash",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":revoked": "revoked", ":pending": "pending", ":actor": actor.uid, ":now": now, ":tokenHash": existing.tokenHash }
  }));
  return { email: normalizedEmail, status: "revoked" };
}

async function acceptWorkspaceInvitation(organizationId, token, decoded, options = {}) {
  if (!decoded?.uid || decoded.email_verified !== true) {
    throw invitationError("Sign in with a verified email address before accepting an invitation.", 403);
  }
  const email = normalizeInvitationEmail(decoded.email);
  const secretToken = String(token || "");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(secretToken)) throw invitationError("A valid invitation token is required.");
  const tokenHash = crypto.createHash("sha256").update(secretToken).digest("hex");
  const now = options.now ? options.now() : new Date();
  const workspaceKey = dynamodb.workspaceKey(organizationId);
  const memberKey = dynamodb.membershipKey(organizationId, decoded.uid);
  const pointerKey = dynamodb.userWorkspacePointerKey(decoded.uid, organizationId);
  const inviteKey = invitationKey(organizationId, email);
  const [workspace, invitation, currentMember] = await Promise.all([
    dynamodb.getItem("workspaces", workspaceKey, { consistentRead: true }),
    dynamodb.getItem("workspaces", inviteKey, { consistentRead: true }),
    dynamodb.getItem("workspaces", memberKey, { consistentRead: true })
  ]);
  if (!workspace || workspace.status !== "active") throw invitationError("The invited workspace is not active.", 404);
  if (!invitation || invitation.status !== "pending" || invitation.tokenHash !== tokenHash) {
    throw invitationError("Invitation is invalid, expired, revoked or already used.", 409);
  }
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) throw invitationError("This invitation has expired.", 410);
  if (normalizeInvitationEmail(invitation.email) !== email) throw invitationError("This invitation belongs to a different email address.", 403);
  if (currentMember?.status === "active") throw invitationError("You are already an active member of this workspace.", 409);
  const subscriptionStatus = String(workspace.subscriptionStatus || "");
  const seatLimit = Number(workspace.seatLimit);
  const activeSeatCount = Number(workspace.activeSeatCount);
  if (!["active", "trialing"].includes(subscriptionStatus) ||
      !Number.isInteger(seatLimit) || seatLimit < 1 ||
      !Number.isInteger(activeSeatCount) || activeSeatCount < 1) {
    throw invitationError("Workspace billing and seat limits must be migrated before invitations can be accepted.", 503);
  }
  const role = ["admin", "agent"].includes(invitation.role) ? invitation.role : "agent";
  const joinedAt = now.toISOString();
  const member = {
    ...memberKey, entityType: "MEMBERSHIP", organizationId, uid: decoded.uid,
    email, role, status: "active", invitedBy: String(invitation.invitedBy || ""),
    joinedAt, updatedAt: joinedAt
  };
  const pointer = {
    ...pointerKey, entityType: "USER_WORKSPACE", organizationId, uid: decoded.uid,
    name: String(workspace.name || ""), role, status: "active", updatedAt: joinedAt
  };
  await dynamodb.transactWrite([
    { Update: {
      TableName: dynamodb.getTableName("workspaces"), Key: workspaceKey,
      UpdateExpression: "SET activeSeatCount = activeSeatCount + :one, updatedAt = :now",
      ConditionExpression: "#status = :active AND subscriptionStatus IN (:subActive, :trialing) AND activeSeatCount < seatLimit",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":one": 1, ":now": joinedAt, ":active": "active", ":subActive": "active", ":trialing": "trialing" }
    } },
    { Put: {
      TableName: dynamodb.getTableName("workspaces"), Item: member,
      ConditionExpression: "attribute_not_exists(PK) OR #status <> :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "active" }
    } },
    { Put: { TableName: dynamodb.getTableName("workspaces"), Item: pointer } },
    { Update: {
      TableName: dynamodb.getTableName("workspaces"), Key: inviteKey,
      UpdateExpression: "SET #status = :accepted, acceptedBy = :uid, acceptedAt = :now, updatedAt = :now REMOVE tokenHash",
      ConditionExpression: "#status = :pending AND tokenHash = :tokenHash AND expiresAt > :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":accepted": "accepted", ":pending": "pending", ":uid": decoded.uid, ":now": joinedAt, ":tokenHash": tokenHash }
    } }
  ]);
  return { organizationId, role, status: "active" };
}

module.exports = {
  invitationKey,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
  acceptWorkspaceInvitation
};
