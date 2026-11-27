"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getAwsRuntimeConfig } = require("../src/aws/awsRuntimeConfig");

const validEnv = () => ({
  AWS_REGION: "ap-south-1",
  DYNAMODB_MESSAGES_TABLE: "JoyInboxMessages",
  DYNAMODB_CUSTOMERS_TABLE: "JoyInboxCustomers",
  DYNAMODB_WORKSPACES_TABLE: "JoyInboxWorkspaces",
  S3_MEDIA_BUCKET: "joy-inbox-media-staging",
  COGNITO_USER_POOL_ID: "ap-south-1_Abc123xyz",
  COGNITO_APP_CLIENT_ID: "Abcdef1234567890"
});

test("returns immutable AWS runtime config for the verified Mumbai region", () => {
  const config = getAwsRuntimeConfig(validEnv());
  assert.equal(config.region, "ap-south-1");
  assert.equal(config.mediaBucket, "joy-inbox-media-staging");
  assert.equal(config.cognitoUserPoolId, "ap-south-1_Abc123xyz");
  assert.deepEqual(config.tableNames, {
    messages: "JoyInboxMessages",
    customers: "JoyInboxCustomers",
    workspaces: "JoyInboxWorkspaces"
  });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.tableNames));
});

test("rejects missing resources rather than silently using guessed names", () => {
  const env = validEnv();
  delete env.S3_MEDIA_BUCKET;
  assert.throws(() => getAwsRuntimeConfig(env), /S3_MEDIA_BUCKET is required/);
});

test("rejects table collisions and malformed table names", () => {
  const collision = validEnv();
  collision.DYNAMODB_CUSTOMERS_TABLE = collision.DYNAMODB_MESSAGES_TABLE;
  assert.throws(() => getAwsRuntimeConfig(collision), /must be distinct/);

  const malformed = validEnv();
  malformed.DYNAMODB_WORKSPACES_TABLE = "bad/table";
  assert.throws(() => getAwsRuntimeConfig(malformed), /valid DynamoDB table name/);
});

test("rejects non-Mumbai resources and mismatched Cognito pool region", () => {
  const wrongRegion = validEnv();
  wrongRegion.AWS_REGION = "us-east-1";
  assert.throws(() => getAwsRuntimeConfig(wrongRegion), /must be ap-south-1/);

  const wrongPool = validEnv();
  wrongPool.COGNITO_USER_POOL_ID = "us-east-1_Abc123xyz";
  assert.throws(() => getAwsRuntimeConfig(wrongPool), /in ap-south-1/);
});

test("rejects invalid S3 bucket and Cognito app-client identifiers", () => {
  const badBucket = validEnv();
  badBucket.S3_MEDIA_BUCKET = "Not a bucket";
  assert.throws(() => getAwsRuntimeConfig(badBucket), /valid S3 bucket/);

  const badClient = validEnv();
  badClient.COGNITO_APP_CLIENT_ID = "short";
  assert.throws(() => getAwsRuntimeConfig(badClient), /COGNITO_APP_CLIENT_ID is invalid/);
});
