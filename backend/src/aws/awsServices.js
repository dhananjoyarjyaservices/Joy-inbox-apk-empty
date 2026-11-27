"use strict";

const { getAwsRuntimeConfig } = require("./awsRuntimeConfig");
const { createDynamoStores } = require("./dynamoStores");
const { createS3MediaStore } = require("./s3MediaStore");
const { checkAwsDependencies } = require("./awsReadiness");

/**
 * Construct AWS SDK v3 clients from the Lambda Node.js 22 runtime.
 * SDK modules are loaded lazily so local unit tests can inject a fake SDK and
 * legacy Firebase mode does not initialize AWS clients accidentally.
 *
 * The Lambda Node.js 22 runtime includes AWS SDK for JavaScript v3. Pin and
 * bundle SDK modules in the deployment package before relying on a specific
 * SDK version or upgrading the Lambda runtime.
 */
function createAwsServices({ env = process.env, sdk, getSignedUrl, plans, getSeatLimit, recordMemberAudit } = {}) {
  const config = getAwsRuntimeConfig(env);
  const aws = sdk || {
    DynamoDBClient: require("@aws-sdk/client-dynamodb").DynamoDBClient,
    DynamoDBDocumentClient: require("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,
    ...require("@aws-sdk/lib-dynamodb"),
    S3Client: require("@aws-sdk/client-s3").S3Client,
    ...require("@aws-sdk/client-s3")
  };
  const presigner = getSignedUrl || require("@aws-sdk/s3-request-presigner").getSignedUrl;

  const dynamoClient = new aws.DynamoDBClient({ region: config.region });
  const documentClient = aws.DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true }
  });
  const s3Client = new aws.S3Client({ region: config.region });

  const stores = createDynamoStores({
    documentClient,
    commands: {
      GetCommand: aws.GetCommand,
      PutCommand: aws.PutCommand,
      QueryCommand: aws.QueryCommand,
      DeleteCommand: aws.DeleteCommand,
      TransactWriteCommand: aws.TransactWriteCommand,
      UpdateCommand: aws.UpdateCommand
    },
    env,
    ...(plans ? { plans } : {}),
    ...(getSeatLimit ? { getSeatLimit } : {}),
    ...(recordMemberAudit ? { recordMemberAudit } : {})
  });
  const media = createS3MediaStore({
    client: s3Client,
    commands: {
      PutObjectCommand: aws.PutObjectCommand,
      GetObjectCommand: aws.GetObjectCommand,
      DeleteObjectCommand: aws.DeleteObjectCommand
    },
    getSignedUrl: presigner,
    bucketName: config.mediaBucket
  });

  return Object.freeze({
    config,
    dynamoClient,
    documentClient,
    s3Client,
    stores,
    media
  });
}

module.exports = { createAwsServices };
