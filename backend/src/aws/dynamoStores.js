"use strict";

const { createDynamoTenantStore } = require("./dynamoTenantStore");
const { createDynamoOrganizationStore } = require("./dynamoOrganizationStore");
const { createDynamoTenancy } = require("./dynamoTenancy");
const { createDynamoMemberManagement } = require("./dynamoMemberManagement");
const { createDynamoAuditStore } = require("./dynamoAuditStore");
const { createDynamoSubscriptionStore } = require("./dynamoSubscriptionStore");

/**
 * Creates isolated adapters for the three owner-verified DynamoDB tables.
 * No AWS SDK clients are constructed here; the caller injects configured
 * clients and command constructors. This factory is not enabled by the API
 * until identity and all domain migrations are complete.
 */
function createDynamoStores({ documentClient, commands, env = process.env, getSeatLimit, recordMemberAudit, plans }) {
  const messagesTable = env.DYNAMODB_MESSAGES_TABLE || "JoyInboxMessages";
  const customersTable = env.DYNAMODB_CUSTOMERS_TABLE || "JoyInboxCustomers";
  const workspacesTable = env.DYNAMODB_WORKSPACES_TABLE || "JoyInboxWorkspaces";

  for (const [label, value] of [
    ["DYNAMODB_MESSAGES_TABLE", messagesTable],
    ["DYNAMODB_CUSTOMERS_TABLE", customersTable],
    ["DYNAMODB_WORKSPACES_TABLE", workspacesTable]
  ]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(value)) {
      throw new Error(label + " must be a valid DynamoDB table name.");
    }
  }
  if (new Set([messagesTable, customersTable, workspacesTable]).size !== 3) {
    throw new Error("Joy Inbox messages, customers and workspaces must use three distinct DynamoDB tables.");
  }

  const organizations = createDynamoOrganizationStore({
    documentClient, commands, tableName: messagesTable
  });
  const tenancy = createDynamoTenancy({ organizationStore: organizations });
  const audit = createDynamoAuditStore({ documentClient, commands, tableName: messagesTable });
  const subscriptions = createDynamoSubscriptionStore({ documentClient, commands, tableName: messagesTable, ...(plans ? { plans } : {}) });
  const memberManagement = createDynamoMemberManagement({
    organizationStore: organizations,
    getSeatLimit: getSeatLimit || subscriptions.getSeatLimit,
    recordAudit: recordMemberAudit || audit.record
  });
  const messages = createDynamoTenantStore({
    documentClient, commands, tableName: messagesTable
  });
  const customers = createDynamoTenantStore({
    documentClient, commands, tableName: customersTable
  });
  const workspaces = createDynamoTenantStore({
    documentClient, commands, tableName: workspacesTable
  });

  return Object.freeze({
    organizations,
    tenancy,
    audit,
    subscriptions,
    memberManagement,
    messages,
    customers: Object.freeze({
      get: (organizationId, customerId) => customers.get(organizationId, "CUSTOMER", customerId),
      put: (organizationId, customerId, attributes, options) => customers.put(organizationId, "CUSTOMER", customerId, attributes, options),
      list: (organizationId, options) => customers.list(organizationId, "CUSTOMER", options),
      remove: (organizationId, customerId) => customers.remove(organizationId, "CUSTOMER", customerId)
    }),
    workspaces: Object.freeze({
      get: (organizationId, workspaceId) => workspaces.get(organizationId, "WORKSPACE", workspaceId),
      put: (organizationId, workspaceId, attributes, options) => workspaces.put(organizationId, "WORKSPACE", workspaceId, attributes, options),
      list: (organizationId, options) => workspaces.list(organizationId, "WORKSPACE", options),
      remove: (organizationId, workspaceId) => workspaces.remove(organizationId, "WORKSPACE", workspaceId)
    }),
    tableNames: Object.freeze({
      messages: messagesTable,
      customers: customersTable,
      workspaces: workspacesTable
    })
  });
}

module.exports = { createDynamoStores };
