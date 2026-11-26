"use strict";

const crypto = require("crypto");
const dynamodb = require("./dynamodb");

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validUid(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

async function getWorkspaceContext(decoded, organizationId) {
  if (!decoded?.uid) throw httpError("Authentication required.", 401);
  const key = dynamodb.workspaceKey(organizationId);
  const [workspace, membership] = await Promise.all([
    dynamodb.getItem("workspaces", key),
    dynamodb.getItem("workspaces", dynamodb.membershipKey(organizationId, decoded.uid))
  ]);
  if (!workspace || workspace.status !== "active" ||
      !membership || membership.status !== "active" ||
      !["owner", "admin", "agent"].includes(membership.role)) {
    throw httpError("You are not an active member of this organization.", 403);
  }
  return {
    ...workspace,
    id: organizationId,
    uid: decoded.uid,
    role: membership.role
  };
}

function auditRecord(organizationId, actor, action, target, details = {}) {
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    PK: "ORG#" + organizationId,
    SK: "AUDIT#" + createdAt + "#" + id,
    id, action,
    actorUid: String(actor?.uid || ""),
    actorEmail: String(actor?.email || ""),
    actorRole: String(actor?.role || ""),
    targetUid: String(target?.uid || ""),
    targetEmail: String(target?.email || ""),
    details, createdAt
  };
}

async function listWorkspaceMemberAudit(organizationId, options = {}) {
  const limit = options.limit === undefined ? 25 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw httpError("Activity page size must be between 1 and 100.", 400);
  let exclusiveStartKey;
  if (options.cursor) {
    try { exclusiveStartKey = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); }
    catch { throw httpError("A valid activity page cursor is required.", 400); }
    if (!exclusiveStartKey || exclusiveStartKey.PK !== "ORG#" + organizationId || typeof exclusiveStartKey.SK !== "string" || !exclusiveStartKey.SK.startsWith("AUDIT#")) throw httpError("A valid activity page cursor is required.", 400);
  }
  const page = await dynamodb.queryPartition("workspaces", organizationId, "ORG#" + organizationId, { limit, sortKeyBeginsWith: "AUDIT#", scanIndexForward: false, exclusiveStartKey });
  return { events: page.items.map(item => ({ id: item.id, action: item.action, actorUid: item.actorUid || "", actorEmail: item.actorEmail || "", actorRole: item.actorRole || "", targetUid: item.targetUid || "", targetEmail: item.targetEmail || "", details: item.details || {}, createdAt: item.createdAt })), nextCursor: page.lastEvaluatedKey ? Buffer.from(JSON.stringify(page.lastEvaluatedKey)).toString("base64url") : null };
}

function requireManager(actor) {
  if (!actor || !["owner", "admin"].includes(actor.role)) {
    throw httpError("Only organization owners and admins can manage members.", 403);
  }
}

async function listWorkspaceMembers(organizationId, options = {}) {
  const limit = options.limit === undefined ? 25 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw httpError("Member page size must be between 1 and 100.", 400);
  }
  let exclusiveStartKey;
  if (options.cursor) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
    } catch {
      throw httpError("A valid member page cursor is required.", 400);
    }
    if (!exclusiveStartKey || exclusiveStartKey.PK !== "ORG#" + organizationId ||
        typeof exclusiveStartKey.SK !== "string" || !exclusiveStartKey.SK.startsWith("MEMBER#")) {
      throw httpError("A valid member page cursor is required.", 400);
    }
  }
  const page = await dynamodb.queryPartition("workspaces", organizationId, "ORG#" + organizationId, {
    limit,
    sortKeyBeginsWith: "MEMBER#",
    exclusiveStartKey
  });
  return {
    members: page.items.map(item => ({
      uid: item.uid,
      email: String(item.email || ""),
      displayName: String(item.displayName || ""),
      role: item.role,
      status: item.status,
      joinedAt: item.joinedAt || null
    })),
    nextCursor: page.lastEvaluatedKey
      ? Buffer.from(JSON.stringify(page.lastEvaluatedKey)).toString("base64url")
      : null
  };
}

async function updateWorkspaceMemberRole(organization, actor, input) {
  requireManager(actor);
  const uid = input?.uid;
  const role = input?.role;
  if (!validUid(uid) || !["admin", "agent"].includes(role)) {
    throw httpError("A valid member ID and admin/agent role are required.", 400);
  }
  if (uid === organization.createdBy || (role === "admin" && actor.role !== "owner")) {
    throw httpError("Only the organization owner can assign admin, and owner role cannot be changed.", 403);
  }
  const key = dynamodb.membershipKey(organization.id, uid);
  const pointerKey = dynamodb.userWorkspacePointerKey(uid, organization.id);
  const existing = await dynamodb.getItem("workspaces", key);
  if (!existing || existing.status !== "active") throw httpError("Active member was not found.", 404);
  if (existing.role === "owner") throw httpError("The owner role cannot be changed.", 403);
  if (existing.role === "admin" && actor.role !== "owner") {
    throw httpError("Only the organization owner can change another admin's role.", 403);
  }
  const now = new Date().toISOString();
  const audit = auditRecord(organization.id, actor, "member.role_changed", { uid, email: existing.email }, { role });
  await dynamodb.transactWrite([
    { Update: {
      TableName: dynamodb.getTableName("workspaces"),
      Key: key,
      UpdateExpression: "SET #role = :role, updatedAt = :now",
      ConditionExpression: "#status = :active AND #role <> :owner",
      ExpressionAttributeNames: { "#role": "role", "#status": "status" },
      ExpressionAttributeValues: { ":role": role, ":now": now, ":active": "active", ":owner": "owner" }
    } },
    { Update: {
      TableName: dynamodb.getTableName("workspaces"),
      Key: pointerKey,
      UpdateExpression: "SET #role = :role, updatedAt = :now",
      ConditionExpression: "#status = :active",
      ExpressionAttributeNames: { "#role": "role", "#status": "status" },
      ExpressionAttributeValues: { ":role": role, ":now": now, ":active": "active" }
    } },
    { Put: { TableName: dynamodb.getTableName("workspaces"), Item: audit, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } }
  ]);
  return { uid, role };
}

async function removeWorkspaceMember(organization, actor, input) {
  requireManager(actor);
  const uid = input?.uid;
  if (!validUid(uid)) throw httpError("A valid member ID is required.", 400);
  if (uid === organization.createdBy || uid === organization.uid) {
    throw httpError("The organization owner cannot be removed.", 403);
  }
  const key = dynamodb.membershipKey(organization.id, uid);
  const pointerKey = dynamodb.userWorkspacePointerKey(uid, organization.id);
  const existing = await dynamodb.getItem("workspaces", key);
  if (!existing || existing.status !== "active") throw httpError("Active member was not found.", 404);
  if (existing.role === "owner") throw httpError("The owner cannot be removed.", 403);
  if (existing.role === "admin" && actor.role !== "owner") {
    throw httpError("Only the organization owner can remove another admin.", 403);
  }
  const now = new Date().toISOString();
  const audit = auditRecord(organization.id, actor, "member.removed", { uid, email: existing.email });
  await dynamodb.transactWrite([
    { Update: {
      TableName: dynamodb.getTableName("workspaces"),
      Key: key,
      UpdateExpression: "SET #status = :removed, removedAt = :now, updatedAt = :now",
      ConditionExpression: "#status = :active AND #role <> :owner",
      ExpressionAttributeNames: { "#status": "status", "#role": "role" },
      ExpressionAttributeValues: { ":removed": "removed", ":now": now, ":active": "active", ":owner": "owner" }
    } },
    { Update: {
      TableName: dynamodb.getTableName("workspaces"),
      Key: pointerKey,
      UpdateExpression: "SET #status = :removed, removedAt = :now, updatedAt = :now",
      ConditionExpression: "#status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":removed": "removed", ":now": now, ":active": "active" }
    } },
    { Update: {
      TableName: dynamodb.getTableName("workspaces"),
      Key: dynamodb.workspaceKey(organization.id),
      UpdateExpression: "SET activeSeatCount = activeSeatCount - :one, updatedAt = :now",
      ConditionExpression: "activeSeatCount > :zero",
      ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":now": now }
    } },
    { Put: { TableName: dynamodb.getTableName("workspaces"), Item: audit, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } }
  ]);
  return { uid, status: "removed" };
}

module.exports = {
  getWorkspaceContext,
  listWorkspaceMembers,
  listWorkspaceMemberAudit,
  updateWorkspaceMemberRole,
  removeWorkspaceMember
};
