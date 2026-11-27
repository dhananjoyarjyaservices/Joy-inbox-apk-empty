"use strict";

const DEFAULT_REGION = "ap-south-1";
const TABLE_ENV = [
  "DYNAMODB_MESSAGES_TABLE",
  "DYNAMODB_CUSTOMERS_TABLE",
  "DYNAMODB_WORKSPACES_TABLE"
];

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(name + " is required for AWS-native runtime.");
  }
  return value.trim();
}

function validateTableName(name, envName) {
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(name)) {
    throw new Error(envName + " must be a valid DynamoDB table name.");
  }
  return name;
}

/**
 * Validates the complete minimum AWS runtime configuration without creating
 * clients or changing the active authentication/data provider.
 */
function getAwsRuntimeConfig(env = process.env) {
  const region = env.AWS_REGION || DEFAULT_REGION;
  if (region !== DEFAULT_REGION) {
    throw new Error("AWS_REGION must be ap-south-1 for the current Joy Inbox deployment.");
  }

  const tableNames = Object.fromEntries(TABLE_ENV.map(name => [
    name.replace("DYNAMODB_", "").replace("_TABLE", "").toLowerCase(),
    validateTableName(required(env, name), name)
  ]));
  if (new Set(Object.values(tableNames)).size !== TABLE_ENV.length) {
    throw new Error("AWS DynamoDB messages, customers and workspaces tables must be distinct.");
  }

  const bucket = required(env, "S3_MEDIA_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("S3_MEDIA_BUCKET must be a valid S3 bucket name.");
  }

  const userPoolId = required(env, "COGNITO_USER_POOL_ID");
  if (!/^ap-south-1_[A-Za-z0-9]+$/.test(userPoolId)) {
    throw new Error("COGNITO_USER_POOL_ID must identify a user pool in ap-south-1.");
  }
  const clientId = required(env, "COGNITO_APP_CLIENT_ID");
  if (!/^[A-Za-z0-9]{8,128}$/.test(clientId)) {
    throw new Error("COGNITO_APP_CLIENT_ID is invalid.");
  }

  return Object.freeze({
    region,
    tableNames: Object.freeze(tableNames),
    mediaBucket: bucket,
    cognitoUserPoolId: userPoolId,
    cognitoAppClientId: clientId
  });
}

module.exports = { DEFAULT_REGION, getAwsRuntimeConfig };
