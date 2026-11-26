"use strict";

const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

let s3Client;

function getS3Client() {
  if (s3Client) return s3Client;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS_REGION must be configured for S3 media.");
  s3Client = new S3Client({ region });
  return s3Client;
}

function setS3ClientForTests(client) {
  s3Client = client || undefined;
}

function getBucketName() {
  const bucket = process.env.S3_MEDIA_BUCKET;
  if (typeof bucket !== "string" || !bucket.trim()) {
    throw new Error("S3_MEDIA_BUCKET must be configured.");
  }
  return bucket.trim();
}

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    const error = new Error("A valid " + label + " is required.");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function buildMessageMediaKey({ organizationId, customerId, messageId, objectId }) {
  return [
    "tenants",
    safeSegment(organizationId, "organization ID"),
    "customers",
    safeSegment(customerId, "customer ID"),
    "messages",
    safeSegment(messageId, "message ID"),
    safeSegment(objectId || crypto.randomUUID(), "object ID")
  ].join("/");
}

function buildQuickReplyImageKey({ organizationId, quickReplyId, objectId }) {
  return [
    "tenants",
    safeSegment(organizationId, "organization ID"),
    "quick-replies",
    safeSegment(quickReplyId, "Quick Reply ID"),
    safeSegment(objectId || crypto.randomUUID(), "object ID")
  ].join("/");
}

async function savePrivateMedia({ key, body, contentType, contentLength, checksumSHA256, metadata = {} }) {
  if (typeof key !== "string" || !key.startsWith("tenants/")) throw new Error("A tenant-scoped S3 object key is required.");
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error("Media body must be a non-empty Buffer.");
  if (Number.isFinite(contentLength) && contentLength !== body.length) throw new Error("Media content length does not match its body.");
  const digest = crypto.createHash("sha256").update(body).digest("base64");
  if (checksumSHA256 && checksumSHA256 !== digest) throw new Error("Media checksum validation failed.");
  await getS3Client().send(new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: body,
    ContentType: String(contentType || "application/octet-stream"),
    ContentLength: body.length,
    ChecksumSHA256: digest,
    ServerSideEncryption: "AES256",
    Metadata: Object.fromEntries(Object.entries(metadata).filter(([name, value]) =>
      /^[a-z0-9-]{1,64}$/i.test(name) && typeof value === "string" && value.length <= 512
    ))
  }));
  return { bucket: getBucketName(), key, contentType: String(contentType || "application/octet-stream"), sizeBytes: body.length, checksumSHA256: digest };
}

async function createPrivateMediaReadUrl(key, expiresInSeconds = 300) {
  if (typeof key !== "string" || !key.startsWith("tenants/")) throw new Error("A tenant-scoped S3 object key is required.");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
    throw new Error("Presigned media URL expiry must be between 60 and 900 seconds.");
  }
  return getSignedUrl(getS3Client(), new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key
  }), { expiresIn: expiresInSeconds });
}

async function deletePrivateMedia(key) {
  if (typeof key !== "string" || !key.startsWith("tenants/")) throw new Error("A tenant-scoped S3 object key is required.");
  await getS3Client().send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }));
  return true;
}

async function headPrivateMedia(key) {
  if (typeof key !== "string" || !key.startsWith("tenants/")) throw new Error("A tenant-scoped S3 object key is required.");
  try {
    const result = await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: key }));
    return { exists: true, sizeBytes: Number(result.ContentLength || 0), contentType: result.ContentType || null, checksumSHA256: result.ChecksumSHA256 || null };
  } catch (error) {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return { exists: false };
    throw error;
  }
}

module.exports = {
  getS3Client,
  setS3ClientForTests,
  getBucketName,
  buildMessageMediaKey,
  buildQuickReplyImageKey,
  savePrivateMedia,
  createPrivateMediaReadUrl,
  deletePrivateMedia,
  headPrivateMedia
};
