"use strict";

const crypto = require("node:crypto");
const dynamodb = require("./dynamodb");

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireUid(decoded) {
  if (!decoded || typeof decoded.uid !== "string" || !decoded.uid) {
    throw httpError("Authentication required.", 401);
  }
  return dynamodb.userWorkspacePartition(decoded.uid), decoded.uid;
}

function normalizeWorkspaceName(value) {
  if (typeof value !== "string") throw httpError("Business name is required.", 400);
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80 ||
      /[<>]/.test(name) ||
      [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw httpError("Business name must be 2–80 characters and contain supported characters.", 400);
  }
  return name;
}

/**
 * Creates a workspace, its first owner membership, and the reverse user
 * membership pointer atomically in the existing Workspaces table.
 * decoded must be the payload from Firebase Admin verifyIdToken().
 */
async function createWorkspace(decoded, input, options = {}) {
  const uid = requireUid(decoded);
  const name = normalizeWorkspaceName(input?.name);
  const organizationId = options.organizationId || crypto.randomUUID();
  const now = new Date().toISOString();
  const workspace = {
    ...dynamodb.workspaceKey(organizationId),
    entityType: "WORKSPACE",
    organizationId,
    name,
    status: "active",
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
    plan: "free"
  };
  const membership = {
    ...dynamodb.membershipKey(organizationId, uid),
    entityType: "MEMBERSHIP",
    organizationId,
    uid,
    role: "owner",
    status: "active",
    joinedAt: now,
    createdAt: now
  };
  const pointer = {
    ...dynamodb.userWorkspacePointerKey(uid, organizationId),
    entityType: "USER_WORKSPACE",
    organizationId,
    uid,
    name,
    role: "owner",
    status: "active",
    createdAt: now
  };

  await dynamodb.transactWrite([
    {
      Put: {
        TableName: dynamodb.getTableName("workspaces"),
        Item: workspace,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
      }
    },
    {
      Put: {
        TableName: dynamodb.getTableName("workspaces"),
        Item: membership,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
      }
    },
    {
      Put: {
        TableName: dynamodb.getTableName("workspaces"),
        Item: pointer,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
      }
    }
  ]);

  return { id: organizationId, name, role: "owner", status: "active" };
}

/**
 * Lists only workspaces referenced by the authenticated Firebase UID's
 * reverse membership partition. Workspace records are re-read from their
 * canonical keys; inactive/missing records are omitted.
 */
async function listWorkspaces(decoded, options = {}) {
  const uid = requireUid(decoded);
  const page = await dynamodb.listUserWorkspacePointers(uid, {
    limit: options.limit,
    exclusiveStartKey: options.exclusiveStartKey
  });
  const workspaces = await Promise.all(page.items.map(async pointer => {
    if (pointer.status !== "active" || pointer.uid !== uid ||
        typeof pointer.organizationId !== "string") return null;
    const record = await dynamodb.getItem(
      "workspaces",
      dynamodb.workspaceKey(pointer.organizationId)
    );
    if (!record || record.status !== "active") return null;
    return {
      id: record.organizationId,
      name: record.name,
      role: pointer.role,
      status: record.status,
      createdAt: record.createdAt
    };
  }));
  return {
    organizations: workspaces.filter(Boolean),
    nextCursor: page.lastEvaluatedKey
  };
}

module.exports = {
  normalizeWorkspaceName,
  createWorkspace,
  listWorkspaces
};
