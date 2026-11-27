"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAwsServices } = require("../src/aws/awsServices");

function fakeSdk() {
  const created = [];
  class Client { constructor(config) { this.config = config; created.push(this); } }
  class Command { constructor(input) { this.input = input; } }
  class DocumentClient {
    static from(client, options) {
      const value = { send: async () => ({}), client, options };
      created.push(value);
      return value;
    }
  }
  return {
    created,
    sdk: {
      DynamoDBClient: Client,
      DynamoDBDocumentClient: DocumentClient,
      S3Client: Client,
      GetCommand: Command,
      PutCommand: Command,
      QueryCommand: Command,
      DeleteCommand: Command,
      TransactWriteCommand: Command,
      UpdateCommand: Command,
      PutObjectCommand: Command,
      GetObjectCommand: Command,
      DeleteObjectCommand: Command
    }
  };
}

const env = {
  AWS_REGION: "ap-south-1",
  DYNAMODB_MESSAGES_TABLE: "JoyInboxMessages",
  DYNAMODB_CUSTOMERS_TABLE: "JoyInboxCustomers",
  DYNAMODB_WORKSPACES_TABLE: "JoyInboxWorkspaces",
  S3_MEDIA_BUCKET: "joy-inbox-media-staging",
  COGNITO_USER_POOL_ID: "ap-south-1_Abc123xyz",
  COGNITO_APP_CLIENT_ID: "Abcdef1234567890"
};

test("constructs DynamoDB and S3 clients and wires tenant stores plus private media", () => {
  const { sdk, created } = fakeSdk();
  const presigner = async () => "https://signed.example";
  const services = createAwsServices({ env, sdk, getSignedUrl: presigner });

  assert.equal(created.length, 3);
  assert.equal(services.dynamoClient.config.region, "ap-south-1");
  assert.equal(services.s3Client.config.region, "ap-south-1");
  assert.deepEqual(services.stores.tableNames, {
    messages: "JoyInboxMessages",
    customers: "JoyInboxCustomers",
    workspaces: "JoyInboxWorkspaces"
  });
  assert.equal(typeof services.media.save, "function");
  assert.equal(typeof services.media.signedDownload, "function");
  assert.equal(typeof services.media.remove, "function");
  assert.equal(services.config.mediaBucket, "joy-inbox-media-staging");
});

test("does not construct AWS clients when required resource configuration is missing", () => {
  const { sdk, created } = fakeSdk();
  assert.throws(
    () => createAwsServices({ env: { ...env, S3_MEDIA_BUCKET: "" }, sdk, getSignedUrl: async () => "" }),
    /S3_MEDIA_BUCKET is required/
  );
  assert.equal(created.length, 0);
});
