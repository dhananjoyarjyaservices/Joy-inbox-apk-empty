"use strict";

/**
 * Private S3 media primitives. AWS SDK clients/commands and presigning are
 * injected so unit tests run without credentials. Bucket policy and Block
 * Public Access must be configured in infrastructure before enabling this.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_ID_PATTERN = /^[A-Za-z0-9._-]{1,180}$/;
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "video/mp4", "video/3gpp",
  "audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg",
  "application/pdf", "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateIdentity(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw httpError(`A valid ${label} is required.`, 400);
  }
}

function createS3MediaStore({ client, commands, getSignedUrl, bucketName, expiresIn = 300, maxBytes = 16 * 1024 * 1024 }) {
  if (!client || typeof client.send !== "function") throw new Error("An S3 client is required.");
  if (!commands?.PutObjectCommand || !commands?.GetObjectCommand || !commands?.DeleteObjectCommand) {
    throw new Error("S3 command constructors are required.");
  }
  if (typeof getSignedUrl !== "function") throw new Error("An S3 presigning function is required.");
  if (typeof bucketName !== "string" || !bucketName.trim()) throw new Error("S3_MEDIA_BUCKET is not configured.");
  if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 3600) throw new Error("S3 signed URL expiry must be between 60 and 3600 seconds.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) throw new Error("S3 media size limit is invalid.");

  function objectKey(organizationId, chatId, mediaId) {
    validateIdentity(organizationId, "organization ID", ID_PATTERN);
    validateIdentity(chatId, "chat ID", ID_PATTERN);
    validateIdentity(mediaId, "media ID", MEDIA_ID_PATTERN);
    return `organizations/${organizationId}/chats/${chatId}/media/${mediaId}`;
  }

  async function save({ organizationId, chatId, mediaId, body, contentType, contentLength }) {
    const Key = objectKey(organizationId, chatId, mediaId);
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > maxBytes ||
        !Number.isSafeInteger(contentLength) || contentLength !== body.length || contentLength > maxBytes) {
      throw httpError("Media size is invalid or exceeds the configured limit.", 413);
    }
    const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(normalizedType)) throw httpError("Unsupported media content type.", 415);
    await client.send(new commands.PutObjectCommand({
      Bucket: bucketName,
      Key,
      Body: body,
      ContentType: normalizedType,
      ContentLength: contentLength,
      ServerSideEncryption: "AES256",
      Metadata: { organizationid: organizationId, chatid: chatId }
    }));
    return { key: Key, size: contentLength, contentType: normalizedType };
  }

  async function signedDownload({ organizationId, chatId, mediaId }) {
    const Key = objectKey(organizationId, chatId, mediaId);
    const command = new commands.GetObjectCommand({ Bucket: bucketName, Key });
    return getSignedUrl(client, command, { expiresIn });
  }

  async function remove({ organizationId, chatId, mediaId }) {
    const Key = objectKey(organizationId, chatId, mediaId);
    await client.send(new commands.DeleteObjectCommand({ Bucket: bucketName, Key }));
  }

  return Object.freeze({ save, signedDownload, remove, objectKey });
}

module.exports = { createS3MediaStore, ALLOWED_TYPES };
