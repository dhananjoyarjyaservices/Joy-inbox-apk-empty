"use strict";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw httpError(`A valid ${label} is required.`, 400);
}

function createDynamoOrganizationStore({ documentClient, commands, tableName }) {
  if (!documentClient || typeof documentClient.send !== "function") throw new Error("A DynamoDB DocumentClient is required.");
  if (!commands?.GetCommand || !commands?.PutCommand || !commands?.QueryCommand || !commands?.TransactWriteCommand || !commands?.DeleteCommand) {
    throw new Error("DynamoDB Get, Put, Query and TransactWrite command constructors are required.");
  }
  if (typeof tableName !== "string" || !tableName.trim()) throw new Error("DYNAMODB_TABLE_NAME is not configured.");

  async function createOrganization({ organizationId, uid, name, now = new Date().toISOString() }) {
    assertId(organizationId, "organization ID");
    assertId(uid, "user ID");
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
      throw httpError("Business name must be between 2 and 80 characters.", 400);
    }
    const org = {
      PK: `ORG#${organizationId}`,
      SK: "META",
      entityType: "ORGANIZATION",
      organizationId,
      name: name.trim(),
      status: "active",
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
      plan: "free",
      activeMemberCount: 1
    };
    const membership = {
      PK: `ORG#${organizationId}`,
      SK: `MEMBER#${uid}`,
      entityType: "MEMBERSHIP",
      organizationId,
      uid,
      role: "owner",
      status: "active",
      joinedAt: now,
      createdAt: now
    };
    await documentClient.send(new commands.TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: org, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
        { Put: { TableName: tableName, Item: membership, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
        { Put: { TableName: tableName, Item: {
          PK: `USER#${uid}`, SK: `ORG#${organizationId}`, entityType: "USER_ORGANIZATION",
          organizationId, uid, role: "owner", status: "active", joinedAt: now
        }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } }
      ]
    }));
    return { id: organizationId, name: org.name, role: "owner", status: "active" };
  }

  async function getMembership(organizationId, uid) {
    assertId(organizationId, "organization ID");
    assertId(uid, "user ID");
    const result = await documentClient.send(new commands.GetCommand({
      TableName: tableName,
      Key: { PK: `ORG#${organizationId}`, SK: `MEMBER#${uid}` },
      ConsistentRead: true
    }));
    return result.Item || null;
  }

  async function requireActiveOrganization(organizationId, uid) {
    assertId(organizationId, "organization ID");
    assertId(uid, "user ID");
    const [organization, membership] = await Promise.all([
      documentClient.send(new commands.GetCommand({
        TableName: tableName,
        Key: { PK: `ORG#${organizationId}`, SK: "META" },
        ConsistentRead: true
      })),
      getMembership(organizationId, uid)
    ]);
    if (!organization.Item || organization.Item.status !== "active" ||
        !membership || membership.status !== "active" ||
        !["owner", "admin", "agent"].includes(membership.role)) {
      throw httpError("You are not an active member of this organization.", 403);
    }
    return { ...organization.Item, id: organizationId, uid, role: membership.role };
  }


  async function addMember({ organizationId, uid, role = "agent", seatLimit, now = new Date().toISOString() }) {
    assertId(organizationId, "organization ID");
    assertId(uid, "user ID");
    if (!["admin", "agent"].includes(role)) throw httpError("Only admin or agent roles can be assigned to a new member.", 400);
    if (!Number.isInteger(seatLimit) || seatLimit < 1 || seatLimit > 1000) throw httpError("A verified plan seat limit is required.", 503);
    const member = {
      PK: `ORG#${organizationId}`, SK: `MEMBER#${uid}`,
      entityType: "MEMBERSHIP", organizationId, uid, role,
      status: "active", joinedAt: now, createdAt: now
    };
    const userOrganization = {
      PK: `USER#${uid}`, SK: `ORG#${organizationId}`,
      entityType: "USER_ORGANIZATION", organizationId, uid, role,
      status: "active", joinedAt: now
    };
    await documentClient.send(new commands.TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: member, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
        { Put: { TableName: tableName, Item: userOrganization, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
        { Update: { TableName: tableName, Key: { PK: `ORG#${organizationId}`, SK: "META" },
          UpdateExpression: "ADD activeMemberCount :one",
          ConditionExpression: "#status = :active AND activeMemberCount < :seatLimit",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":one": 1, ":active": "active", ":seatLimit": seatLimit }
        } }
      ]
    }));
    return { uid, role, status: "active" };
  }

  async function updateMemberRole({ organizationId, uid, role, now = new Date().toISOString() }) {
    assertId(organizationId, "organization ID");
    assertId(uid, "user ID");
    if (!["admin", "agent"].includes(role)) throw httpError("Only admin or agent roles can be assigned.", 400);
    const memberKey = { PK: `ORG#${organizationId}`, SK: `MEMBER#${uid}` };
    const userKey = { PK: `USER#${uid}`, SK: `ORG#${organizationId}` };
    const current = await getMembership(organizationId, uid);
    if (!current || current.status !== "active") throw httpError("Active organization membership was not found.", 404);
    if (current.role === "owner") throw httpError("The organization owner role cannot be changed here.", 409);
    await documentClient.send(new commands.TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: { ...current, ...memberKey, role, updatedAt: now }, ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK) AND #role <> :owner AND #status = :active",
          ExpressionAttributeNames: { "#role": "role", "#status": "status" },
          ExpressionAttributeValues: { ":owner": "owner", ":active": "active" }
        } },
        { Put: { TableName: tableName, Item: { ...userKey, entityType: "USER_ORGANIZATION", organizationId, uid, role, status: "active", updatedAt: now }, ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)" } }
      ]
    }));
    return { uid, role, status: "active" };
  }

  async function removeMember({ organizationId, uid }) {
    assertId(organizationId, "organization ID");
    assertId(uid, "user ID");
    const current = await getMembership(organizationId, uid);
    if (!current || current.status !== "active") throw httpError("Active organization membership was not found.", 404);
    if (current.role === "owner") throw httpError("The organization owner cannot be removed.", 409);
    await documentClient.send(new commands.TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: tableName, Key: { PK: `ORG#${organizationId}`, SK: `MEMBER#${uid}` }, ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK) AND #role <> :owner AND #status = :active",
          ExpressionAttributeNames: { "#role": "role", "#status": "status" },
          ExpressionAttributeValues: { ":owner": "owner", ":active": "active" }
        } },
        { Delete: { TableName: tableName, Key: { PK: `USER#${uid}`, SK: `ORG#${organizationId}` }, ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)" } },
        { Update: { TableName: tableName, Key: { PK: `ORG#${organizationId}`, SK: "META" },
          UpdateExpression: "ADD activeMemberCount :minusOne",
          ConditionExpression: "activeMemberCount > :zero",
          ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 }
        } }
      ]
    }));
    return { uid, removed: true };
  }


  async function listMembers(organizationId, { limit = 50, exclusiveStartKey } = {}) {
    assertId(organizationId, "organization ID");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw httpError("Page limit must be between 1 and 100.", 400);
    }
    const input = {
      TableName: tableName,
      KeyConditionExpression: "PK = :organization AND begins_with(SK, :member)",
      ExpressionAttributeValues: {
        ":organization": `ORG#${organizationId}`,
        ":member": "MEMBER#"
      },
      Limit: limit
    };
    if (exclusiveStartKey !== undefined) {
      if (!exclusiveStartKey ||
          exclusiveStartKey.PK !== `ORG#${organizationId}` ||
          typeof exclusiveStartKey.SK !== "string" ||
          !exclusiveStartKey.SK.startsWith("MEMBER#")) {
        throw httpError("Pagination cursor does not belong to this organization member list.", 400);
      }
      input.ExclusiveStartKey = exclusiveStartKey;
    }
    const result = await documentClient.send(new commands.QueryCommand(input));
    return {
      items: result.Items || [],
      lastEvaluatedKey: result.LastEvaluatedKey || null
    };
  }

  async function listOrganizations(uid, { limit = 50, exclusiveStartKey } = {}) {
    assertId(uid, "user ID");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw httpError("Page limit must be between 1 and 100.", 400);
    const input = {
      TableName: tableName,
      KeyConditionExpression: "PK = :user AND begins_with(SK, :organization)",
      ExpressionAttributeValues: { ":user": `USER#${uid}`, ":organization": "ORG#" },
      Limit: limit
    };
    if (exclusiveStartKey !== undefined) {
      if (!exclusiveStartKey || exclusiveStartKey.PK !== `USER#${uid}` ||
          typeof exclusiveStartKey.SK !== "string" || !exclusiveStartKey.SK.startsWith("ORG#")) {
        throw httpError("Pagination cursor does not belong to this user.", 400);
      }
      input.ExclusiveStartKey = exclusiveStartKey;
    }
    const result = await documentClient.send(new commands.QueryCommand(input));
    return { items: result.Items || [], lastEvaluatedKey: result.LastEvaluatedKey || null };
  }

  return Object.freeze({ createOrganization, getMembership, requireActiveOrganization, addMember, updateMemberRole, removeMember, listMembers, listOrganizations });
}

module.exports = { createDynamoOrganizationStore };
