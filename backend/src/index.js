
const crypto = require("crypto");
const { getFirebaseAdmin, getDb } = require("./firebase");
const {
  getHeader,
  jsonResponse,
  getCorsHeaders,
  textResponse,
  emptyResponse
} = require("./security");
const {
  verifyWebhook,
  receiveWebhook
} = require("./webhook");
const {
  normalizePhoneNumber,
  isDefinitiveWhatsAppSendRejection,
  sendWhatsAppText,
  sendWhatsAppMedia,
  checkWhatsAppConnection
} = require("./whatsapp");
const {
  MAX_UPLOAD_BYTES,
  deleteMessageMedia,
  getSignedMediaUrl,
  saveMessageMedia,
  uploadWhatsAppMedia,
  validateMedia,
  validateMediaContent,
  fetchWhatsAppMediaForProxy,
  QUICK_REPLY_IMAGE_MAX_BYTES,
  saveQuickReplyImage,
  getQuickReplyImage,
  deleteQuickReplyImage
} = require("./media");
const { OWNER_UID } = require("./owner");
const { createOrganization, listOrganizations } = require("./organizations");
const { listOrganizationMembers, listOrganizationMemberAudit, addOrganizationMember, updateOrganizationMemberRole, removeOrganizationMember } = require("./organizationMembers");
const { listTenantResource, saveTenantResource, deleteTenantResource } = require("./tenantResources");
const { updateTenantChatState, updateTenantMessageState, deleteTenantMessages, deleteTenantChats } = require("./tenantChatActions");
const { updateTenantChatAssignment } = require("./tenantChatAssignment");
const { requireOrganization, requirePermission, saveWhatsAppConnection, disconnectWhatsAppConnection, getWhatsAppCredentials, listWhatsAppConnections } = require("./tenancy");
const { getTenantChatRef, getTenantMessageRef, claimTenantSendRequest, getRetryableTenantTextMessage, resolveTenantReplyContext, getTenantReplyMessageFields, markTenantSendRequestFailed } = require("./tenantMessaging");
const { isValidBase64, isAllowedTemplateMedia } = require("./templateValidation");
const { resolveReplyContext, getReplyMessageFields } = require("./replies");
const {
  claimSendRequest,
  markSendRequestFailed
} = require("./sendRequests");
const {
  getDeviceDocument,
  getTenantDeviceDocument,
  isValidFcmToken,
  isValidInstallationId
} = require("./push");

function getMethod(event) {
  return (
    event.requestContext?.http?.method ||
    event.httpMethod ||
    "GET"
  ).toUpperCase();
}

function getPath(event) {
  return event.rawPath || event.path || "/";
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  return JSON.parse(body);
}

function getClientMessageId(value) {
  if (value === undefined) return crypto.randomUUID();
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    const error = new Error("A valid client message ID is required.");
    error.statusCode = 400;
    error.retryable = false;
    throw error;
  }
  return value;
}

function hashSendPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function logLatency(name, startedAt, details = {}) {
  console.info(JSON.stringify({
    metric: name,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...details
  }));
}

async function authenticateUser(event) {
  const authorization = getHeader(event, "authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    const error = new Error("Authentication required.");
    error.statusCode = 401;
    throw error;
  }
  const idToken = authorization.slice(7).trim();
  if (!idToken) {
    const error = new Error("Firebase ID token is missing.");
    error.statusCode = 401;
    throw error;
  }
  try {
    return await getFirebaseAdmin().auth().verifyIdToken(idToken, true);
  } catch {
    const error = new Error("Firebase ID token is invalid or expired.");
    error.statusCode = 401;
    throw error;
  }
}

async function handleWhatsAppConnections(event) {
  const decoded = await authenticateUser(event);
  const organizationId = event.queryStringParameters?.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "chats:read");
  const connections = await listWhatsAppConnections(getDb(), organization.id);
  return jsonResponse(event, 200, { connections });
}

async function handleWhatsAppTemplates(event) {
  const decoded = await authenticateUser(event);
  const organizationId = event.queryStringParameters?.organizationId;
  const phoneNumberId = event.queryStringParameters?.phoneNumberId;
  const wabaId = event.queryStringParameters?.wabaId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "chats:read");
  if (typeof phoneNumberId !== "string" || !/^[0-9]{5,32}$/.test(phoneNumberId) || typeof wabaId !== "string" || !/^[0-9]{5,32}$/.test(wabaId)) {
    return jsonResponse(event, 400, { error: "A valid connected phone number and WhatsApp Business Account ID are required." });
  }
  const connections = await listWhatsAppConnections(getDb(), organization.id);
  const connection = connections.find(item => item.phoneNumberId === phoneNumberId && item.connected);
  if (!connection) return jsonResponse(event, 404, { error: "This WhatsApp number is not connected to the workspace." });
  const credentials = await getWhatsAppCredentials(getDb(), organization.id, phoneNumberId);
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/message_templates`);
  url.searchParams.set("fields", "id,name,status,language,category,components");
  url.searchParams.set("limit", "100");
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${credentials.accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("Meta template list request failed:", response.status, payload.error?.code);
    return jsonResponse(event, response.status === 401 || response.status === 403 ? 502 : 502, {
      error: payload.error?.message || "Meta could not load message templates. Check the WhatsApp Business Account ID and token permissions."
    });
  }
  const templates = Array.isArray(payload.data) ? payload.data.map(item => ({
    id: String(item.id || ""),
    name: String(item.name || ""),
    status: String(item.status || "UNKNOWN"),
    language: String(item.language || ""),
    category: String(item.category || ""),
    components: Array.isArray(item.components) ? item.components : []
  })) : [];
  return jsonResponse(event, 200, { templates, paging: payload.paging?.cursors ? { hasNext: Boolean(payload.paging?.next) } : { hasNext: false } });
}

async function handleWhatsAppConnectionHealth(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); } catch {
    return jsonResponse(event, 400, { error: "A valid JSON request body is required." });
  }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "whatsapp:manage");
  const connections = await listWhatsAppConnections(getDb(), organization.id);
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(connections.filter((item) => item.connected).map(async (item) => {
    try {
      const credentials = await getWhatsAppCredentials(getDb(), organization.id, item.phoneNumberId);
      const response = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(item.phoneNumberId)}?fields=id,display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } }
      );
      const meta = await response.json().catch(() => ({}));
      const healthy = response.ok && String(meta.id || "") === item.phoneNumberId;
      return {
        phoneNumberId: item.phoneNumberId,
        status: healthy ? "healthy" : "attention",
        checkedAt,
        ...(healthy ? {
          displayPhoneNumber: String(meta.display_phone_number || item.displayPhoneNumber || ""),
          verifiedName: String(meta.verified_name || item.verifiedName || "")
        } : { error: "Meta could not verify this number. Check its access token and WhatsApp permissions." })
      };
    } catch {
      return {
        phoneNumberId: item.phoneNumberId,
        status: "attention",
        checkedAt,
        error: "Could not reach Meta or read this connection. Try again."
      };
    }
  }));
  return jsonResponse(event, 200, { results, checkedAt });
}

async function handleWhatsAppConnect(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); } catch {
    return jsonResponse(event, 400, { error: "A valid JSON request body is required." });
  }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "whatsapp:manage");
  if (getMethod(event) === "DELETE") {
    const disconnected = await disconnectWhatsAppConnection(getDb(), organization, String(body.phoneNumberId || "").trim());
    return jsonResponse(event, 200, { connection: disconnected });
  }
  const phoneNumberId = String(body.phoneNumberId || "").trim();
  const accessToken = String(body.accessToken || "").trim();
  if (!phoneNumberId || !accessToken) {
    return jsonResponse(event, 400, { error: "WhatsApp Phone Number ID and access token are required." });
  }

  // Verify the supplied token against Meta before saving any secret.
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const response = await fetch(
    `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await response.json().catch(() => ({}));
  if (!response.ok || String(meta.id || "") !== phoneNumberId) {
    return jsonResponse(event, 400, {
      error: String(meta?.error?.message || "Meta could not verify this WhatsApp number and access token.").slice(0, 240)
    });
  }

  const connection = await saveWhatsAppConnection(getDb(), organization, {
    phoneNumberId,
    accessToken,
    displayPhoneNumber: meta.display_phone_number,
    verifiedName: meta.verified_name
  });
  return jsonResponse(event, 200, { connection });
}

async function handleOrganizations(event) {
  const decoded = await authenticateUser(event);
  if (getMethod(event) === "GET") {
    const organizations = await listOrganizations(getDb(), decoded);
    return jsonResponse(event, 200, { organizations });
  }
  let body;
  try {
    body = parseBody(event);
  } catch {
    return jsonResponse(event, 400, { error: "A valid JSON request body is required." });
  }
  const organization = await createOrganization(getDb(), decoded, body);
  return jsonResponse(event, 201, { organization });
}

async function handleOrganizationMemberAudit(event) {
  const decoded = await authenticateUser(event);
  const organizationId = event.queryStringParameters?.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "members:manage");
  const page = await listOrganizationMemberAudit(getDb(), organization, {
    limit: event.queryStringParameters?.limit,
    cursor: event.queryStringParameters?.cursor
  });
  return jsonResponse(event, 200, page);
}

async function handleOrganizationMembers(event) {
  const decoded = await authenticateUser(event);
  const method = getMethod(event);
  let body = {};
  if (method !== "GET") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organizationId = method === "GET"
    ? event.queryStringParameters?.organizationId
    : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "members:manage");
  const actor = { uid: decoded.uid, email: decoded.email || "", role: organization.role };
  if (method === "GET") {
    const limit = event.queryStringParameters?.limit;
    const cursor = event.queryStringParameters?.cursor;
    const page = await listOrganizationMembers(getDb(), organization, { limit, cursor });
    return jsonResponse(event, 200, page);
  }
  if (method === "POST") {
    const member = await addOrganizationMember(getDb(), getFirebaseAdmin().auth(), organization, actor, body);
    return jsonResponse(event, 201, { member });
  }
  if (method === "PUT") {
    const member = await updateOrganizationMemberRole(organization, actor, body);
    return jsonResponse(event, 200, { member });
  }
  if (method === "DELETE") {
    const member = await removeOrganizationMember(organization, actor, body);
    return jsonResponse(event, 200, { member });
  }
  return jsonResponse(event, 405, { error: "Method not allowed." });
}

async function handleTenantResource(event, resource) {
  const decoded = await authenticateUser(event);
  const method = getMethod(event);
  let body = {};
  if (method !== "GET") {
    try { body = parseBody(event); } catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organizationId = method === "GET"
    ? event.queryStringParameters?.organizationId
    : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, resource === "contacts" ? "contacts:manage" : "quickReplies:manage");
  if (method === "GET") {
    const items = await listTenantResource(getDb(), organization.id, resource);
    return jsonResponse(event, 200, { items });
  }
  if (method === "POST") {
    const item = await saveTenantResource(getDb(), organization.id, resource, body.data);
    return jsonResponse(event, 201, { item });
  }
  if (method === "PUT") {
    const item = await saveTenantResource(getDb(), organization.id, resource, body.data, body.resourceId);
    return jsonResponse(event, 200, { item });
  }
  if (method === "DELETE") {
    if (resource === "quickReplies") await deleteQuickReplyImage(organization.id, body.resourceId);
    await deleteTenantResource(getDb(), organization.id, resource, body.resourceId);
    return jsonResponse(event, 200, { success: true });
  }
  return jsonResponse(event, 405, { error: "Method not allowed." });
}


async function removeTenantQuickReplyImage(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); } catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "quickReplies:manage");
  const quickReplyId = body.quickReplyId;
  if (typeof quickReplyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(quickReplyId)) {
    return jsonResponse(event, 400, { error: "A valid Quick Reply ID is required." });
  }
  const ref = organization.ref.collection("quickReplies").doc(quickReplyId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return jsonResponse(event, 404, { error: "Quick Reply was not found." });
  await deleteQuickReplyImage(organization.id, quickReplyId);
  await ref.set({ hasImage: false, imageMimeType: null, updatedAt: new Date() }, { merge: true });
  return jsonResponse(event, 200, { success: true, hasImage: false });
}

async function getTenantQuickReplyImage(event) {
  const decoded = await authenticateUser(event);
  const organizationId = event.queryStringParameters?.organizationId;
  const quickReplyId = event.queryStringParameters?.quickReplyId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "quickReplies:manage");
  if (typeof quickReplyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(quickReplyId)) {
    return jsonResponse(event, 400, { error: "A valid Quick Reply ID is required." });
  }
  const ref = organization.ref.collection("quickReplies").doc(quickReplyId);
  const snapshot = await ref.get();
  if (!snapshot.exists || !snapshot.data()?.hasImage) return jsonResponse(event, 404, { error: "Saved Quick Reply image was not found." });
  const saved = await getQuickReplyImage(organization.id, quickReplyId);
  if (!saved) return jsonResponse(event, 404, { error: "Saved Quick Reply image was not found." });
  return jsonResponse(event, 200, { mimeType: saved.mimeType, fileBase64: saved.buffer.toString("base64") });
}

async function saveTenantQuickReplyImage(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); } catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse(event, 400, { error: "Image upload details are required." });
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "quickReplies:manage");
  if (typeof body.quickReplyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.quickReplyId)) {
    return jsonResponse(event, 400, { error: "A valid Quick Reply ID is required." });
  }
  const ref = organization.ref.collection("quickReplies").doc(body.quickReplyId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return jsonResponse(event, 404, { error: "Quick Reply was not found." });
  const encoded = String(body.fileBase64 || "");
  const maxEncodedLength = Math.ceil(QUICK_REPLY_IMAGE_MAX_BYTES / 3) * 4;
  if (!encoded || encoded.length > maxEncodedLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return jsonResponse(event, 400, { error: "Image payload is invalid or exceeds 3 MB." });
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.toString("base64") !== encoded) return jsonResponse(event, 400, { error: "Image payload is not valid base64." });
  const saved = await saveQuickReplyImage(organization.id, body.quickReplyId, buffer, body.mimeType);
  await ref.set({ hasImage: true, imageMimeType: saved.mimeType, updatedAt: new Date() }, { merge: true });
  return jsonResponse(event, 200, { success: true, hasImage: true, imageMimeType: saved.mimeType });
}

async function handleTenantChatAction(event, action) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); } catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse(event, 400, { error: "A valid request object is required." });
  const { organizationId, ...actionInput } = body;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "chats:manage");
  const actor = { uid: decoded.uid, email: decoded.email || "", role: organization.role };
  if (action === "chat-assignment") {
    const result = await updateTenantChatAssignment(getDb(), organization, actor, actionInput);
    return jsonResponse(event, 200, { success: true, ...result });
  }
  if (action === "chat-state") {
    await updateTenantChatState(getDb(), organization.id, actionInput);
    return jsonResponse(event, 200, { success: true });
  }
  if (action === "message-state") {
    await updateTenantMessageState(getDb(), organization.id, actionInput);
    return jsonResponse(event, 200, { success: true });
  }
  if (action === "delete-messages") {
    const deletedMessageIds = await deleteTenantMessages(getDb(), organization.id, actionInput);
    return jsonResponse(event, 200, { success: true, deletedMessageIds });
  }
  const deletedChatIds = await deleteTenantChats(getDb(), organization.id, actionInput);
  return jsonResponse(event, 200, { success: true, deletedChatIds });
}

async function getTenantGreetingSettings(event) {
  const decoded = await authenticateUser(event);
  const organizationId = event.queryStringParameters?.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "settings:manage");
  const snapshot = await organization.ref.collection("settings").doc("greeting").get();
  const data = snapshot.exists ? snapshot.data() : {};
  return jsonResponse(event, 200, {
    enabled: Boolean(data.enabled),
    text: String(data.text || ""),
    trigger: "first_inbound"
  });
}

async function saveTenantGreetingSettings(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); } catch {
    return jsonResponse(event, 400, { error: "A valid JSON request body is required." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.organizationId !== "string" ||
      typeof body.enabled !== "boolean" || typeof body.text !== "string") {
    return jsonResponse(event, 400, { error: "Organization ID, greeting enabled state and text are required." });
  }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "settings:manage");
  const text = body.text.trim();
  if (text.length > 1024 || (body.enabled && !text)) {
    return jsonResponse(event, 400, { error: "Enabled greetings require text of at most 1024 characters." });
  }
  await organization.ref.collection("settings").doc("greeting").set({
    enabled: body.enabled,
    text,
    trigger: "first_inbound",
    updatedAt: new Date()
  }, { merge: true });
  return jsonResponse(event, 200, { success: true, enabled: body.enabled, text, trigger: "first_inbound" });
}

async function getTenantConnectionStatus(event) {
  const decoded = await authenticateUser(event);
  const organizationId = event.queryStringParameters?.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "chats:read");
  let whatsapp = { connected: false, error: { code: "NOT_CONNECTED", message: "WhatsApp is not connected." } };
  try {
    const credentials = await getWhatsAppCredentials(getDb(), organization.id);
    whatsapp = await checkWhatsAppConnection(credentials);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  let firestore;
  try {
    await organization.ref.collection("chats").limit(1).get();
    firestore = { connected: true };
  } catch (error) {
    firestore = { connected: false, error: String(error.message || "Firestore access check failed.").slice(0, 200) };
  }
  return jsonResponse(event, 200, { whatsapp, firestore, checkedAt: new Date().toISOString() });
}

async function authenticateOwner(event) {
  const authorization = getHeader(event, "authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    const error = new Error("Authentication required.");
    error.statusCode = 401;
    throw error;
  }

  const idToken = authorization.slice(7).trim();

  if (!idToken) {
    const error = new Error("Firebase ID token is missing.");
    error.statusCode = 401;
    throw error;
  }

  const admin = getFirebaseAdmin();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (error) {
    const authenticationError = new Error("Firebase ID token is invalid or expired.");
    authenticationError.statusCode = 401;
    throw authenticationError;
  }

  if (decoded.uid !== OWNER_UID) {
    const error = new Error("You are not authorized.");
    error.statusCode = 403;
    throw error;
  }

  return decoded;
}

async function registerFcmToken(event) {
  const owner = await authenticateOwner(event);
  let body;
  try {
    body = parseBody(event);
  } catch {
    return jsonResponse(event, 400, { error: "A valid JSON request body is required." });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !isValidFcmToken(body.token) ||
    !isValidInstallationId(body.installationId)
  ) {
    return jsonResponse(event, 400, {
      error: "A valid FCM token and installation ID are required."
    });
  }

  const deviceRef = getDeviceDocument(getDb(), owner.uid, body.installationId);
  await deviceRef.set({
    token: body.token,
    updatedAt: new Date()
  });

  return jsonResponse(event, 200, { success: true });
}

async function removeFcmToken(event) {
  const owner = await authenticateOwner(event);
  let body;
  try {
    body = parseBody(event);
  } catch {
    return jsonResponse(event, 400, { error: "A valid JSON request body is required." });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !isValidInstallationId(body.installationId)
  ) {
    return jsonResponse(event, 400, {
      error: "A valid installation ID is required."
    });
  }

  await getDeviceDocument(getDb(), owner.uid, body.installationId).delete();
  return jsonResponse(event, 200, { success: true });
}

async function registerTenantFcmToken(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); }
  catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !isValidFcmToken(body.token) || !isValidInstallationId(body.installationId)) {
    return jsonResponse(event, 400, { error: "A valid FCM token and installation ID are required." });
  }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "chats:read");
  await getTenantDeviceDocument(getDb(), organization.id, decoded.uid, body.installationId).set({
    token: body.token,
    updatedAt: new Date()
  }, { merge: true });
  return jsonResponse(event, 200, { success: true });
}

async function removeTenantFcmToken(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); }
  catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !isValidInstallationId(body.installationId)) {
    return jsonResponse(event, 400, { error: "A valid installation ID is required." });
  }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "chats:read");
  await getTenantDeviceDocument(getDb(), organization.id, decoded.uid, body.installationId).delete();
  return jsonResponse(event, 200, { success: true });
}

async function sendTenantMessage(event) {
  const body = parseBody(event);
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");

  const to = normalizePhoneNumber(body.to);
  const chatId = normalizePhoneNumber(body.chatId || to);
  const messageText = String(body.text || "").trim();
  if (!to || !chatId || to !== chatId || !messageText) {
    return jsonResponse(event, 400, { error: "Valid matching to, chatId and text are required." });
  }
  if (messageText.length > 4096) {
    return jsonResponse(event, 400, { error: "Message is too long." });
  }

  const db = getDb();
  const credentials = await getWhatsAppCredentials(db, organization.id, body.phoneNumberId);
  const replyContext = await resolveTenantReplyContext(db, organization.id, chatId, body);
  const clientMessageId = getClientMessageId(body.clientMessageId);
  const source = body.source === "quick_reply" ? "quick_reply" : "manual";
  const payloadHash = hashSendPayload({
    organizationId: organization.id,
    phoneNumberId: credentials.phoneNumberId || null,
    to,
    text: messageText,
    source,
    contextMessageId: replyContext?.contextMessageId || null
  });
  const claim = await claimTenantSendRequest(db, organization.id, chatId, clientMessageId, payloadHash);
  if (claim.state === "completed") {
    return jsonResponse(event, 200, { success: true, messageId: claim.messageId, clientMessageId });
  }
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") {
    return jsonResponse(event, 202, { success: true, pending: true, clientMessageId });
  }

  let result;
  try {
    result = await sendWhatsAppText(to, messageText, replyContext?.contextMessageId, credentials);
  } catch (error) {
    await markTenantSendRequestFailed(claim.ref, error);
    throw error;
  }

  const chatRef = getTenantChatRef(db, organization.id, chatId);
  const messageRef = getTenantMessageRef(db, organization.id, chatId, result.messageId);
  const timestamp = new Date();
  const batch = db.batch();
  batch.set(messageRef, {
    messageId: result.messageId,
    clientMessageId,
    chatId,
    organizationId: organization.id,
    direction: "outgoing",
    phoneNumberId: credentials.phoneNumberId || null,
    type: "text",
    text: messageText,
    timestamp,
    status: "sending",
    source,
    ...getTenantReplyMessageFields(replyContext),
    sender: decoded.uid
  });
  batch.set(chatRef, {
    customerPhone: chatId,
    ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}),
    lastMessage: messageText,
    lastMessageAt: timestamp,
    lastMessageDirection: "outgoing",
    updatedAt: timestamp
  }, { merge: true });
  batch.set(claim.ref, {
    status: "completed",
    messageId: result.messageId,
    updatedAt: timestamp
  }, { merge: true });
  await batch.commit();

  return jsonResponse(event, 200, { success: true, messageId: result.messageId, clientMessageId });
}

async function sendTenantTemplate(event) {
  const body = parseBody(event);
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");
  const to = normalizePhoneNumber(body.to);
  if (typeof body.to !== "string" || !/^\+?\d{6,20}$/.test(body.to) || !to) {
    return jsonResponse(event, 400, { error: "A valid customer phone number is required." });
  }
  const templateName = String(body.templateName || "").trim();
  const language = String(body.language || "").trim();
  const variables = body.variables === undefined ? [] : body.variables;
  const headerVariables = body.headerVariables === undefined ? [] : body.headerVariables;
  const buttonVariables = body.buttonVariables === undefined ? [] : body.buttonVariables;
  const headerMedia = body.headerMedia && typeof body.headerMedia === "object" ? body.headerMedia : null;
  const validVariables = values => Array.isArray(values) && values.length <= 100 && values.every(value => typeof value === "string" && value.trim() && value.length <= 1024);
  if (!/^[a-z0-9_]{1,512}$/.test(templateName) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language) ||
      !validVariables(variables) || !validVariables(headerVariables) || !validVariables(buttonVariables) || (headerMedia && (!isValidBase64(headerMedia.base64) || typeof headerMedia.mimeType !== "string" || typeof headerMedia.filename !== "string"))) {
    return jsonResponse(event, 400, { error: "Template name, language or template variables are invalid." });
  }
  const db = getDb();
  const wabaId = String(body.wabaId || "").trim();
  if (!/^\d{5,32}$/.test(wabaId)) return jsonResponse(event, 400, { error: "A valid WhatsApp Business Account ID is required." });
  const credentials = await getWhatsAppCredentials(db, organization.id, body.phoneNumberId);
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const templateUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/message_templates`);
  templateUrl.searchParams.set("fields", "name,status,language,components");
  templateUrl.searchParams.set("name", templateName);
  templateUrl.searchParams.set("limit", "100");
  const templateResponse = await fetch(templateUrl.toString(), { headers: { Authorization: `Bearer ${credentials.accessToken}` } });
  const templatePayload = await templateResponse.json().catch(() => ({}));
  if (!templateResponse.ok) return jsonResponse(event, 502, { error: templatePayload.error?.message || "Meta could not verify this template. Check WABA ID and token permissions." });
  const approvedTemplate = (Array.isArray(templatePayload.data) ? templatePayload.data : []).find(item => item.name === templateName && item.language === language && item.status === "APPROVED");
  if (!approvedTemplate) return jsonResponse(event, 400, { error: "This template is not approved for the selected language." });
  const templateComponents = Array.isArray(approvedTemplate.components) ? approvedTemplate.components : [];
  const placeholderCount = value => {
    const indexes = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
    return indexes.length ? Math.max(...indexes) : 0;
  };
  const bodyCount = placeholderCount(templateComponents.find(item => item.type === "BODY")?.text);
  const headerDefinition = templateComponents.find(item => item.type === "HEADER");
  const headerComponent = headerDefinition?.format === "TEXT" ? headerDefinition : null;
  const mediaHeaderFormat = ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerDefinition?.format) ? headerDefinition.format : null;
  const headerCount = placeholderCount(headerComponent?.text);
  const urlButtons = templateComponents.flatMap(item => item.type === "BUTTONS" && Array.isArray(item.buttons) ? item.buttons.map((button, index) => ({ ...button, index })) : []).filter(button => button.type === "URL" && String(button.url || "").includes("{{"));
  if (variables.length !== bodyCount || headerVariables.length !== headerCount || buttonVariables.length !== urlButtons.length || (Boolean(mediaHeaderFormat) !== Boolean(headerMedia))) {
    return jsonResponse(event, 400, { error: `This template needs ${bodyCount} body, ${headerCount} header and ${urlButtons.length} URL button variable(s).` });
  }
  const headerMediaMimeType = headerMedia ? String(headerMedia.mimeType).split(";")[0].trim().toLowerCase() : "";
  if (headerMedia && !isAllowedTemplateMedia(headerMediaMimeType, mediaHeaderFormat)) {
    return jsonResponse(event, 400, { error: `This template requires a ${mediaHeaderFormat.toLowerCase()} header file.` });
  }
  const clientMessageId = getClientMessageId(body.clientMessageId);
  const payloadHash = hashSendPayload({ organizationId: organization.id, phoneNumberId: credentials.phoneNumberId || null, to, templateName, language, variables, headerVariables, buttonVariables, headerMedia: headerMedia ? { mimeType: headerMedia.mimeType, filename: headerMedia.filename, base64: headerMedia.base64 } : null });
  const claim = await claimTenantSendRequest(db, organization.id, to, clientMessageId, payloadHash);
  if (claim.state === "completed") return jsonResponse(event, 200, { success: true, messageId: claim.messageId, clientMessageId });
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") return jsonResponse(event, 202, { success: true, pending: true, clientMessageId });
  const template = { name: templateName, language: { code: language } };
  const components = [];
  let uploadedHeaderMediaId = "";
  if (headerMedia) {
    const mimeType = headerMediaMimeType;
    const buffer = Buffer.from(headerMedia.base64, "base64");
    let uploaded;
    try { uploaded = await uploadWhatsAppMedia(buffer, mimeType, headerMedia.filename, credentials); }
    catch (error) { await markTenantSendRequestFailed(claim.ref, error); throw error; }
    uploadedHeaderMediaId = uploaded.mediaId;
    const mediaType = mediaHeaderFormat.toLowerCase();
    components.push({ type: "header", parameters: [{ type: mediaType, [mediaType]: { id: uploaded.mediaId } }] });
  }
  if (headerVariables.length) components.push({ type: "header", parameters: headerVariables.map(text => ({ type: "text", text: text.trim() })) });
  if (variables.length) components.push({ type: "body", parameters: variables.map(text => ({ type: "text", text: text.trim() })) });
  buttonVariables.forEach((value, index) => {
    const button = urlButtons[index];
    components.push({ type: "button", sub_type: "url", index: String(button.index), parameters: [{ type: "text", text: value.trim() }] });
  });
  if (components.length) template.components = components;
  let result;
  try {
    const version = process.env.GRAPH_API_VERSION || "v26.0";
    const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(credentials.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.messages?.[0]?.id) {
      const error = new Error(payload.error?.message || "Meta did not confirm template message delivery.");
      error.statusCode = 502;
      // Explicit 4xx rejects are definitive, except 408. Server errors,
      // timeouts, and successful responses without a message ID are ambiguous.
      error.definitive = !response.ok && isDefinitiveWhatsAppSendRejection(response.status);
      error.retryable = false;
      throw error;
    }
    result = { messageId: payload.messages[0].id };
  } catch (error) {
    await markTenantSendRequestFailed(claim.ref, error);
    throw error;
  }
  const chatRef = getTenantChatRef(db, organization.id, to);
  const messageRef = getTenantMessageRef(db, organization.id, to, result.messageId);
  const timestamp = new Date();
  const preview = `Template: ${templateName}`;
  const batch = db.batch();
  batch.set(messageRef, {
    messageId: result.messageId, clientMessageId, chatId: to, organizationId: organization.id,
    direction: "outgoing", phoneNumberId: credentials.phoneNumberId || null,
    type: "template", text: preview, templateName, templateLanguage: language,
    templateVariables: { header: headerVariables, body: variables, buttons: buttonVariables, headerMedia: headerMedia ? { mediaId: uploadedHeaderMediaId, format: mediaHeaderFormat.toLowerCase(), mimeType: headerMedia.mimeType, filename: headerMedia.filename } : null }, wabaId, timestamp, status: "sending", source: "template", sender: decoded.uid
  });
  batch.set(chatRef, {
    customerPhone: to, ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}),
    lastMessage: preview, lastMessageAt: timestamp, lastMessageDirection: "outgoing", updatedAt: timestamp
  }, { merge: true });
  batch.set(claim.ref, { status: "completed", messageId: result.messageId, updatedAt: timestamp }, { merge: true });
  await batch.commit();
  return jsonResponse(event, 200, { success: true, messageId: result.messageId, clientMessageId });
}

async function retryTenantFailedTemplate(event) {
  const body = parseBody(event);
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");
  const chatId = normalizePhoneNumber(body.chatId);
  const originalMessageId = String(body.originalMessageId || "").trim();
  if (!chatId || !/^[A-Za-z0-9._:-]{1,256}$/.test(originalMessageId)) return jsonResponse(event, 400, { error: "A valid chat and original template message ID are required." });
  const db = getDb();
  const chatRef = getTenantChatRef(db, organization.id, chatId);
  const originalRef = getTenantMessageRef(db, organization.id, chatId, originalMessageId);
  const originalSnapshot = await originalRef.get();
  if (!originalSnapshot.exists) return jsonResponse(event, 404, { error: "Original template message was not found." });
  const original = originalSnapshot.data();
  if (original.type !== "template" || original.direction !== "outgoing" || original.status !== "failed" || !original.templateName || !original.templateLanguage) {
    return jsonResponse(event, 400, { error: "Only failed outgoing template messages can be retried." });
  }
  const phoneNumberId = String(original.phoneNumberId || "");
  const credentials = await getWhatsAppCredentials(db, organization.id, phoneNumberId);
  const templateName = String(original.templateName);
  const language = String(original.templateLanguage);
  const saved = original.templateVariables || {};
  const headerVariables = Array.isArray(saved.header) ? saved.header : [];
  const variables = Array.isArray(saved.body) ? saved.body : [];
  const buttonVariables = Array.isArray(saved.buttons) ? saved.buttons : [];
  const mediaId = String(saved.headerMedia?.mediaId || "");
  const mediaFormat = String(saved.headerMedia?.format || "").toLowerCase();
  const wabaId = String(original.wabaId || "");
  if (!/^\d{5,32}$/.test(wabaId)) return jsonResponse(event, 400, { error: "The original WABA ID is missing. Please send this template again manually." });
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/message_templates`);
  url.searchParams.set("fields", "name,status,language,components");
  url.searchParams.set("name", templateName);
  const check = await fetch(url.toString(), { headers: { Authorization: `Bearer ${credentials.accessToken}` } });
  const checkPayload = await check.json().catch(() => ({}));
  if (!check.ok) return jsonResponse(event, 502, { error: checkPayload.error?.message || "Meta could not verify the original template." });
  const approved = (Array.isArray(checkPayload.data) ? checkPayload.data : []).find(item => item.name === templateName && item.language === language && item.status === "APPROVED");
  if (!approved) return jsonResponse(event, 400, { error: "This template is no longer approved." });
  const templateComponents = Array.isArray(approved.components) ? approved.components : [];
  const count = value => { const matches = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1])); return matches.length ? Math.max(...matches) : 0; };
  const bodyCount = count(templateComponents.find(item => item.type === "BODY")?.text);
  const header = templateComponents.find(item => item.type === "HEADER");
  const headerCount = header?.format === "TEXT" ? count(header.text) : 0;
  const urlButtons = templateComponents.flatMap(item => item.type === "BUTTONS" && Array.isArray(item.buttons) ? item.buttons.map((button,index)=>({...button,index})) : []).filter(button=>button.type==="URL" && String(button.url||"").includes("{{"));
  if (variables.length !== bodyCount || headerVariables.length !== headerCount || buttonVariables.length !== urlButtons.length || (["IMAGE","VIDEO","DOCUMENT"].includes(header?.format) && (!mediaId || !mediaFormat))) {
    return jsonResponse(event, 400, { error: "The original template parameters are incomplete. Please send the template again manually." });
  }
  const clientMessageId = getClientMessageId(body.clientMessageId);
  const payloadHash = hashSendPayload({ organizationId: organization.id, phoneNumberId, to: chatId, retryOf: originalMessageId, templateName, language, headerVariables, variables, buttonVariables, mediaId });
  const claim = await claimTenantSendRequest(db, organization.id, chatId, clientMessageId, payloadHash);
  if (claim.state === "completed") return jsonResponse(event, 200, { success: true, messageId: claim.messageId, clientMessageId });
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") return jsonResponse(event, 202, { success: true, pending: true, clientMessageId });
  const components = [];
  if (mediaId) components.push({ type: "header", parameters: [{ type: mediaFormat, [mediaFormat]: { id: mediaId } }] });
  if (headerVariables.length) components.push({ type: "header", parameters: headerVariables.map(text => ({ type: "text", text })) });
  if (variables.length) components.push({ type: "body", parameters: variables.map(text => ({ type: "text", text })) });
  buttonVariables.forEach((value,index)=>components.push({ type:"button",sub_type:"url",index:String(urlButtons[index].index),parameters:[{type:"text",text:value}]}));
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method:"POST", headers:{Authorization:`Bearer ${credentials.accessToken}`,"Content-Type":"application/json"},
      body:JSON.stringify({messaging_product:"whatsapp",recipient_type:"individual",to:chatId,type:"template",template:{name:templateName,language:{code:language},...(components.length?{components}:{})}})
    });
    const payload = await response.json().catch(()=>({}));
    if (!response.ok || !payload.messages?.[0]?.id) { const error=new Error(payload.error?.message||"Meta did not confirm template retry delivery."); error.statusCode=502; error.definitive=!response.ok && isDefinitiveWhatsAppSendRejection(response.status); error.retryable=false; throw error; }
    const newMessageId=payload.messages[0].id; const timestamp=new Date();
    const newRef=getTenantMessageRef(db,organization.id,chatId,newMessageId);
    const preview=`Template: ${templateName}`;
    const batch=db.batch();
    batch.set(newRef,{messageId:newMessageId,clientMessageId,chatId,organizationId:organization.id,direction:"outgoing",phoneNumberId,type:"template",text:preview,templateName,templateLanguage:language,templateVariables:saved,timestamp,status:"sending",source:"template-retry",retryOf:originalMessageId,sender:decoded.uid});
    batch.set(chatRef,{customerPhone:chatId,phoneNumberId,lastMessage:preview,lastMessageAt:timestamp,lastMessageDirection:"outgoing",updatedAt:timestamp},{merge:true});
    batch.set(claim.ref,{status:"completed",messageId:newMessageId,updatedAt:timestamp},{merge:true});
    await batch.commit();
    return jsonResponse(event,200,{success:true,messageId:newMessageId,clientMessageId});
  } catch(error) { await markTenantSendRequestFailed(claim.ref,error); throw error; }
}

async function retryTenantFailedText(event) {
  const body = parseBody(event);
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");

  const chatId = normalizePhoneNumber(body.chatId);
  const originalMessageId = String(body.originalMessageId || "").trim();
  if (!chatId || !originalMessageId || originalMessageId.length > 256) {
    return jsonResponse(event, 400, { error: "A valid chat and original message ID are required." });
  }

  const db = getDb();
  const chatRef = getTenantChatRef(db, organization.id, chatId);
  const chatSnapshot = await chatRef.get();
  if (!chatSnapshot.exists) return jsonResponse(event, 404, { error: "Conversation was not found." });

  const originalRef = getTenantMessageRef(db, organization.id, chatId, originalMessageId);
  const originalSnapshot = await originalRef.get();
  if (!originalSnapshot.exists) return jsonResponse(event, 404, { error: "Original message was not found." });
  const original = originalSnapshot.data();
  const retryable = getRetryableTenantTextMessage(original);

  const credentials = await getWhatsAppCredentials(db, organization.id, retryable.phoneNumberId);
  const clientMessageId = getClientMessageId(body.clientMessageId);
  const messageText = retryable.text;
  const payloadHash = hashSendPayload({
    organizationId: organization.id,
    phoneNumberId: credentials.phoneNumberId || null,
    to: chatId,
    text: messageText,
    retryOf: originalMessageId
  });
  const claim = await claimTenantSendRequest(db, organization.id, chatId, clientMessageId, payloadHash);
  if (claim.state === "completed") {
    return jsonResponse(event, 200, { success: true, messageId: claim.messageId, clientMessageId });
  }
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") {
    return jsonResponse(event, 202, { success: true, pending: true, clientMessageId });
  }

  let result;
  try {
    result = await sendWhatsAppText(chatId, messageText, undefined, credentials);
  } catch (error) {
    await markTenantSendRequestFailed(claim.ref, error);
    throw error;
  }

  const timestamp = new Date();
  const messageRef = getTenantMessageRef(db, organization.id, chatId, result.messageId);
  const batch = db.batch();
  batch.set(messageRef, {
    messageId: result.messageId,
    clientMessageId,
    chatId,
    organizationId: organization.id,
    direction: "outgoing",
    phoneNumberId: credentials.phoneNumberId || null,
    type: "text",
    text: messageText,
    timestamp,
    status: "sending",
    source: "retry",
    retryOf: originalMessageId,
    sender: decoded.uid
  });
  batch.set(chatRef, {
    customerPhone: chatId,
    ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}),
    lastMessage: messageText,
    lastMessageAt: timestamp,
    lastMessageDirection: "outgoing",
    updatedAt: timestamp
  }, { merge: true });
  batch.set(claim.ref, { status: "completed", messageId: result.messageId, updatedAt: timestamp }, { merge: true });
  await batch.commit();
  return jsonResponse(event, 200, { success: true, messageId: result.messageId, clientMessageId });
}

async function sendTenantMediaMessage(event) {
  const body = parseBody(event);
  const decoded = await authenticateUser(event);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(event, 400, { error: "A media message object is required." });
  }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");
  const to = normalizePhoneNumber(body.to);
  const chatId = normalizePhoneNumber(body.chatId || body.to);
  if (typeof body.to !== "string" || typeof body.chatId !== "string" ||
      !/^\+?\d{6,20}$/.test(body.to) || !/^\+?\d{6,20}$/.test(body.chatId) ||
      !to || to !== chatId) {
    return jsonResponse(event, 400, { error: "Valid matching to and chatId values are required." });
  }
  const encoded = String(body.fileBase64 || "");
  const maxEncodedLength = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
  if (!encoded || encoded.length > maxEncodedLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return jsonResponse(event, 400, { error: "Media payload is invalid or exceeds 3 MB." });
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.toString("base64") !== encoded) return jsonResponse(event, 400, { error: "Media payload is not valid base64." });
  let mimeType;
  try {
    mimeType = validateMedia(body.mimeType, buffer.length, MAX_UPLOAD_BYTES);
    validateMediaContent(mimeType, buffer);
  } catch (error) { return jsonResponse(event, 400, { error: error.message }); }
  const type = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("video/") ? "video" :
    mimeType.startsWith("audio/") ? "audio" : "document";
  if (body.type !== type) return jsonResponse(event, 400, { error: "File type does not match the selected attachment type." });
  const caption = String(body.caption || "").trim();
  const filename = String(body.filename || "attachment").replace(/[\\/\r\n]/g, "_").slice(0, 180);
  if (caption.length > 1024 || (type === "audio" && caption)) {
    return jsonResponse(event, 400, { error: "Caption is invalid for this media type." });
  }
  const db = getDb();
  const credentials = await getWhatsAppCredentials(db, organization.id, body.phoneNumberId);
  const replyContext = await resolveTenantReplyContext(db, organization.id, chatId, body);
  const clientMessageId = getClientMessageId(body.clientMessageId);
  const source = body.source === "quick_reply" ? "quick_reply" : "manual";
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const payloadHash = hashSendPayload({ organizationId: organization.id, phoneNumberId: credentials.phoneNumberId || null, to, type, caption, filename, mimeType, source, contentHash, contextMessageId: replyContext?.contextMessageId || null });
  const claim = await claimTenantSendRequest(db, organization.id, chatId, clientMessageId, payloadHash);
  if (claim.state === "completed") return jsonResponse(event, 200, { success: true, messageId: claim.messageId, clientMessageId });
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") return jsonResponse(event, 202, { success: true, pending: true, clientMessageId });
  let uploaded, result, sendStarted = false;
  try {
    uploaded = await uploadWhatsAppMedia(buffer, mimeType, filename, credentials);
    sendStarted = true;
    result = await sendWhatsAppMedia(to, type, uploaded.mediaId, caption, filename, replyContext?.contextMessageId, credentials);
  } catch (error) {
    if (!sendStarted) { error.definitive = true; error.retryable = false; }
    await markTenantSendRequestFailed(claim.ref, error);
    throw error;
  }
  const chatRef = getTenantChatRef(db, organization.id, chatId);
  const messageRef = getTenantMessageRef(db, organization.id, chatId, result.messageId);
  const timestamp = new Date();
  const preview = caption || (type[0].toUpperCase() + type.slice(1));
  const batch = db.batch();
  batch.set(messageRef, {
    messageId: result.messageId, clientMessageId, chatId, organizationId: organization.id,
    direction: "outgoing", phoneNumberId: credentials.phoneNumberId || null, type, text: caption, timestamp, status: "sending", source, sender: decoded.uid,
    ...getTenantReplyMessageFields(replyContext),
    mediaId: uploaded.mediaId, mediaMimeType: mimeType, mediaSize: buffer.length, mediaFilename: filename,
    mediaStorage: "meta"
  });
  batch.set(chatRef, { customerPhone: chatId, ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}), lastMessage: preview, lastMessageAt: timestamp, lastMessageDirection: "outgoing", updatedAt: timestamp }, { merge: true });
  batch.set(claim.ref, { status: "completed", messageId: result.messageId, updatedAt: timestamp }, { merge: true });
  await batch.commit();
  return jsonResponse(event, 200, { success: true, messageId: result.messageId, clientMessageId });
}


async function sendTenantQuickReplyImage(event) {
  const body = parseBody(event);
  const decoded = await authenticateUser(event);
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse(event, 400, { error: "Quick Reply send details are required." });
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");
  if (typeof body.quickReplyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.quickReplyId)) return jsonResponse(event, 400, { error: "A valid Quick Reply ID is required." });
  const chatId = normalizePhoneNumber(body.chatId);
  if (typeof body.chatId !== "string" || !/^\+?\d{6,20}$/.test(body.chatId) || !chatId) return jsonResponse(event, 400, { error: "A valid chat ID is required." });
  const replyRef = organization.ref.collection("quickReplies").doc(body.quickReplyId);
  const replySnapshot = await replyRef.get();
  if (!replySnapshot.exists || !replySnapshot.data()?.hasImage) return jsonResponse(event, 404, { error: "This Quick Reply has no saved image." });
  const saved = await getQuickReplyImage(organization.id, body.quickReplyId);
  if (!saved) return jsonResponse(event, 404, { error: "Saved Quick Reply image was not found." });
  const encoded = saved.buffer.toString("base64");
  const forwarded = {
    ...event,
    body: JSON.stringify({
      organizationId: organization.id,
      to: chatId,
      chatId,
      fileBase64: encoded,
      mimeType: saved.mimeType,
      type: "image",
      caption: String(replySnapshot.data().message || "").slice(0, 1024),
      filename: "quick-reply-image",
      source: "quick_reply",
      clientMessageId: body.clientMessageId,
      phoneNumberId: body.phoneNumberId
    }),
    isBase64Encoded: false
  };
  return sendTenantMediaMessage(forwarded);
}

async function sendMessage(event) {
  await authenticateOwner(event);

  const body = parseBody(event);

  const to = normalizePhoneNumber(body.to);
  const messageText = String(body.text || "").trim();
  const chatId = normalizePhoneNumber(body.chatId || to);

  if (!to || !messageText || !chatId || to !== chatId) {
    return jsonResponse(event, 400, {
      error: "Valid to, chatId and text are required."
    });
  }

  if (messageText.length > 4096) {
    return jsonResponse(event, 400, {
      error: "Message is too long."
    });
  }
  const clientMessageId = getClientMessageId(body.clientMessageId);
  const db = getDb();
  const replyLookupStartedAt = Date.now();
  const replyContext = await resolveReplyContext(db, chatId, body);
  if (body.replyToMessageId || body.contextMessageId) {
    logLatency("firestore_reply_lookup_ms", replyLookupStartedAt);
  }

  const chatRef = db.collection("chats").doc(chatId);
  const payloadHash = hashSendPayload({
    to,
    text: messageText,
    source: body.source === "quick_reply" ? "quick_reply" : "manual",
    contextMessageId: replyContext?.contextMessageId || null
  });
  const claimStartedAt = Date.now();
  const claim = await claimSendRequest(db, chatId, clientMessageId, payloadHash);
  logLatency("firestore_send_claim_ms", claimStartedAt);

  if (claim.state === "completed") {
    return jsonResponse(event, 200, {
      success: true,
      messageId: claim.messageId,
      clientMessageId
    });
  }
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") {
    return jsonResponse(event, 202, {
      success: true,
      pending: true,
      clientMessageId
    });
  }

  let result;
  try {
    result = await sendWhatsAppText(
      to,
      messageText,
      replyContext?.contextMessageId
    );
  } catch (error) {
    await markSendRequestFailed(claim.ref, error);
    throw error;
  }

  const messageRef = chatRef.collection("messages").doc(result.messageId);
  const timestamp = new Date();
  const batch = db.batch();
  batch.set(messageRef, {
    messageId: result.messageId,
    clientMessageId,
    chatId,
    direction: "outgoing",
    type: "text",
    text: messageText,
    timestamp,
    status: "sending",
    source: body.source === "quick_reply" ? "quick_reply" : "manual",
    ...getReplyMessageFields(replyContext),
    sender: "owner"
  });
  batch.set(chatRef, {
    customerPhone: chatId,
    lastMessage: messageText,
    lastMessageAt: timestamp,
    lastMessageDirection: "outgoing",
    updatedAt: timestamp
  }, { merge: true });
  batch.set(claim.ref, {
    status: "completed",
    messageId: result.messageId,
    updatedAt: timestamp
  }, { merge: true });

  const persistenceStartedAt = Date.now();
  await batch.commit();
  logLatency("firestore_send_persistence_ms", persistenceStartedAt);

  return jsonResponse(event, 200, {
    success: true,
    messageId: result.messageId,
    clientMessageId
  });
}

async function updateChatState(event) {
  await authenticateOwner(event);

  const body = parseBody(event);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(event, 400, {
      error: "A chat state object is required."
    });
  }

  const chatId = normalizePhoneNumber(body.chatId);
  const fields = ["pinned", "archived", "markRead"];

  if (
    typeof body.chatId !== "string" ||
    !/^\+?\d{6,20}$/.test(body.chatId) ||
    !chatId
  ) {
    return jsonResponse(event, 400, {
      error: "A valid chatId is required."
    });
  }

  const updates = {};

  for (const field of fields) {
    if (Object.hasOwn(body, field)) {
      if (typeof body[field] !== "boolean") {
        return jsonResponse(event, 400, {
          error: `${field} must be a boolean.`
        });
      }

      if (field === "markRead") {
        if (body.markRead) {
          updates.unreadCount = 0;
          updates.lastReadAt = new Date();
        }
      } else {
        updates[field] = body[field];
      }
    }
  }

  if (Object.keys(body).some((field) => !["chatId", ...fields].includes(field))) {
    return jsonResponse(event, 400, {
      error: "Unsupported chat state field."
    });
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse(event, 400, {
      error: "At least one chat state update is required."
    });
  }

  const chatRef = getDb().collection("chats").doc(chatId);
  const snapshot = await chatRef.get();

  if (!snapshot.exists) {
    return jsonResponse(event, 404, {
      error: "Conversation was not found."
    });
  }

  await chatRef.update({
    ...updates,
    updatedAt: new Date()
  });

  return jsonResponse(event, 200, { success: true });
}

async function updateMessageState(event) {
  await authenticateOwner(event);

  const body = parseBody(event);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 3 ||
    typeof body.chatId !== "string" ||
    !/^\d{6,20}$/.test(body.chatId) ||
    typeof body.messageId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(body.messageId) ||
    typeof body.pinned !== "boolean"
  ) {
    return jsonResponse(event, 400, {
      error: "Valid chatId, messageId, and pinned fields are required."
    });
  }

  const messageRef = getDb()
    .collection("chats")
    .doc(body.chatId)
    .collection("messages")
    .doc(body.messageId);
  const snapshot = await messageRef.get();
  if (!snapshot.exists) {
    return jsonResponse(event, 404, { error: "Message was not found." });
  }

  await messageRef.update({
    pinned: body.pinned,
    pinnedAt: body.pinned ? new Date() : null,
    updatedAt: new Date()
  });
  return jsonResponse(event, 200, { success: true });
}

async function deleteMessages(event) {
  await authenticateOwner(event);

  const body = parseBody(event);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    typeof body.chatId !== "string" ||
    !/^\d{6,20}$/.test(body.chatId) ||
    !Array.isArray(body.messageIds) ||
    body.messageIds.length < 1 ||
    body.messageIds.length > 50 ||
    body.messageIds.some(
      (messageId) =>
        typeof messageId !== "string" ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId)
    ) ||
    new Set(body.messageIds).size !== body.messageIds.length
  ) {
    return jsonResponse(event, 400, {
      error: "Provide a valid chat ID and 1 to 50 unique message IDs."
    });
  }

  const db = getDb();
  const chatRef = db.collection("chats").doc(body.chatId);
  const messageRefs = body.messageIds.map((messageId) =>
    chatRef.collection("messages").doc(messageId)
  );
  const mediaPaths = await db.runTransaction(async (transaction) => {
    const chatSnapshot = await transaction.get(chatRef);
    if (!chatSnapshot.exists) {
      const error = new Error("Conversation was not found.");
      error.statusCode = 404;
      throw error;
    }

    const snapshots = await Promise.all(messageRefs.map((messageRef) => transaction.get(messageRef)));
    if (snapshots.some((snapshot) => !snapshot.exists)) {
      const error = new Error("One or more selected messages were not found in this conversation.");
      error.statusCode = 404;
      throw error;
    }

    const paths = [];
    snapshots.forEach((snapshot, index) => {
      const storagePath = snapshot.data().mediaStoragePath;
      if (typeof storagePath === "string") paths.push(storagePath);
      transaction.delete(messageRefs[index]);
    });
    return paths;
  });

  for (const storagePath of mediaPaths) {
    try {
      await deleteMessageMedia(storagePath);
    } catch (cleanupError) {
      console.error("Deleted message media cleanup failed:", cleanupError);
    }
  }

  return jsonResponse(event, 200, {
    success: true,
    deletedMessageIds: body.messageIds
  });
}

async function deleteChats(event) {
  await authenticateOwner(event);

  const body = parseBody(event);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.chatIds) ||
    body.chatIds.length < 1 ||
    body.chatIds.length > 50 ||
    body.chatIds.some((chatId) => typeof chatId !== "string" || !/^\d{6,20}$/.test(chatId)) ||
    new Set(body.chatIds).size !== body.chatIds.length
  ) {
    return jsonResponse(event, 400, {
      error: "Provide 1 to 50 unique valid chat IDs."
    });
  }

  const db = getDb();
  const deletedChatIds = [];
  const errors = [];

  for (const chatId of body.chatIds) {
    try {
      const deletionRef = db.collection("deletedChats").doc(chatId);
      await deletionRef.set({
        deletedAt: new Date(),
        deletedBy: OWNER_UID,
        deleting: true
      });

      const chatRef = db.collection("chats").doc(chatId);
      await Promise.all([
        db.recursiveDelete(chatRef.collection("messages")),
        db.recursiveDelete(chatRef.collection("sendRequests"))
      ]);
      await chatRef.delete();
      await deletionRef.set({
        deletedAt: new Date(),
        deletedBy: OWNER_UID,
        deleting: false
      });
      deletedChatIds.push(chatId);
    } catch (error) {
      console.error(`Chat deletion failed for ${chatId}:`, error);
      errors.push({ chatId, error: "Conversation could not be deleted." });
    }
  }

  return jsonResponse(event, errors.length ? 207 : 200, {
    deletedChatIds,
    errors
  });
}

async function sendMediaMessage(event) {
  await authenticateOwner(event);
  const body = parseBody(event);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(event, 400, { error: "A media message object is required." });
  }

  const to = normalizePhoneNumber(body.to);
  const chatId = normalizePhoneNumber(body.chatId);
  if (
    typeof body.to !== "string" ||
    typeof body.chatId !== "string" ||
    !/^\+?\d{6,20}$/.test(body.to) ||
    !/^\+?\d{6,20}$/.test(body.chatId) ||
    !to ||
    to !== chatId
  ) {
    return jsonResponse(event, 400, { error: "Valid matching to and chatId values are required." });
  }

  const db = getDb();
  const replyLookupStartedAt = Date.now();
  const replyContext = await resolveReplyContext(db, chatId, body);
  if (body.replyToMessageId || body.contextMessageId) {
    logLatency("firestore_reply_lookup_ms", replyLookupStartedAt, { media: true });
  }
  const clientMessageId = getClientMessageId(body.clientMessageId);

  const encoded = String(body.fileBase64 || "");
  const maxEncodedLength = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
  if (
    !encoded ||
    encoded.length > maxEncodedLength ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    return jsonResponse(event, 400, { error: "Media payload is invalid or exceeds 3 MB." });
  }

  const buffer = Buffer.from(encoded, "base64");
  if (buffer.toString("base64") !== encoded) {
    return jsonResponse(event, 400, { error: "Media payload is not valid base64." });
  }

  let mimeType;
  try {
    mimeType = validateMedia(body.mimeType, buffer.length, MAX_UPLOAD_BYTES);
  } catch (error) {
    return jsonResponse(event, 400, { error: error.message });
  }

  const type = mimeType.startsWith("image/")
    ? "image"
    : mimeType.startsWith("video/")
      ? "video"
      : mimeType.startsWith("audio/")
        ? "audio"
        : "document";
  if (body.type !== type) {
    return jsonResponse(event, 400, { error: "File type does not match the selected attachment type." });
  }

  const caption = String(body.caption || "").trim();
  const filename = String(body.filename || "attachment")
    .replace(/[\\/\r\n]/g, "_")
    .slice(0, 180);
  if (caption.length > 1024) {
    return jsonResponse(event, 400, { error: "Caption is too long (maximum 1024 characters)." });
  }
  if (type === "audio" && caption) {
    return jsonResponse(event, 400, { error: "WhatsApp audio messages do not support captions." });
  }

  const payloadHash = hashSendPayload({
    to,
    type,
    caption,
    filename,
    mimeType,
    source: body.source === "quick_reply" ? "quick_reply" : "manual",
    contextMessageId: replyContext?.contextMessageId || null,
    contentHash: crypto.createHash("sha256").update(buffer).digest("hex")
  });
  const claimStartedAt = Date.now();
  const claim = await claimSendRequest(db, chatId, clientMessageId, payloadHash);
  logLatency("firestore_send_claim_ms", claimStartedAt, { media: true });

  if (claim.state === "completed") {
    return jsonResponse(event, 200, {
      success: true,
      messageId: claim.messageId,
      clientMessageId
    });
  }
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") {
    return jsonResponse(event, 202, {
      success: true,
      pending: true,
      clientMessageId
    });
  }

  let uploaded;
  let stored;
  let result;
  let whatsappSendStarted = false;

  try {
    uploaded = await uploadWhatsAppMedia(buffer, mimeType, filename);
    const storageId = crypto.randomUUID();
    stored = await saveMessageMedia(chatId, storageId, buffer, mimeType, filename);
    whatsappSendStarted = true;
    result = await sendWhatsAppMedia(
      to,
      type,
      uploaded.mediaId,
      caption,
      filename,
      replyContext?.contextMessageId
    );
  } catch (error) {
    if (stored?.storagePath && (!whatsappSendStarted || error.definitive)) {
      await deleteMessageMedia(stored.storagePath).catch((cleanupError) => {
        console.error("Failed to remove unsent media object:", cleanupError);
      });
    }
    if (!whatsappSendStarted) {
      error.definitive = true;
      error.retryable = false;
    }
    await markSendRequestFailed(claim.ref, error);
    throw error;
  }

  const chatRef = db.collection("chats").doc(chatId);
  const messageRef = chatRef.collection("messages").doc(result.messageId);
  const timestamp = new Date();
  const preview = caption || `${type[0].toUpperCase()}${type.slice(1)}`;
  const batch = db.batch();
  batch.set(messageRef, {
    messageId: result.messageId,
    clientMessageId,
    chatId,
    direction: "outgoing",
    type,
    text: caption,
    timestamp,
    status: "sending",
    source: body.source === "quick_reply" ? "quick_reply" : "manual",
    sender: "owner",
    ...getReplyMessageFields(replyContext),
    mediaId: uploaded.mediaId,
    mediaStoragePath: stored.storagePath,
    mediaMimeType: stored.mimeType,
    mediaSize: stored.size,
    mediaFilename: filename
  });
  batch.set(chatRef, {
    customerPhone: chatId,
    lastMessage: preview,
    lastMessageAt: timestamp,
    lastMessageDirection: "outgoing",
    updatedAt: timestamp
  }, { merge: true });
  batch.set(claim.ref, {
    status: "completed",
    messageId: result.messageId,
    updatedAt: timestamp
  }, { merge: true });

  const persistenceStartedAt = Date.now();
  await batch.commit();
  logLatency("firestore_send_persistence_ms", persistenceStartedAt, { media: true });

  return jsonResponse(event, 200, {
    success: true,
    messageId: result.messageId,
    clientMessageId
  });
}

async function retrieveTenantMessageMedia(event) {
  const decoded = await authenticateUser(event);
  const params = event.queryStringParameters || {};
  const organization = await requireOrganization(getDb(), decoded, params.organizationId);
  requirePermission(organization, "chats:read");
  const chatId = normalizePhoneNumber(params.chatId);
  const messageId = String(params.messageId || "");
  if (!/^\d{6,20}$/.test(chatId) || !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId)) {
    return jsonResponse(event, 400, { error: "Valid chatId and messageId are required." });
  }
  const snapshot = await getTenantMessageRef(getDb(), organization.id, chatId, messageId).get();
  if (!snapshot.exists) return jsonResponse(event, 404, { error: "Message was not found in this workspace." });
  const message = snapshot.data();
  if (!message.mediaId) return jsonResponse(event, 404, { error: "This message has no WhatsApp media ID." });
  const credentials = await getWhatsAppCredentials(getDb(), organization.id);
  const media = await fetchWhatsAppMediaForProxy(message.mediaId, credentials);
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      ...getCorsHeaders(event),
      "Content-Type": media.mimeType,
      "Content-Disposition": `inline; filename="${media.filename || "whatsapp-media"}"`,
      "Content-Length": String(media.buffer.length),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox"
    },
    body: media.buffer.toString("base64")
  };
}

async function retrieveMessageMedia(event) {
  await authenticateOwner(event);
  const params = event.queryStringParameters || {};
  const chatId = normalizePhoneNumber(params.chatId);
  const messageId = String(params.messageId || "");
  if (
    !/^\d{6,20}$/.test(chatId) ||
    !/^[a-zA-Z0-9_-]{1,180}$/.test(messageId)
  ) {
    return jsonResponse(event, 400, { error: "Valid chatId and messageId are required." });
  }

  const messageRef = getDb()
    .collection("chats")
    .doc(chatId)
    .collection("messages")
    .doc(messageId);
  const snapshot = await messageRef.get();
  if (!snapshot.exists || !snapshot.data().mediaStoragePath) {
    return jsonResponse(event, 404, { error: "Media is not available for this message." });
  }

  const media = await getSignedMediaUrl(snapshot.data().mediaStoragePath);
  if (!media) {
    return jsonResponse(event, 404, { error: "Stored media could not be found." });
  }
  return jsonResponse(event, 200, media);
}

async function getConnectionStatus(event) {
  await authenticateOwner(event);
  const whatsapp = await checkWhatsAppConnection();
  let firestore;
  try {
    await getDb().collection("chats").limit(1).get();
    firestore = { connected: true };
  } catch (error) {
    console.error("Firestore diagnostics failed:", error);
    firestore = {
      connected: false,
      error: String(error.message || "Firestore access check failed.").slice(0, 200)
    };
  }
  return jsonResponse(event, 200, {
    whatsapp,
    firestore,
    mediaStorage: {
      configured: Boolean(
        process.env.FIREBASE_STORAGE_BUCKET ||
        process.env.VITE_FIREBASE_STORAGE_BUCKET
      )
    },
    checkedAt: new Date().toISOString()
  });
}

async function getGreetingSettings(event) {
  const owner = await authenticateOwner(event);
  const snapshot = await getDb()
    .collection("users")
    .doc(owner.uid)
    .collection("settings")
    .doc("greeting")
    .get();
  const data = snapshot.exists ? snapshot.data() : {};
  return jsonResponse(event, 200, {
    enabled: Boolean(data.enabled),
    text: String(data.text || ""),
    trigger: "first_inbound"
  });
}

async function saveGreetingSettings(event) {
  const owner = await authenticateOwner(event);
  const body = parseBody(event);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.enabled !== "boolean" ||
    typeof body.text !== "string"
  ) {
    return jsonResponse(event, 400, {
      error: "Greeting enabled state and text are required."
    });
  }

  const text = body.text.trim();
  if (text.length > 1024 || (body.enabled && !text)) {
    return jsonResponse(event, 400, {
      error: "Enabled greetings require text of at most 1024 characters."
    });
  }

  await getDb()
    .collection("users")
    .doc(owner.uid)
    .collection("settings")
    .doc("greeting")
    .set({
      enabled: body.enabled,
      text,
      trigger: "first_inbound",
      updatedAt: new Date()
    }, { merge: true });

  return jsonResponse(event, 200, {
    success: true,
    enabled: body.enabled,
    text,
    trigger: "first_inbound"
  });
}

exports.handler = async (event) => {
  const method = getMethod(event);
  const path = getPath(event);

  if (method === "OPTIONS") {
    return emptyResponse(event, 204);
  }

  if (method === "GET" && path.endsWith("/whatsapp/connections")) {
    try { return await handleWhatsAppConnections(event); }
    catch (error) {
      console.error("WhatsApp connections could not load:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "WhatsApp connections could not be loaded."
      });
    }
  }

  if (method === "GET" && path.endsWith("/whatsapp/templates")) {
    try { return await handleWhatsAppTemplates(event); }
    catch (error) {
      console.error("WhatsApp templates could not load:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "WhatsApp templates could not be loaded." });
    }
  }

  if (method === "POST" && path.endsWith("/whatsapp/connection-health")) {
    try { return await handleWhatsAppConnectionHealth(event); }
    catch (error) {
      console.error("WhatsApp connection health check failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "WhatsApp connection health could not be checked."
      });
    }
  }

  if ((method === "POST" || method === "DELETE") && path.endsWith("/whatsapp/connect")) {
    try {
      return await handleWhatsAppConnect(event);
    } catch (error) {
      console.error("WhatsApp connection setup failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "WhatsApp connection could not be saved."
      });
    }
  }

  if ((method === "GET" || method === "POST") && path.endsWith("/organizations")) {
    try {
      return await handleOrganizations(event);
    } catch (error) {
      console.error("Organization request failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Organization request could not be completed."
      });
    }
  }

  if (method === "GET" && path.endsWith("/webhook")) {
    const result = await verifyWebhook(event);

    return textResponse(
      event,
      result.statusCode,
      result.body
    );
  }

  if (method === "POST" && path.endsWith("/webhook")) {
    const result = await receiveWebhook(event);

    return textResponse(
      event,
      result.statusCode,
      result.body
    );
  }

  if (["GET", "POST", "PUT", "DELETE"].includes(method) && path.endsWith("/organizations/members")) {
    try { return await handleOrganizationMembers(event); }
    catch (error) {
      console.error("Organization member request failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Organization members could not be updated." });
    }
  }

  if (["GET", "POST", "PUT", "DELETE"].includes(method) && path.endsWith("/organizations/contacts")) {
    try { return await handleTenantResource(event, "contacts"); }
    catch (error) { console.error("Tenant contacts request failed:", error); return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Contacts request could not be completed." }); }
  }


  if (["GET", "POST", "DELETE"].includes(method) && path.endsWith("/organizations/quick-replies/image")) {
    try { return method === "GET" ? await getTenantQuickReplyImage(event) : method === "DELETE" ? await removeTenantQuickReplyImage(event) : await saveTenantQuickReplyImage(event); }
    catch (error) { console.error("Quick Reply image upload failed:", error); return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Quick Reply image could not be saved." }); }
  }

  if (["GET", "POST", "PUT", "DELETE"].includes(method) && path.endsWith("/organizations/quick-replies")) {
    try { return await handleTenantResource(event, "quickReplies"); }
    catch (error) { console.error("Tenant Quick Replies request failed:", error); return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Quick Replies request could not be completed." }); }
  }

  if (method === "POST" && ["/organizations/chat-state", "/organizations/chat-assignment", "/organizations/message-state", "/organizations/delete-messages", "/organizations/delete-chats"].some((suffix) => path.endsWith(suffix))) {
    const action = path.slice(path.lastIndexOf("/") + 1);
    try { return await handleTenantChatAction(event, action); }
    catch (error) {
      console.error("Tenant chat action failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Conversation action could not be completed." });
    }
  }


  if (method === "POST" && path.endsWith("/organizations/send-quick-reply")) {
    try { return await sendTenantQuickReplyImage(event); }
    catch (error) { console.error("Quick Reply image send failed:", error); return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Quick Reply image could not be sent.", retryable: error.retryable ?? !error.definitive }); }
  }

  if (method === "POST" && path.endsWith("/organizations/send-template")) {
    try { return await sendTenantTemplate(event); }
    catch (error) {
      console.error("Tenant template send failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Template message could not be sent.", retryable: error.retryable ?? !error.definitive });
    }
  }

  if (method === "POST" && path.endsWith("/organizations/retry-template")) {
    try { return await retryTenantFailedTemplate(event); }
    catch (error) {
      console.error("Tenant failed template retry error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Template retry could not be sent.",
        retryable: error.retryable ?? !error.definitive
      });
    }
  }

  if (method === "POST" && path.endsWith("/organizations/retry")) {
    try { return await retryTenantFailedText(event); }
    catch (error) {
      console.error("Tenant failed text retry error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Message retry could not be sent.",
        retryable: error.retryable ?? !error.definitive
      });
    }
  }

  if (method === "POST" && path.endsWith("/organizations/send-media")) {
    try { return await sendTenantMediaMessage(event); }
    catch (error) {
      console.error("Tenant media send failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Media message could not be sent.", retryable: error.retryable ?? !error.definitive });
    }
  }

  if (method === "POST" && path.endsWith("/organizations/send")) {
    try {
      return await sendTenantMessage(event);
    } catch (error) {
      console.error("Tenant send message error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Message could not be sent.",
        retryable: error.retryable ?? !error.definitive
      });
    }
  }

  if (method === "POST" && path.endsWith("/send")) {
    const startedAt = Date.now();
    try {
      return await sendMessage(event);
    } catch (error) {
      console.error("Send message error:", error);

      return jsonResponse(
        event,
        error.statusCode || 500,
        {
          error: error.statusCode
            ? error.message
            : error.message || "Message could not be sent.",
          retryable: error.retryable ?? !error.definitive
        }
      );
    } finally {
      logLatency("lambda_send_ms", startedAt);
    }
  }

  if (method === "POST" && path.endsWith("/organizations/fcm-tokens/register")) {
    try { return await registerTenantFcmToken(event); }
    catch (error) {
      console.error("Tenant FCM token registration failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Push notification registration could not be completed." });
    }
  }

  if (method === "POST" && path.endsWith("/organizations/fcm-tokens/remove")) {
    try { return await removeTenantFcmToken(event); }
    catch (error) {
      console.error("Tenant FCM token removal failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Push notification registration could not be removed." });
    }
  }

  if (method === "POST" && path.endsWith("/fcm-tokens/register")) {
    try {
      return await registerFcmToken(event);
    } catch (error) {
      console.error("Register FCM token error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : "Push notification registration could not be completed."
      });
    }
  }

  if (method === "POST" && path.endsWith("/fcm-tokens/remove")) {
    try {
      return await removeFcmToken(event);
    } catch (error) {
      console.error("Remove FCM token error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : "Push notification registration could not be removed."
      });
    }
  }

  if (method === "POST" && path.endsWith("/chat-state")) {
    try {
      return await updateChatState(event);
    } catch (error) {
      console.error("Update chat state error:", error);

      return jsonResponse(
        event,
        error.statusCode || 500,
        {
          error: error.statusCode
            ? error.message
            : "Conversation could not be updated."
        }
      );
    }
  }

  if (method === "POST" && path.endsWith("/message-state")) {
    try {
      return await updateMessageState(event);
    } catch (error) {
      console.error("Update message state error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Message could not be updated."
      });
    }
  }

  if (method === "POST" && path.endsWith("/delete-messages")) {
    try {
      return await deleteMessages(event);
    } catch (error) {
      console.error("Delete messages error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Messages could not be deleted."
      });
    }
  }

  if (method === "POST" && path.endsWith("/delete-chats")) {
    try {
      return await deleteChats(event);
    } catch (error) {
      console.error("Delete chats error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : "Selected conversations could not be deleted."
      });
    }
  }

  if (method === "POST" && path.endsWith("/send-media")) {
    const startedAt = Date.now();
    try {
      return await sendMediaMessage(event);
    } catch (error) {
      console.error("Send media message error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : error.message || "Media message could not be sent.",
        retryable: error.retryable ?? !error.definitive
      });
    } finally {
      logLatency("lambda_send_ms", startedAt, { media: true });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/media")) {
    try { return await retrieveTenantMessageMedia(event); }
    catch (error) {
      console.error("Tenant media proxy failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Media could not be retrieved." });
    }
  }

  if (method === "GET" && path.endsWith("/media")) {
    try {
      return await retrieveMessageMedia(event);
    } catch (error) {
      console.error("Retrieve media error:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : "Media could not be retrieved."
      });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/member-audit")) {
    try { return await handleOrganizationMemberAudit(event); }
    catch (error) {
      console.error("Organization member audit load failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Member activity could not be loaded."
      });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/status")) {
    try { return await getTenantConnectionStatus(event); }
    catch (error) {
      console.error("Tenant connection diagnostics failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Connection diagnostics could not be completed." });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/greeting-settings")) {
    try { return await getTenantGreetingSettings(event); }
    catch (error) {
      console.error("Tenant greeting settings load failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Greeting settings could not be loaded." });
    }
  }

  if (method === "POST" && path.endsWith("/organizations/greeting-settings")) {
    try { return await saveTenantGreetingSettings(event); }
    catch (error) {
      console.error("Tenant greeting settings save failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Greeting settings could not be saved." });
    }
  }

  if (method === "GET" && path.endsWith("/status")) {
    try {
      return await getConnectionStatus(event);
    } catch (error) {
      console.error("Connection diagnostics failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : "Connection diagnostics could not be completed."
      });
    }
  }

  if (method === "GET" && path.endsWith("/greeting-settings")) {
    try {
      return await getGreetingSettings(event);
    } catch (error) {
      console.error("Load greeting settings failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : "Greeting settings could not be loaded."
      });
    }
  }

  if (method === "POST" && path.endsWith("/greeting-settings")) {
    try {
      return await saveGreetingSettings(event);
    } catch (error) {
      console.error("Save greeting settings failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode
          ? error.message
          : "Greeting settings could not be saved."
      });
    }
  }

  return jsonResponse(event, 404, {
    error: "Route not found."
  });
};
