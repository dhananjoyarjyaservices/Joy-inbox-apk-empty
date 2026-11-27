"use strict";

/**
 * AWS-native, tenant-scoped access primitives for the existing JoyInboxMessages
 * DynamoDB table (PK String, SK String).
 *
 * This module deliberately accepts an injected DynamoDB DocumentClient and
 * command constructors so unit tests do not need AWS credentials. It is a
 * migration foundation only; Firebase-backed domain modules are not switched
 * over until their access patterns and transactional behavior are migrated.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertOrganizationId(organizationId) {
  if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) {
    throw httpError("A valid organization ID is required.", 400);
  }
}

function assertResourceType(resourceType) {
  if (typeof resourceType !== "string" || !/^[A-Z][A-Z0-9_]{0,31}$/.test(resourceType)) {
    throw httpError("A valid resource type is required.", 400);
  }
}

function assertResourceId(resourceId) {
  if (typeof resourceId !== "string" || !ID_PATTERN.test(resourceId)) {
    throw httpError("A valid resource ID is required.", 400);
  }
}

function createDynamoTenantStore({ documentClient, commands, tableName }) {
  if (!documentClient || typeof documentClient.send !== "function") {
    throw new Error("A DynamoDB DocumentClient is required.");
  }
  if (!commands?.GetCommand || !commands?.PutCommand ||
      !commands?.QueryCommand || !commands?.DeleteCommand) {
    throw new Error("DynamoDB command constructors are required.");
  }
  if (typeof tableName !== "string" || !tableName.trim()) {
    throw new Error("DYNAMODB_TABLE_NAME is not configured.");
  }

  function keys(organizationId, resourceType, resourceId) {
    assertOrganizationId(organizationId);
    assertResourceType(resourceType);
    assertResourceId(resourceId);
    return {
      PK: `ORG#${organizationId}`,
      SK: `${resourceType}#${resourceId}`
    };
  }

  async function get(organizationId, resourceType, resourceId) {
    const Key = keys(organizationId, resourceType, resourceId);
    const result = await documentClient.send(new commands.GetCommand({
      TableName: tableName,
      Key,
      ConsistentRead: true
    }));
    return result.Item || null;
  }

  async function put(organizationId, resourceType, resourceId, attributes, options = {}) {
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
      throw httpError("Resource attributes must be an object.", 400);
    }
    const Key = keys(organizationId, resourceType, resourceId);
    const Item = { ...attributes, ...Key, entityType: resourceType, organizationId };
    const input = { TableName: tableName, Item };
    if (options.ifAbsent === true) {
      input.ConditionExpression = "attribute_not_exists(PK) AND attribute_not_exists(SK)";
    }
    await documentClient.send(new commands.PutCommand(input));
    return Item;
  }

  async function list(organizationId, resourceType, options = {}) {
    assertOrganizationId(organizationId);
    assertResourceType(resourceType);
    const limit = options.limit === undefined ? 50 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw httpError("Page limit must be an integer between 1 and 100.", 400);
    }
    const input = {
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `ORG#${organizationId}`,
        ":prefix": `${resourceType}#`
      },
      Limit: limit,
      ScanIndexForward: options.scanIndexForward !== false
    };
    if (options.exclusiveStartKey !== undefined) {
      if (!options.exclusiveStartKey || options.exclusiveStartKey.PK !== input.ExpressionAttributeValues[":pk"] ||
          typeof options.exclusiveStartKey.SK !== "string" ||
          !options.exclusiveStartKey.SK.startsWith(input.ExpressionAttributeValues[":prefix"])) {
        throw httpError("Pagination cursor does not belong to this organization and resource.", 400);
      }
      input.ExclusiveStartKey = options.exclusiveStartKey;
    }
    const result = await documentClient.send(new commands.QueryCommand(input));
    return {
      items: result.Items || [],
      lastEvaluatedKey: result.LastEvaluatedKey || null
    };
  }

  async function remove(organizationId, resourceType, resourceId) {
    const Key = keys(organizationId, resourceType, resourceId);
    await documentClient.send(new commands.DeleteCommand({
      TableName: tableName,
      Key,
      ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)"
    }));
  }

  return Object.freeze({ get, put, list, remove });
}

module.exports = {
  createDynamoTenantStore,
  assertOrganizationId,
  assertResourceType,
  assertResourceId
};
