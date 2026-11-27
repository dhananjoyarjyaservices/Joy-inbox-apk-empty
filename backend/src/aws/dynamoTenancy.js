"use strict";

const { ROLES, ROLE_PERMISSIONS } = require("../tenancy");

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * DynamoDB-backed tenant authorization adapter.
 * It mirrors the existing tenancy permission contract while resolving
 * organization and membership exclusively from authoritative DynamoDB items.
 * It is intentionally opt-in until all route data dependencies are migrated.
 */
function createDynamoTenancy({ organizationStore }) {
  if (!organizationStore ||
      typeof organizationStore.requireActiveOrganization !== "function") {
    throw new Error("A DynamoDB organization store is required.");
  }

  async function requireOrganization(decoded, organizationId) {
    if (!decoded || typeof decoded.uid !== "string" || !decoded.uid) {
      throw httpError("Authentication required.", 401);
    }
    if (typeof organizationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) {
      throw httpError("A valid organization ID is required.", 400);
    }
    const organization = await organizationStore.requireActiveOrganization(
      organizationId,
      decoded.uid
    );
    if (!ROLES.has(organization.role)) {
      throw httpError("You are not an active member of this organization.", 403);
    }
    return {
      ...organization,
      uid: decoded.uid,
      id: organizationId
    };
  }

  function requirePermission(organization, permission) {
    if (!organization ||
        !ROLE_PERMISSIONS[organization.role]?.has(permission)) {
      throw httpError("Insufficient organization permissions.", 403);
    }
  }

  return Object.freeze({ requireOrganization, requirePermission });
}

module.exports = { createDynamoTenancy };
