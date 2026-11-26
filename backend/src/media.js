const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_INCOMING_BYTES = 16 * 1024 * 1024;

const SUPPORTED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "video/mp4",
  "video/3gpp",
  "audio/aac",
  "audio/amr",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);


const MAX_PROXY_BYTES = 4 * 1024 * 1024;
const META_MEDIA_HOSTS = new Set(["lookaside.fbsbx.com", "graph.facebook.com"]);

async function fetchWhatsAppMediaForProxy(mediaId, credentials) {
  const accessToken = credentials?.accessToken;
  if (!accessToken || !/^[A-Za-z0-9._:-]{1,256}$/.test(String(mediaId || ""))) {
    throw new Error("Media credentials or ID are invalid.");
  }
  const metadataResponse = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, redirect: "error" }
  );
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok || typeof metadata.url !== "string") {
    const error = new Error(metadata?.error?.message || "WhatsApp media metadata could not be retrieved.");
    error.statusCode = 502;
    throw error;
  }
  const mediaUrl = new URL(metadata.url);
  if (mediaUrl.protocol !== "https:" || !META_MEDIA_HOSTS.has(mediaUrl.hostname) || mediaUrl.username || mediaUrl.password) {
    const error = new Error("WhatsApp returned an untrusted media URL.");
    error.statusCode = 502;
    throw error;
  }
  const declaredSize = Number(metadata.file_size);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PROXY_BYTES) {
    const error = new Error("Media exceeds the 4 MB preview limit.");
    error.statusCode = 413;
    throw error;
  }
  const response = await fetch(mediaUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error"
  });
  if (!response.ok) {
    const error = new Error("WhatsApp media download failed.");
    error.statusCode = 502;
    throw error;
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_PROXY_BYTES) {
    const error = new Error("Media exceeds the 4 MB preview limit.");
    error.statusCode = 413;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_PROXY_BYTES) {
    const error = new Error("Media exceeds the 4 MB preview limit or is empty.");
    error.statusCode = 413;
    throw error;
  }
  const mimeType = validateMedia(metadata.mime_type || response.headers.get("content-type"), buffer.length, MAX_PROXY_BYTES);
  validateMediaContent(mimeType, buffer);
  const filename = String(metadata.filename || "").split(/[\\\\/]/).pop().replace(/[\r\n"]/g, "_").slice(0, 180);
  return { buffer, mimeType, filename };
}

function getStorageBucket() {
  const bucketName =
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.VITE_FIREBASE_STORAGE_BUCKET;

  if (!bucketName) {
    throw new Error("FIREBASE_STORAGE_BUCKET is not configured.");
  }

  return require("firebase-admin/storage")
    .getStorage()
    .bucket(bucketName);
}

function safeObjectId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 180);
}

function validateMedia(mimeType, size, maxSize = MAX_UPLOAD_BYTES) {
  const normalizedType = String(mimeType || "").split(";")[0].trim().toLowerCase();

  if (!SUPPORTED_MEDIA_TYPES.has(normalizedType)) {
    throw new Error(`Unsupported media type: ${normalizedType || "unknown"}.`);
  }

  if (!Number.isSafeInteger(size) || size <= 0 || size > maxSize) {
    throw new Error(`Media must be between 1 byte and ${Math.floor(maxSize / 1024 / 1024)} MB.`);
  }

  return normalizedType;
}

function validateMediaContent(mimeType, buffer) {
  const startsWith = (...bytes) =>
    bytes.every((byte, index) => buffer[index] === byte);
  const hasText = () => {
    try {
      return !buffer.includes(0) && new TextDecoder("utf-8", { fatal: true }).decode(buffer).length > 0;
    } catch {
      return false;
    }
  };
  const isZip = startsWith(0x50, 0x4b, 0x03, 0x04);
  const isOfficeBinary = startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  const signatures = {
    "image/jpeg": () => startsWith(0xff, 0xd8, 0xff),
    "image/png": () => startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    "video/mp4": () => buffer.length > 12 && buffer.toString("ascii", 4, 8) === "ftyp",
    "video/3gpp": () =>
      buffer.length > 12 &&
      buffer.toString("ascii", 4, 8) === "ftyp" &&
      /^(3gp|3g2)/.test(buffer.toString("ascii", 8, 12)),
    "audio/aac": () => startsWith(0xff) && (buffer[1] & 0xf6) === 0xf0,
    "audio/amr": () => buffer.subarray(0, 6).toString("ascii") === "#!AMR\n",
    "audio/mpeg": () =>
      buffer.subarray(0, 3).toString("ascii") === "ID3" ||
      (startsWith(0xff) && (buffer[1] & 0xe0) === 0xe0),
    "audio/mp4": () => buffer.length > 12 && buffer.toString("ascii", 4, 8) === "ftyp",
    "audio/ogg": () => buffer.subarray(0, 4).toString("ascii") === "OggS",
    "application/pdf": () => buffer.subarray(0, 5).toString("ascii") === "%PDF-",
    "text/plain": hasText,
    "application/msword": () => isOfficeBinary,
    "application/vnd.ms-excel": () => isOfficeBinary,
    "application/vnd.ms-powerpoint": () => isOfficeBinary,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": () => isZip,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": () => isZip,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": () => isZip
  };

  if (!signatures[mimeType]?.()) {
    throw new Error("File content does not match its declared media type.");
  }
}

async function saveMessageMedia(chatId, messageId, buffer, mimeType, filename) {
  const safeChatId = safeObjectId(chatId);
  const safeMessageId = safeObjectId(messageId);

  if (!safeChatId || !safeMessageId) {
    throw new Error("A valid chat and message ID are required for media storage.");
  }

  const normalizedType = validateMedia(mimeType, buffer.length, MAX_INCOMING_BYTES);
  validateMediaContent(normalizedType, buffer);
  const storagePath = `messages/${safeChatId}/${safeMessageId}`;
  const file = getStorageBucket().file(storagePath);

  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: normalizedType,
      metadata: {
        originalName: String(filename || "").slice(0, 180)
      }
    }
  });

  return { storagePath, mimeType: normalizedType, size: buffer.length };
}

async function downloadWhatsAppMedia(mediaId, chatId, messageId, filename) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error("WhatsApp API credentials are missing.");
  }

  const safeMediaId = safeObjectId(mediaId);
  if (!safeMediaId) throw new Error("WhatsApp media ID is invalid.");

  const metadataResponse = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${safeMediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok || !metadata.url) {
    throw new Error(
      metadata?.error?.message || "WhatsApp media metadata could not be retrieved."
    );
  }

  const declaredSize = Number(metadata.file_size);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_INCOMING_BYTES) {
    throw new Error("Incoming media exceeds the configured 16 MB retrieval limit.");
  }

  const response = await fetch(metadata.url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error("WhatsApp media download failed.");

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_INCOMING_BYTES) {
    throw new Error("Incoming media exceeds the configured 16 MB retrieval limit.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_INCOMING_BYTES) {
    throw new Error("Incoming media exceeds the configured 16 MB retrieval limit.");
  }

  const mimeType = validateMedia(
    metadata.mime_type || response.headers.get("content-type"),
    buffer.length,
    MAX_INCOMING_BYTES
  );
  validateMediaContent(mimeType, buffer);
  const stored = await saveMessageMedia(
    chatId,
    messageId,
    buffer,
    mimeType,
    filename
  );

  return {
    ...stored,
    mediaId: safeMediaId,
    sha256: String(metadata.sha256 || "").slice(0, 128)
  };
}

async function deleteMessageMedia(storagePath) {
  if (
    typeof storagePath !== "string" ||
    !/^messages\/\d{6,20}\/[a-zA-Z0-9_-]{1,180}$/.test(storagePath)
  ) {
    return;
  }
  await getStorageBucket().file(storagePath).delete({ ignoreNotFound: true });
}

async function getSignedMediaUrl(storagePath) {
  if (
    typeof storagePath !== "string" ||
    !/^messages\/\d{6,20}\/[a-zA-Z0-9_-]{1,180}$/.test(storagePath)
  ) {
    throw new Error("Media reference is invalid.");
  }
  const file = getStorageBucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) return null;

  const expiresAt = Date.now() + 5 * 60 * 1000;
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: expiresAt
  });

  return { url, expiresAt };
}

async function uploadWhatsAppTemplateMedia(buffer, mimeType, filename, credentials, appId = process.env.META_APP_ID) {
  const accessToken = credentials?.accessToken;
  const normalizedType = validateMedia(mimeType, buffer?.length, MAX_UPLOAD_BYTES);
  validateMediaContent(normalizedType, buffer);
  if (!/^\\d{5,32}$/.test(String(appId || "")) || !accessToken) {
    throw new Error("Meta app ID or WhatsApp access token is not configured.");
  }
  if (!["image/jpeg", "image/png", "video/mp4", "application/pdf"].includes(normalizedType)) {
    throw new Error("Template media headers support JPEG, PNG, MP4 or PDF files.");
  }
  const safeFilename = String(filename || "template-media").split(/[\\\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "template-media";
  const version = GRAPH_API_VERSION;
  const sessionUrl = new URL(`https://graph.facebook.com/${version}/${appId}/uploads`);
  sessionUrl.searchParams.set("file_name", safeFilename);
  sessionUrl.searchParams.set("file_length", String(buffer.length));
  sessionUrl.searchParams.set("file_type", normalizedType);
  sessionUrl.searchParams.set("access_token", accessToken);
  const sessionResponse = await fetch(sessionUrl.toString(), { method: "POST", redirect: "error" });
  const sessionPayload = await sessionResponse.json().catch(() => ({}));
  const sessionId = String(sessionPayload.id || "");
  if (!sessionResponse.ok || !/^upload:[A-Za-z0-9_-]{1,256}$/.test(sessionId)) {
    const error = new Error(sessionPayload.error?.message || "Meta could not start the template media upload.");
    error.statusCode = 502;
    throw error;
  }
  const uploadUrl = new URL(`https://graph.facebook.com/${version}/${sessionId}`);
  const uploadResponse = await fetch(uploadUrl.toString(), {
    method: "POST",
    headers: { Authorization: `OAuth ${accessToken}`, file_offset: "0", "Content-Type": "application/octet-stream" },
    body: buffer,
    redirect: "error"
  });
  const uploadPayload = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || typeof uploadPayload.h !== "string" || !uploadPayload.h || uploadPayload.h.length > 4096) {
    const error = new Error(uploadPayload.error?.message || "Meta could not finish the template media upload.");
    error.statusCode = 502;
    throw error;
  }
  return { handle: uploadPayload.h, mimeType: normalizedType, filename: safeFilename, size: buffer.length };
}

async function uploadWhatsAppMedia(buffer, mimeType, filename, credentials) {
  const accessToken = credentials?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = credentials?.phoneNumberId || process.env.PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WhatsApp API credentials are missing.");
  }

  const normalizedType = validateMedia(mimeType, buffer.length);
  validateMediaContent(normalizedType, buffer);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append(
    "file",
    new Blob([buffer], { type: normalizedType }),
    String(filename || "attachment").replace(/[\\/\r\n]/g, "_").slice(0, 180)
  );

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form
    }
  );
  const result = await response.json();
  if (!response.ok || !result.id) {
    throw new Error(result?.error?.message || "WhatsApp media upload failed.");
  }

  return { mediaId: result.id, mimeType: normalizedType };
}


const QUICK_REPLY_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const QUICK_REPLY_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

function quickReplyImagePath(organizationId, quickReplyId) {
  const validId = /^[A-Za-z0-9_-]{1,128}$/;
  if (!validId.test(String(organizationId || "")) || !validId.test(String(quickReplyId || ""))) {
    const error = new Error("Organization and Quick Reply IDs are invalid.");
    error.statusCode = 400;
    throw error;
  }
  return `organizations/${organizationId}/quickReplies/${quickReplyId}`;
}

function validateQuickReplyImage(mimeType, buffer) {
  const normalizedType = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (!QUICK_REPLY_IMAGE_TYPES.has(normalizedType)) {
    const error = new Error("Quick Reply images must be JPEG or PNG.");
    error.statusCode = 400;
    throw error;
  }
  try {
    validateMedia(normalizedType, buffer?.length, QUICK_REPLY_IMAGE_MAX_BYTES);
    validateMediaContent(normalizedType, buffer);
  } catch (cause) {
    const error = new Error(cause.message);
    error.statusCode = 400;
    throw error;
  }
  return normalizedType;
}

async function saveQuickReplyImage(organizationId, quickReplyId, buffer, mimeType) {
  const normalizedType = validateQuickReplyImage(mimeType, buffer);
  const storagePath = quickReplyImagePath(organizationId, quickReplyId);
  const file = getStorageBucket().file(storagePath);
  await file.save(buffer, {
    resumable: false,
    validation: "md5",
    metadata: {
      contentType: normalizedType,
      cacheControl: "private, no-store",
      metadata: { organizationId, quickReplyId, purpose: "saved-quick-reply-image" }
    }
  });
  return { storagePath, mimeType: normalizedType, size: buffer.length };
}

async function getQuickReplyImage(organizationId, quickReplyId) {
  const storagePath = quickReplyImagePath(organizationId, quickReplyId);
  const file = getStorageBucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buffer] = await file.download();
  const [metadata] = await file.getMetadata();
  const mimeType = validateQuickReplyImage(metadata.contentType, buffer);
  return { buffer, mimeType, size: buffer.length, storagePath };
}

async function deleteQuickReplyImage(organizationId, quickReplyId) {
  const storagePath = quickReplyImagePath(organizationId, quickReplyId);
  await getStorageBucket().file(storagePath).delete({ ignoreNotFound: true });
}

module.exports = {
  MAX_UPLOAD_BYTES,
  QUICK_REPLY_IMAGE_MAX_BYTES,
  quickReplyImagePath,
  validateQuickReplyImage,
  saveQuickReplyImage,
  getQuickReplyImage,
  deleteQuickReplyImage,
  SUPPORTED_MEDIA_TYPES,
  downloadWhatsAppMedia,
  deleteMessageMedia,
  getSignedMediaUrl,
  saveMessageMedia,
  uploadWhatsAppMedia,
  uploadWhatsAppTemplateMedia,
  validateMedia,
  validateMediaContent,
  fetchWhatsAppMediaForProxy
};
