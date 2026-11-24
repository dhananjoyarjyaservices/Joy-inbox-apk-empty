
const crypto = require("crypto");
const { getFirebaseAdmin, getDb } = require("./firebase");
const {
  getHeader,
  getRawBody,
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
const { runScheduledSlaChecks, saveTenantSlaNotification } = require("./slaScheduler");
const { runScheduledAutomationSteps } = require("./automationScheduler");
const { getOrganizationSlaSettings, normalizeSlaSettings, MIN_SLA_MINUTES, MAX_SLA_MINUTES } = require("./slaSettings");
const { normalizeNotificationPreferences, getTenantNotificationPreferences } = require("./notificationPreferences");
const { ID_PATTERN: AUTOMATION_RULE_ID_PATTERN, normalizeAutomationRule } = require("./automationRules");
const { normalizeCampaignDefinition, normalizeCampaignRecipients } = require("./campaignRules");
const { filterSuppressedCampaignRecipients } = require("./campaignCompliance");
const { getConfiguredBillingPlans, createCheckoutSession, createPortalSession, verifyStripeSignature, processStripeWebhookEvent } = require("./billing");
const { getTenantMessageUsage, reserveMediaTransfer, finishMediaTransfer, reserveOutboundMessage, finishOutboundReservation } = require("./tenantUsage");
const { listTenantInternalNotes, addTenantInternalNote } = require("./tenantInternalNotes");
const { DEFAULT_PIPELINE_STAGES, normalizeCrmFieldDefinition, normalizePipelineStage, normalizeCrmLead } = require("./crm");
const { normalizeInteractiveMessage, buildWhatsAppInteractivePayload, getInteractivePreview } = require("./tenantInteractive");
const { createTenantInvitation, listTenantInvitations, revokeTenantInvitation, acceptTenantInvitation } = require("./tenantInvitations");
const {
  getDeviceDocument,
  getTenantDeviceDocument,
  isValidFcmToken,
  isValidInstallationId,
  sendTenantSlaOverdueNotification
} = require("./push");

async function reserveTenantMessageQuota(db, organizationId, clientMessageId, sendRequestRef) {
  try {
    return await reserveOutboundMessage(db, organizationId, clientMessageId);
  } catch (error) {
    if (sendRequestRef) await markTenantSendRequestFailed(sendRequestRef, error);
    throw error;
  }
}

async function reserveTenantMediaQuota(db, organizationId, transferId, bytes, sendRequestRef, messageReservation) {
  try {
    return await reserveMediaTransfer(db, organizationId, transferId, bytes);
  } catch (error) {
    if (messageReservation) await settleTenantMessageQuota(db, messageReservation, { definitive: true });
    if (sendRequestRef) await markTenantSendRequestFailed(sendRequestRef, error);
    throw error;
  }
}

async function settleTenantMediaQuota(db, reservation, outcome, actualBytes) {
  if (!reservation?.enforced) return;
  await finishMediaTransfer(db, reservation, outcome, actualBytes);
}

async function settleTenantMessageQuota(db, reservation, error = null) {
  if (!reservation?.enforced) return;
  // Ambiguous outcomes are charged conservatively so retries cannot bypass the quota.
  await finishOutboundReservation(db, reservation, error?.definitive === true ? "failed" : "sent");
}

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

async function handleTenantAutomationQueueHealth(event) {
  const decoded = await authenticateUser(event);
  if (getMethod(event) !== "GET") return jsonResponse(event, 405, { error: "Method not allowed." });
  const organizationId = event.queryStringParameters?.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "settings:manage");
  const queue = organization.ref.collection("automationQueue");
  const statuses = ["queued", "sending", "sent", "failed", "skipped", "uncertain"];
  const counts = await Promise.all(statuses.map(async (status) => {
    const snapshot = await queue.where("status", "==", status).count().get();
    return [status, Number(snapshot.data().count || 0)];
  }));
  const [dueSnapshot, failedSnapshot] = await Promise.all([
    queue.where("status", "==", "queued").where("dueAt", "<=", new Date()).count().get(),
    queue.where("status", "in", ["failed", "uncertain"]).orderBy("updatedAt", "desc").limit(20).get()
  ]);
  const recentIssues = failedSnapshot.docs.map((document) => {
    const data = document.data();
    return {
      id: document.id,
      status: String(data.status || "failed"),
      ruleId: String(data.ruleId || ""),
      customerPhone: String(data.customerPhone || ""),
      step: Number(data.stepIndex || 0) + 1,
      error: String(data.error || data.reason || "").slice(0, 300),
      updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : null
    };
  });
  return jsonResponse(event, 200, {
    counts: Object.fromEntries(counts),
    dueNow: Number(dueSnapshot.data().count || 0),
    recentIssues,
    maxJobsPerInvocation: 25,
    maxAttempts: 5
  });
}

async function handleTenantAutomationRuns(event) {
  const decoded = await authenticateUser(event);
  if (getMethod(event) !== "GET") return jsonResponse(event, 405, { error: "Method not allowed." });
  const organizationId = event.queryStringParameters?.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "settings:manage");
  const snapshot = await organization.ref.collection("automationRuns").orderBy("createdAt", "desc").limit(50).get();
  const runs = snapshot.docs.map((document) => {
    const data = document.data();
    return {
      id: document.id,
      ruleId: String(data.ruleId || ""),
      ruleName: String(data.ruleName || "Automation"),
      customerPhone: String(data.customerPhone || ""),
      status: String(data.status || "unknown"),
      completedSteps: Number(data.completedSteps || 0),
      totalSteps: Number(data.totalSteps || 1),
      error: data.error ? String(data.error).slice(0, 300) : "",
      reason: data.reason ? String(data.reason).slice(0, 120) : "",
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
      updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : null
    };
  });
  return jsonResponse(event, 200, { runs, limit: 50 });
}

async function handleTenantAutomationRules(event) {
  const decoded = await authenticateUser(event);
  const method = getMethod(event);
  let body = {};
  if (method !== "GET") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organizationId = method === "GET" ? event.queryStringParameters?.organizationId : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "settings:manage");
  const collection = organization.ref.collection("automationRules");
  if (method === "GET") {
    const snapshot = await collection.limit(100).get();
    const rules = snapshot.docs.map((document) => ({
      id: document.id,
      name: String(document.data().name || ""),
      keyword: String(document.data().keyword || ""),
      matchType: String(document.data().matchType || "contains"),
      response: String(document.data().response || document.data().steps?.[0] || ""),
      steps: Array.isArray(document.data().steps) && document.data().steps.length ? document.data().steps.slice(0, 5).map((step) => typeof step === "string" ? { message: step, delaySeconds: 0 } : { message: String(step?.message || ""), delaySeconds: Number.isInteger(step?.delaySeconds) ? step.delaySeconds : 0 }) : [{ message: String(document.data().response || ""), delaySeconds: 0 }],
      enabled: document.data().enabled === true,
      priority: Number(document.data().priority || 100),
      createdAt: document.data().createdAt?.toDate ? document.data().createdAt.toDate().toISOString() : null,
      updatedAt: document.data().updatedAt?.toDate ? document.data().updatedAt.toDate().toISOString() : null
    })).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    return jsonResponse(event, 200, { rules, capped: snapshot.size === 100 });
  }
  if (method === "POST" || method === "PUT") {
    const data = normalizeAutomationRule(body.data);
    let ref;
    if (method === "PUT") {
      if (!AUTOMATION_RULE_ID_PATTERN.test(body.resourceId || "")) return jsonResponse(event, 400, { error: "A valid automation rule ID is required." });
      ref = collection.doc(body.resourceId);
      const existing = await ref.get();
      if (!existing.exists) return jsonResponse(event, 404, { error: "Automation rule was not found." });
    } else {
      if ((await collection.limit(100).get()).size >= 100) return jsonResponse(event, 409, { error: "This workspace has reached the 100-rule limit." });
      ref = collection.doc();
    }
    const now = new Date();
    await ref.set({ ...data, ...(method === "POST" ? { createdAt: now, createdBy: decoded.uid } : {}), updatedAt: now, updatedBy: decoded.uid }, { merge: true });
    return jsonResponse(event, method === "POST" ? 201 : 200, { rule: { id: ref.id, ...data, updatedAt: now.toISOString() } });
  }
  if (method === "DELETE") {
    if (!AUTOMATION_RULE_ID_PATTERN.test(body.resourceId || "")) return jsonResponse(event, 400, { error: "A valid automation rule ID is required." });
    const ref = collection.doc(body.resourceId);
    const existing = await ref.get();
    if (!existing.exists) return jsonResponse(event, 404, { error: "Automation rule was not found." });
    await ref.delete();
    return jsonResponse(event, 200, { success: true });
  }
  return jsonResponse(event, 405, { error: "Method not allowed." });
}

async function handleTenantCrm(event, resource) {
  const method = getMethod(event);
  const decoded = await authenticateUser(event);
  let body = {};
  if (method !== "GET") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organizationId = method === "GET" ? event.queryStringParameters?.organizationId : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  if (resource === "leads") requirePermission(organization, "contacts:manage");
  else if (method === "GET") requirePermission(organization, "contacts:manage");
  else requirePermission(organization, "settings:manage");

  const db = getDb();
  const collectionName = resource === "fields" ? "crmFields" : resource === "stages" ? "crmStages" : "crmLeads";
  const collection = organization.ref.collection(collectionName);

  if (method === "GET") {
    if (resource === "stages") {
      await db.runTransaction(async transaction => {
        const refs = DEFAULT_PIPELINE_STAGES.map(stage => collection.doc(stage.id));
        const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
        const now = new Date();
        snapshots.forEach((snapshot, index) => {
          if (!snapshot.exists) transaction.create(refs[index], { ...DEFAULT_PIPELINE_STAGES[index], createdAt: now, updatedAt: now });
        });
      });
      const snapshot = await collection.orderBy("position", "asc").get();
      return jsonResponse(event, 200, { items: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
    }
    const snapshot = resource === "fields"
      ? await collection.orderBy("createdAt", "asc").get()
      : await collection.orderBy("updatedAt", "desc").limit(100).get();
    let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    if (resource === "leads" && organization.role === "agent") {
      items = items.filter(item => item.ownerUid === decoded.uid);
    }
    return jsonResponse(event, 200, { items });
  }

  if (method === "DELETE") {
    const resourceId = String(body.resourceId || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(resourceId)) return jsonResponse(event, 400, { error: "A valid CRM resource ID is required." });
    const ref = collection.doc(resourceId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return jsonResponse(event, 404, { error: "CRM resource was not found." });
    if (resource === "leads" && organization.role === "agent" && snapshot.data()?.ownerUid !== decoded.uid) {
      return jsonResponse(event, 403, { error: "Agents can only delete leads assigned to them." });
    }
    if (resource === "fields") {
      await ref.set({ active: false, updatedAt: new Date() }, { merge: true });
      return jsonResponse(event, 200, { success: true, active: false });
    }
    if (resource === "stages") {
      if (snapshot.data()?.isDefault) return jsonResponse(event, 409, { error: "The default pipeline stage cannot be deleted." });
      const linked = await organization.ref.collection("crmLeads").where("stageId", "==", resourceId).limit(1).get();
      if (!linked.empty) return jsonResponse(event, 409, { error: "Move or close leads in this stage before deleting it." });
    }
    await ref.delete();
    return jsonResponse(event, 200, { success: true });
  }

  if (method !== "POST" && method !== "PUT") return jsonResponse(event, 405, { error: "Method not allowed." });
  const now = new Date();

  if (resource === "fields") {
    const definition = normalizeCrmFieldDefinition(body.data);
    const ref = collection.doc(definition.key);
    const existing = await ref.get();
    if (method === "PUT" && (!body.resourceId || body.resourceId !== definition.key || !existing.exists)) {
      return jsonResponse(event, 404, { error: "Custom field was not found or its key cannot be changed." });
    }
    if (method === "POST" && existing.exists) return jsonResponse(event, 409, { error: "A custom field with this key already exists. Update it instead." });
    if (method === "POST" && !existing.exists) {
      const count = await collection.get();
      if (count.size >= 30) return jsonResponse(event, 409, { error: "This workspace supports up to 30 custom CRM fields." });
    }
    await ref.set({ ...definition, ...(existing.exists ? {} : { createdAt: now }), updatedAt: now, updatedBy: decoded.uid }, { merge: true });
    return jsonResponse(event, method === "POST" ? 201 : 200, { item: { id: definition.key, ...definition } });
  }

  if (resource === "stages") {
    const stage = normalizePipelineStage(body.data);
    const ref = collection.doc(stage.id);
    const existing = await ref.get();
    if (method === "PUT" && (!body.resourceId || body.resourceId !== stage.id || !existing.exists)) {
      return jsonResponse(event, 404, { error: "Pipeline stage was not found or its ID cannot be changed." });
    }
    if (method === "POST" && existing.exists) return jsonResponse(event, 409, { error: "A pipeline stage with this ID already exists. Update it instead." });
    const allStages = await collection.get();
    if (method === "POST" && !existing.exists && allStages.size >= 20) {
      return jsonResponse(event, 409, { error: "A workspace can have up to 20 pipeline stages." });
    }
    if (stage.isDefault && allStages.docs.some(doc => doc.id !== stage.id && doc.data()?.isDefault && doc.data()?.active !== false)) {
      return jsonResponse(event, 409, { error: "Only one active default pipeline stage is allowed." });
    }
    await ref.set({ ...stage, ...(existing.exists ? {} : { createdAt: now }), updatedAt: now, updatedBy: decoded.uid }, { merge: true });
    return jsonResponse(event, method === "POST" ? 201 : 200, { item: { id: stage.id, ...stage } });
  }

  const fieldSnapshot = await organization.ref.collection("crmFields").get();
  const definitions = fieldSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const lead = normalizeCrmLead(body.data, definitions);
  if (organization.role === "agent") {
    if (lead.ownerUid && lead.ownerUid !== decoded.uid) return jsonResponse(event, 403, { error: "Agents can only assign leads to themselves." });
    if (!lead.ownerUid) lead.ownerUid = decoded.uid;
  }
  const stageSnapshot = await organization.ref.collection("crmStages").doc(lead.stageId).get();
  if (!stageSnapshot.exists || stageSnapshot.data()?.active === false) {
    return jsonResponse(event, 400, { error: "Choose an active stage from this workspace's sales pipeline." });
  }
  if (lead.contactId) {
    const contactSnapshot = await organization.ref.collection("contacts").doc(lead.contactId).get();
    if (!contactSnapshot.exists) return jsonResponse(event, 404, { error: "The selected customer contact was not found in this workspace." });
  }
  if (lead.ownerUid) {
    const memberSnapshot = await organization.ref.collection("members").doc(lead.ownerUid).get();
    if (!memberSnapshot.exists || memberSnapshot.data()?.status !== "active") {
      return jsonResponse(event, 400, { error: "Lead owner must be an active member of this workspace." });
    }
  }
  let ref;
  let createdAt = now;
  if (method === "PUT") {
    const resourceId = String(body.resourceId || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(resourceId)) return jsonResponse(event, 400, { error: "A valid lead ID is required." });
    ref = collection.doc(resourceId);
    const existing = await ref.get();
    if (!existing.exists) return jsonResponse(event, 404, { error: "Lead was not found." });
    if (organization.role === "agent" && existing.data()?.ownerUid !== decoded.uid) {
      return jsonResponse(event, 403, { error: "Agents can only update leads assigned to them." });
    }
    createdAt = existing.data()?.createdAt || now;
  } else {
    ref = collection.doc();
  }
  const stage = stageSnapshot.data() || {};
  const item = {
    ...lead,
    stageName: String(stage.name || ""),
    organizationId: organization.id,
    createdAt,
    updatedAt: now,
    updatedBy: decoded.uid
  };
  if (method === "POST") item.createdBy = decoded.uid;
  await ref.set(item, { merge: method === "PUT" });
  return jsonResponse(event, method === "POST" ? 201 : 200, { item: { id: ref.id, ...item } });
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
  const mediaQuotaReservation = await reserveTenantMediaQuota(db, organization.id, `quick_reply_${body.quickReplyId}_${crypto.randomUUID()}`, buffer.length);
  let saved;
  try {
    saved = await saveQuickReplyImage(organization.id, body.quickReplyId, buffer, body.mimeType);
    await settleTenantMediaQuota(db, mediaQuotaReservation, "sent", buffer.length);
  } catch (error) {
    await settleTenantMediaQuota(db, mediaQuotaReservation, error?.definitive === true ? "failed" : "sent", error?.definitive === true ? 0 : buffer.length);
    throw error;
  }
  await ref.set({ hasImage: true, imageMimeType: saved.mimeType, updatedAt: new Date() }, { merge: true });
  return jsonResponse(event, 200, { success: true, hasImage: true, imageMimeType: saved.mimeType });
}

async function recordTenantFirstResponse(db, organizationId, chatId, agentUid, agentEmail, respondedAt = new Date()) {
  if (!agentUid || !chatId) return false;
  const slaSettings = await getOrganizationSlaSettings(db, organizationId);
  const slaTargetMs = slaSettings.targetMinutes * 60 * 1000;
  const chatRef = getTenantChatRef(db, organizationId, chatId);
  return db.runTransaction(async (transaction) => {
    const chatSnapshot = await transaction.get(chatRef);
    if (!chatSnapshot.exists) return false;
    const chat = chatSnapshot.data() || {};
    const pendingSince = chat.responsePendingSince?.toDate
      ? chat.responsePendingSince.toDate()
      : new Date(chat.responsePendingSince || 0);
    if (!Number.isFinite(pendingSince.getTime()) || pendingSince.getTime() <= 0 ||
        respondedAt.getTime() < pendingSince.getTime()) return false;
    const responseMs = respondedAt.getTime() - pendingSince.getTime();
    const metricRef = db.collection("organizations").doc(organizationId)
      .collection("agentResponseMetrics").doc();
    transaction.set(metricRef, {
      organizationId, chatId, agentUid, agentEmail: String(agentEmail || "").slice(0, 254),
      responseMs, slaTargetMs, slaMet: responseMs <= slaTargetMs,
      inboundAt: pendingSince, respondedAt, createdAt: respondedAt
    });
    transaction.set(chatRef, {
      responsePendingSince: null,
      lastAgentResponseAt: respondedAt,
      updatedAt: respondedAt
    }, { merge: true });
    return true;
  });
}

async function handleTenantAgentPerformance(event) {
  const decoded = await authenticateUser(event);
  const params = event.queryStringParameters || {};
  const organization = await requireOrganization(getDb(), decoded, params.organizationId);
  requirePermission(organization, "chats:read");
  const rawDays = Number(params.days || 30);
  const days = [7, 30, 90].includes(rawDays) ? rawDays : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const snapshot = await organization.ref.collection("auditLogs")
    .where("action", "in", ["chat.assigned", "chat.status_changed"])
    .get();
  const stats = new Map();
  const getStats = (uid, email = "") => {
    if (!uid) return null;
    if (!stats.has(uid)) stats.set(uid, {
      uid, email: String(email || ""), assignedCount: 0, resolvedCount: 0,
      lastActivityAt: null
    });
    const item = stats.get(uid);
    if (email && !item.email) item.email = String(email);
    return item;
  };
  for (const doc of snapshot.docs) {
    const item = doc.data() || {};
    const createdAt = item.createdAt?.toDate ? item.createdAt.toDate() : new Date(item.createdAt || 0);
    if (Number.isNaN(createdAt.getTime()) || createdAt < since) continue;
    if (item.action === "chat.assigned") {
      const targetUid = String(item.details?.assignedTo || item.targetUid || "");
      const target = getStats(targetUid, item.targetEmail);
      if (target) target.assignedCount += 1;
      const actor = getStats(String(item.actorUid || ""), item.actorEmail);
      if (actor && (!actor.lastActivityAt || createdAt > actor.lastActivityAt)) actor.lastActivityAt = createdAt;
      if (target && (!target.lastActivityAt || createdAt > target.lastActivityAt)) target.lastActivityAt = createdAt;
    } else if (item.action === "chat.status_changed" && item.details?.status === "resolved") {
      const actor = getStats(String(item.actorUid || ""), item.actorEmail);
      if (actor) {
        actor.resolvedCount += 1;
        if (!actor.lastActivityAt || createdAt > actor.lastActivityAt) actor.lastActivityAt = createdAt;
      }
    }
  }
  const responseSnapshot = await organization.ref.collection("agentResponseMetrics")
    .where("respondedAt", ">=", since).get();
  for (const doc of responseSnapshot.docs) {
    const response = doc.data() || {};
    const agent = getStats(String(response.agentUid || ""), response.agentEmail);
    const responseMs = Number(response.responseMs);
    if (!agent || !Number.isFinite(responseMs) || responseMs < 0) continue;
    agent.responseCount = (agent.responseCount || 0) + 1;
    agent.totalResponseMs = (agent.totalResponseMs || 0) + responseMs;
    const met = typeof response.slaMet === "boolean"
      ? response.slaMet : responseMs <= 5 * 60 * 1000;
    if (met) agent.slaMetCount = (agent.slaMetCount || 0) + 1;
    else agent.slaBreachCount = (agent.slaBreachCount || 0) + 1;
  }
  const agents = [...stats.values()].map(agent => ({
    ...agent,
    averageResponseMs: agent.responseCount ? Math.round(agent.totalResponseMs / agent.responseCount) : null,
    slaMetCount: agent.slaMetCount || 0,
    slaBreachCount: agent.slaBreachCount || 0,
    slaMetPercent: agent.responseCount ? Math.round((agent.slaMetCount || 0) / agent.responseCount * 100) : null
  })).sort((a, b) =>
    (b.assignedCount + b.resolvedCount) - (a.assignedCount + a.resolvedCount)
  );
  return jsonResponse(event, 200, { days, since: since.toISOString(), agents });
}

async function handleTenantChatAssignmentAudit(event) {
  const decoded = await authenticateUser(event);
  const params = event.queryStringParameters || {};
  const organization = await requireOrganization(getDb(), decoded, params.organizationId);
  requirePermission(organization, "chats:read");
  const chatId = String(params.chatId || "");
  if (!/^\d{6,20}$/.test(chatId)) {
    return jsonResponse(event, 400, { error: "A valid conversation ID is required." });
  }
  const snapshot = await organization.ref.collection("auditLogs")
    .where("details.chatId", "==", chatId)
    .get();
  const events = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(item => ["chat.assigned", "chat.status_changed"].includes(item.action))
    .sort((a, b) => {
      const aTime = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt || 0).getTime();
      const bTime = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    })
    .slice(0, 30);
  return jsonResponse(event, 200, { events });
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

async function listTenantFcmDevices(event) {
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, event.queryStringParameters?.organizationId);
  requirePermission(organization, "chats:read");
  const snapshot = await organization.ref.collection("members").doc(decoded.uid)
    .collection("devices").orderBy("updatedAt", "desc").limit(50).get();
  const devices = snapshot.docs.map(document => {
    const value = document.data() || {};
    return {
      installationId: String(value.installationId || ""),
      deviceName: String(value.deviceName || "Unknown device").slice(0, 80),
      platform: String(value.platform || "web").slice(0, 30),
      userAgent: String(value.userAgent || "").slice(0, 200),
      createdAt: value.createdAt?.toDate ? value.createdAt.toDate().toISOString() : null,
      updatedAt: value.updatedAt?.toDate ? value.updatedAt.toDate().toISOString() : null
    };
  }).filter(device => isValidInstallationId(device.installationId));
  return jsonResponse(event, 200, { devices });
}

async function listTenantNotificationDeliveries(event) {
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, event.queryStringParameters?.organizationId);
  requirePermission(organization, "chats:read");
  const snapshot = await organization.ref.collection("members").doc(decoded.uid)
    .collection("notificationDeliveries").orderBy("createdAt", "desc").limit(100).get();
  const deliveries = snapshot.docs.map(document => {
    const value = document.data() || {};
    return {
      id: document.id,
      type: String(value.type || "notification"),
      status: value.status === "delivered" ? "delivered" : "failed",
      attempts: Number(value.attempts || 1),
      errorCode: value.errorCode ? String(value.errorCode).slice(0, 120) : null,
      createdAt: value.createdAt?.toDate ? value.createdAt.toDate().toISOString() : null
    };
  });
  return jsonResponse(event, 200, { deliveries });
}

async function listTenantMemberNotificationDeliveries(event) {
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, event.queryStringParameters?.organizationId);
  requirePermission(organization, "chats:read");
  if (!["owner", "admin"].includes(organization.role)) {
    const error = new Error("Only workspace owners and admins can view another member's delivery history.");
    error.statusCode = 403;
    throw error;
  }
  const query = event.queryStringParameters || {};
  const uid = String(query.uid || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return jsonResponse(event, 400, { error: "A valid team member ID is required." });
  const memberRef = organization.ref.collection("members").doc(uid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) return jsonResponse(event, 404, { error: "Team member was not found in this workspace." });
  const parseDate = (value, endOfDay = false) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const date = new Date(value + (endOfDay ? "T23:59:59.999" : "T00:00:00.000"));
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
  };
  const from = parseDate(query.from);
  const to = parseDate(query.to, true);
  if (from === undefined || to === undefined || (from && to && from > to)) {
    return jsonResponse(event, 400, { error: "Use valid date filters with From on or before To." });
  }
  let deliveriesQuery = memberRef.collection("notificationDeliveries").orderBy("createdAt", "desc");
  if (from) deliveriesQuery = deliveriesQuery.where("createdAt", ">=", from);
  if (to) deliveriesQuery = deliveriesQuery.where("createdAt", "<=", to);
  const snapshot = await deliveriesQuery.limit(200).get();
  const deliveries = snapshot.docs.map(document => {
    const value = document.data() || {};
    return {
      id: document.id,
      type: String(value.type || "notification"),
      status: value.status === "delivered" ? "delivered" : "failed",
      attempts: Math.max(1, Number(value.attempts || 1)),
      errorCode: value.errorCode ? String(value.errorCode).slice(0, 120) : null,
      createdAt: value.createdAt?.toDate ? value.createdAt.toDate().toISOString() : null
    };
  });
  const total = deliveries.length;
  const delivered = deliveries.filter(item => item.status === "delivered").length;
  const failed = total - delivered;
  const retried = deliveries.filter(item => item.attempts > 1).length;
  const attempts = deliveries.reduce((sum, item) => sum + item.attempts, 0);
  const byType = {};
  for (const item of deliveries) {
    if (!byType[item.type]) byType[item.type] = { total: 0, delivered: 0, failed: 0, retried: 0, attempts: 0 };
    const stats = byType[item.type];
    stats.total += 1;
    stats[item.status] += 1;
    if (item.attempts > 1) stats.retried += 1;
    stats.attempts += item.attempts;
  }
  const member = memberDoc.data() || {};
  return jsonResponse(event, 200, {
    member: { uid, name: String(member.displayName || member.name || member.email || "Team member").slice(0, 100), role: String(member.role || "agent") },
    summary: { total, delivered, failed, retried, attempts, rate: total ? Math.round(delivered / total * 100) : 0, byType },
    deliveries,
    capped: snapshot.size === 200,
    limit: 200,
    from: query.from || null,
    to: query.to || null
  });
}

async function listTenantTeamNotificationDeliveries(event) {
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, event.queryStringParameters?.organizationId);
  requirePermission(organization, "chats:read");
  if (!["owner", "admin"].includes(organization.role)) {
    const error = new Error("Only workspace owners and admins can view team delivery analytics.");
    error.statusCode = 403;
    throw error;
  }
  const query = event.queryStringParameters || {};
  const parseDate = (value, endOfDay = false) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const date = new Date(value + (endOfDay ? "T23:59:59.999" : "T00:00:00.000"));
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
  };
  const from = parseDate(query.from);
  const to = parseDate(query.to, true);
  if (from === undefined || to === undefined || (from && to && from > to)) {
    return jsonResponse(event, 400, { error: "Use valid date filters with From on or before To." });
  }
  const membersSnapshot = await organization.ref.collection("members").limit(50).get();
  const memberRows = await Promise.all(membersSnapshot.docs.map(async memberDoc => {
    const member = memberDoc.data() || {};
    if (member.status && member.status !== "active") return null;
    let deliveriesQuery = memberDoc.ref.collection("notificationDeliveries").orderBy("createdAt", "desc");
    if (from) deliveriesQuery = deliveriesQuery.where("createdAt", ">=", from);
    if (to) deliveriesQuery = deliveriesQuery.where("createdAt", "<=", to);
    const snapshot = await deliveriesQuery.limit(500).get();
    const deliveries = snapshot.docs.map(doc => doc.data() || {});
    const total = deliveries.length;
    const delivered = deliveries.filter(item => item.status === "delivered").length;
    const failed = total - delivered;
    const retried = deliveries.filter(item => Number(item.attempts || 1) > 1).length;
    const attempts = deliveries.reduce((sum, item) => sum + Math.max(1, Number(item.attempts || 1)), 0);
    const byType = {};
    for (const item of deliveries) {
      const type = String(item.type || "other");
      if (!byType[type]) byType[type] = { total: 0, delivered: 0, failed: 0, retried: 0, attempts: 0 };
      const stats = byType[type];
      stats.total += 1;
      if (item.status === "delivered") stats.delivered += 1;
      else stats.failed += 1;
      if (Number(item.attempts || 1) > 1) stats.retried += 1;
      stats.attempts += Math.max(1, Number(item.attempts || 1));
    }
    const latest = deliveries[0]?.createdAt;
    return {
      uid: memberDoc.id,
      name: String(member.displayName || member.name || member.email || "Team member").slice(0, 100),
      role: String(member.role || "agent"),
      total, delivered, failed, retried, attempts,
      rate: total ? Math.round(delivered / total * 100) : 0,
      byType,
      lastActivityAt: latest?.toDate ? latest.toDate().toISOString() : null
    };
  }));
  const agents = memberRows.filter(Boolean).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const typeTotals = {};
  for (const agent of agents) {
    for (const [type, stats] of Object.entries(agent.byType)) {
      if (!typeTotals[type]) typeTotals[type] = { total: 0, delivered: 0, failed: 0, retried: 0, attempts: 0 };
      for (const key of ["total", "delivered", "failed", "retried", "attempts"]) typeTotals[type][key] += stats[key];
    }
  }
  for (const stats of Object.values(typeTotals)) stats.rate = stats.total ? Math.round(stats.delivered / stats.total * 100) : 0;
  return jsonResponse(event, 200, {
    agents,
    typeTotals,
    sampledMembers: membersSnapshot.size,
    capped: membersSnapshot.size >= 50 || memberRows.some(item => item && item.total >= 500),
    perMemberLimit: 500,
    from: query.from || null,
    to: query.to || null
  });
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
  const ref = getTenantDeviceDocument(getDb(), organization.id, decoded.uid, body.installationId);
  const existing = await ref.get();
  await ref.set({
    token: body.token,
    installationId: body.installationId,
    deviceName: String(body.deviceName || "Web browser").slice(0, 80),
    platform: String(body.platform || "web").slice(0, 30),
    userAgent: String(body.userAgent || "").slice(0, 200),
    ...(existing.exists ? {} : { createdAt: new Date() }),
    updatedAt: new Date()
  }, { merge: true });
  return jsonResponse(event, 200, { success: true });
}

async function handleOrganizationNotificationPreferences(event) {
  const decoded = await authenticateUser(event);
  const method = getMethod(event);
  let body = {};
  if (method !== "GET") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  if (!["GET", "PUT"].includes(method)) return jsonResponse(event, 405, { error: "Method not allowed." });
  const organization = await requireOrganization(getDb(), decoded, method === "GET" ? event.queryStringParameters?.organizationId : body.organizationId);
  requirePermission(organization, "chats:read");
  const db = getDb();
  const ref = organization.ref.collection("members").doc(decoded.uid).collection("settings").doc("notifications");
  if (method === "GET") {
    const preferences = await getTenantNotificationPreferences(db, organization.id, decoded.uid);
    return jsonResponse(event, 200, { preferences });
  }
  for (const key of ["assignment", "status", "sla", "soundEnabled", "desktopEnabled"]) {
    if (typeof body[key] !== "boolean") return jsonResponse(event, 400, { error: `Preference '${key}' must be true or false.` });
  }
  const preferences = normalizeNotificationPreferences(body);
  await ref.set({ ...preferences, updatedAt: new Date() }, { merge: true });
  return jsonResponse(event, 200, { preferences });
}

async function handleOrganizationNotifications(event) {
  const decoded = await authenticateUser(event);
  const method = getMethod(event);
  let body = {};
  if (method !== "GET") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organizationId = method === "GET" ? event.queryStringParameters?.organizationId : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "chats:read");
  const db = getDb();
  const readRef = organization.ref.collection("members").doc(decoded.uid).collection("notificationReads");
  const preferences = await getTenantNotificationPreferences(db, organization.id, decoded.uid);
  if (method === "POST") {
    const now = new Date();
    if (body.markAllRead === true) {
      const [history, audit] = await Promise.all([
        organization.ref.collection("members").doc(decoded.uid).collection("notifications").limit(450).get(),
        organization.ref.collection("auditLogs").orderBy("createdAt", "desc").limit(450).get()
      ]);
      const historyBatch = db.batch();
      for (const doc of history.docs) historyBatch.set(doc.ref, { read: true, readAt: now }, { merge: true });
      await historyBatch.commit();
      const auditBatch = db.batch();
      let auditMarked = 0;
      for (const doc of audit.docs) {
        const item = doc.data() || {};
        const assignedTo = String(item.details?.assignedTo || item.targetUid || "");
        const relevant = item.action === "chat.assigned" ? assignedTo === decoded.uid
          : item.action === "chat.status_changed" && String(item.actorUid || "") !== decoded.uid;
        if (relevant) {
          auditBatch.set(readRef.doc(`audit_${doc.id}`), { readAt: now }, { merge: true });
          auditMarked += 1;
        }
      }
      if (auditMarked) await auditBatch.commit();
      return jsonResponse(event, 200, { success: true, markedRead: history.size + auditMarked });
    }
    if (typeof body.notificationId !== "string" || !/^[A-Za-z0-9_-]{1,180}$/.test(body.notificationId)) {
      return jsonResponse(event, 400, { error: "A valid notification ID is required." });
    }
    await Promise.all([
      readRef.doc(body.notificationId).set({ readAt: now }, { merge: true }),
      organization.ref.collection("members").doc(decoded.uid).collection("notifications")
        .doc(body.notificationId).set({ read: true, readAt: now }, { merge: true })
    ]);
    return jsonResponse(event, 200, { success: true });
  }
  const [auditSnapshot, slaSnapshot, readSnapshot] = await Promise.all([
    organization.ref.collection("auditLogs").orderBy("createdAt", "desc").limit(100).get(),
    organization.ref.collection("members").doc(decoded.uid).collection("notifications").orderBy("createdAt", "desc").limit(100).get(),
    readRef.get()
  ]);
  const readIds = new Set(readSnapshot.docs.map(doc => doc.id));
  const notifications = [];
  for (const doc of auditSnapshot.docs) {
    const item = doc.data() || {};
    const assignedTo = String(item.details?.assignedTo || item.targetUid || "");
    const relevant = item.action === "chat.assigned" ? preferences.assignment && assignedTo === decoded.uid
      : item.action === "chat.status_changed" && preferences.status && String(item.actorUid || "") !== decoded.uid;
    if (!relevant) continue;
    const createdAt = item.createdAt?.toDate ? item.createdAt.toDate().toISOString() : new Date(item.createdAt || 0).toISOString();
    const chatId = String(item.details?.chatId || "");
    const id = `audit_${doc.id}`;
    notifications.push({
      id, type: item.action === "chat.assigned" ? "assignment" : "status",
      title: item.action === "chat.assigned" ? "Conversation assigned to you" : "Conversation status updated",
      body: item.action === "chat.assigned" ? `Chat ${chatId} was assigned to you` : `Chat ${chatId} status changed to ${String(item.details?.status || "updated")}`,
      chatId, createdAt, read: readIds.has(id)
    });
  }
  for (const doc of slaSnapshot.docs) {
    if (!preferences.sla) continue;
    const item = doc.data() || {};
    const createdAt = item.createdAt?.toDate ? item.createdAt.toDate().toISOString() : new Date(item.createdAt || 0).toISOString();
    notifications.push({
      id: doc.id, type: "sla", title: String(item.title || "SLA response overdue"),
      body: String(item.body || "A customer conversation needs your reply"),
      chatId: String(item.chatId || ""), createdAt,
      read: item.read === true || readIds.has(doc.id)
    });
  }
  notifications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return jsonResponse(event, 200, { notifications: notifications.slice(0, 100) });
}

async function handleOrganizationSlaSettings(event) {
  const decoded = await authenticateUser(event);
  let body = {};
  if (getMethod(event) !== "GET") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organization = await requireOrganization(getDb(), decoded, getMethod(event) === "GET" ? event.queryStringParameters?.organizationId : body.organizationId);
  if (!["owner", "admin"].includes(organization.role)) {
    const error = new Error("Only workspace owners and admins can manage SLA settings.");
    error.statusCode = 403;
    throw error;
  }
  const ref = organization.ref.collection("settings").doc("sla");
  if (getMethod(event) === "GET") {
    const settings = await getOrganizationSlaSettings(getDb(), organization.id);
    return jsonResponse(event, 200, { settings });
  }
  if (typeof body.enabled !== "boolean" || !Number.isInteger(Number(body.targetMinutes)) ||
      Number(body.targetMinutes) < MIN_SLA_MINUTES || Number(body.targetMinutes) > MAX_SLA_MINUTES) {
    return jsonResponse(event, 400, { error: `SLA settings require enabled and a target from ${MIN_SLA_MINUTES} to ${MAX_SLA_MINUTES} minutes.` });
  }
  const settings = normalizeSlaSettings({ enabled: body.enabled, targetMinutes: Number(body.targetMinutes) });
  await ref.set({ ...settings, updatedAt: new Date(), updatedBy: decoded.uid }, { merge: true });
  return jsonResponse(event, 200, { success: true, settings });
}

async function releaseTenantSlaClaim(db, admin, chatRef, pendingMillis) {
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(chatRef);
    if (!latest.exists || latest.get("slaOverdueNotifiedFor") !== pendingMillis) return;
    const attempt = Number(latest.get("slaOverdueAttemptCount") || 0) + 1;
    const delayMs = Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.min(attempt - 1, 6)));
    transaction.update(chatRef, {
      slaOverdueNotifiedFor: admin.firestore.FieldValue.delete(),
      slaOverdueNotifiedAt: admin.firestore.FieldValue.delete(),
      slaOverdueAttemptCount: attempt,
      slaOverdueRetryAfter: admin.firestore.Timestamp.fromDate(new Date(Date.now() + delayMs))
    });
  });
}

async function checkTenantSlaAlerts(event) {
  const decoded = await authenticateUser(event);
  let body;
  try { body = parseBody(event); }
  catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "chats:read");

  const db = getDb();
  const admin = getFirebaseAdmin();
  const slaSettings = await getOrganizationSlaSettings(db, organization.id);
  if (!slaSettings.enabled) return jsonResponse(event, 200, { success: true, notified: 0, disabled: true });
  const targetMs = slaSettings.targetMinutes * 60 * 1000;
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - targetMs));
  const chatsQuery = db.collection("organizations").doc(organization.id)
    .collection("chats")
    .where("responsePendingSince", "<=", cutoff);
  const overdueDocuments = [];
  let pageCursor = null;
  // Bound each invocation while paging so the first 100 overdue chats cannot
  // permanently hide later chats once their alert-claim fields are populated.
  for (let page = 0; page < 10; page += 1) {
    let pageQuery = chatsQuery.orderBy("responsePendingSince").limit(100);
    if (pageCursor) pageQuery = pageQuery.startAfter(pageCursor);
    const pageSnapshot = await pageQuery.get();
    overdueDocuments.push(...pageSnapshot.docs);
    if (pageSnapshot.size < 100) break;
    pageCursor = pageSnapshot.docs[pageSnapshot.docs.length - 1];
  }

  let notified = 0;
  for (const document of overdueDocuments) {
    const chat = document.data();
    const assignedTo = typeof chat.assignedTo === "string" ? chat.assignedTo : "";
    if (!assignedTo || chat.archived === true || chat.status === "resolved") continue;

    const pendingValue = chat.responsePendingSince;
    const pendingMillis = pendingValue && typeof pendingValue.toMillis === "function"
      ? pendingValue.toMillis()
      : pendingValue instanceof Date ? pendingValue.getTime() : NaN;
    if (!Number.isFinite(pendingMillis) || pendingMillis > Date.now() - targetMs) continue;
    const notificationPreferences = await getTenantNotificationPreferences(db, organization.id, assignedTo);
    if (!notificationPreferences.sla) continue;

    const chatRef = document.ref;
    const claimed = await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(chatRef);
      if (!latest.exists) return false;
      const current = latest.data();
      const currentPending = current.responsePendingSince;
      const currentMillis = currentPending && typeof currentPending.toMillis === "function"
        ? currentPending.toMillis()
        : currentPending instanceof Date ? currentPending.getTime() : NaN;
      if (currentMillis !== pendingMillis || current.assignedTo !== assignedTo ||
          current.archived === true || current.status === "resolved" ||
          current.slaOverdueNotifiedFor === pendingMillis ||
          (current.slaOverdueRetryAfter?.toMillis?.() > Date.now())) return false;
      transaction.update(chatRef, {
        slaOverdueNotifiedFor: pendingMillis,
        slaOverdueNotifiedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    });
    if (!claimed) continue;

    try {
      const member = await db.collection("organizations").doc(organization.id)
        .collection("members").doc(assignedTo).get();
      if (member.exists && member.get("status") === "active" &&
          ["owner", "admin", "agent"].includes(member.get("role"))) {
        const delivered = await sendTenantSlaOverdueNotification(
          organization.id,
          assignedTo,
          document.id,
          String(chat.customerName || chat.customerPhone || document.id),
          notificationPreferences
        );
        if (delivered > 0) {
          notified += 1;
          await saveTenantSlaNotification(db, organization.id, assignedTo, document.id, pendingMillis, chat.customerName || chat.customerPhone || document.id);
          await chatRef.set({
            slaOverdueRetryAfter: admin.firestore.FieldValue.delete(),
            slaOverdueAttemptCount: admin.firestore.FieldValue.delete(),
            slaOverdueLastDeliveredAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          await releaseTenantSlaClaim(db, admin, chatRef, pendingMillis);
        }
      } else {
        await releaseTenantSlaClaim(db, admin, chatRef, pendingMillis);
      }
  } catch (error) {
      await releaseTenantSlaClaim(db, admin, chatRef, pendingMillis);
      throw error;
    }
  }
  return jsonResponse(event, 200, { success: true, notified });
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
  const requestStartedAt = Date.now();
  const body = parseBody(event);
  const authStartedAt = Date.now();
  const decoded = await authenticateUser(event);
  logLatency("send_auth_ms", authStartedAt);
  const organizationStartedAt = Date.now();
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");
  logLatency("send_organization_access_ms", organizationStartedAt);

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
  const contextLookupStartedAt = Date.now();
  // These reads are independent. Run them concurrently to remove one serial
  // Firestore round-trip from the interactive send path.
  const [credentials, replyContext] = await Promise.all([
    getWhatsAppCredentials(db, organization.id, body.phoneNumberId),
    resolveTenantReplyContext(db, organization.id, chatId, body)
  ]);
  logLatency("send_context_lookup_ms", contextLookupStartedAt);
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
  const claimStartedAt = Date.now();
  const claim = await claimTenantSendRequest(db, organization.id, chatId, clientMessageId, payloadHash);
  logLatency("send_idempotency_claim_ms", claimStartedAt);
  if (claim.state === "completed") {
    return jsonResponse(event, 200, { success: true, messageId: claim.messageId, clientMessageId });
  }
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") {
    return jsonResponse(event, 202, { success: true, pending: true, clientMessageId });
  }

  const quotaReservation = await reserveTenantMessageQuota(db, organization.id, clientMessageId, claim.ref);
  let result;
  try {
    result = await sendWhatsAppText(to, messageText, replyContext?.contextMessageId, credentials);
    await settleTenantMessageQuota(db, quotaReservation);
  } catch (error) {
    await settleTenantMessageQuota(db, quotaReservation, error);
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
  const persistenceStartedAt = Date.now();
  await batch.commit();
  logLatency("send_firestore_persistence_ms", persistenceStartedAt);
  const responseMetricStartedAt = Date.now();
  await recordTenantFirstResponse(db, organization.id, chatId, decoded.uid, decoded.email, timestamp);
  logLatency("send_first_response_metric_ms", responseMetricStartedAt);
  logLatency("send_request_total_ms", requestStartedAt);

  return jsonResponse(event, 200, { success: true, messageId: result.messageId, clientMessageId });
}

async function sendTenantInteractiveMessage(event) {
  const body = parseBody(event);
  const decoded = await authenticateUser(event);
  const organization = await requireOrganization(getDb(), decoded, body.organizationId);
  requirePermission(organization, "messages:send");
  const to = normalizePhoneNumber(body.to || body.chatId);
  const chatId = normalizePhoneNumber(body.chatId || body.to);
  if (!to || !chatId || to !== chatId) {
    return jsonResponse(event, 400, { error: "Valid matching to and chatId are required." });
  }
  const interactive = normalizeInteractiveMessage(body.interactive);
  const db = getDb();
  const credentials = await getWhatsAppCredentials(db, organization.id, body.phoneNumberId);
  const payload = buildWhatsAppInteractivePayload(to, interactive);
  const clientMessageId = getClientMessageId(body.clientMessageId);
  const payloadHash = hashSendPayload({
    organizationId: organization.id,
    phoneNumberId: credentials.phoneNumberId || null,
    to,
    interactive
  });
  const claim = await claimTenantSendRequest(db, organization.id, chatId, clientMessageId, payloadHash);
  if (claim.state === "completed") {
    return jsonResponse(event, 200, { success: true, messageId: claim.messageId, clientMessageId });
  }
  if (claim.state === "unknown") {
    return jsonResponse(event, 409, { success: false, deliveryUnknown: true, retryable: false, clientMessageId, error: "WhatsApp delivery could not be confirmed. Check the conversation in WhatsApp before sending again." });
  }
  if (claim.state === "pending") return jsonResponse(event, 202, { success: true, pending: true, clientMessageId });

  const quotaReservation = await reserveTenantMessageQuota(db, organization.id, clientMessageId, claim.ref);
  let result;
  try {
    const version = process.env.GRAPH_API_VERSION || "v26.0";
    const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(credentials.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok || !responseBody.messages?.[0]?.id) {
      const error = new Error(responseBody.error?.message || "Meta did not confirm interactive message delivery.");
      error.statusCode = 502;
      error.definitive = !response.ok && isDefinitiveWhatsAppSendRejection(response.status);
      error.retryable = false;
      throw error;
    }
    result = { messageId: responseBody.messages[0].id };
    await settleTenantMessageQuota(db, quotaReservation);
  } catch (error) {
    await settleTenantMessageQuota(db, quotaReservation, error);
    await markTenantSendRequestFailed(claim.ref, error);
    throw error;
  }

  const chatRef = getTenantChatRef(db, organization.id, chatId);
  const messageRef = getTenantMessageRef(db, organization.id, chatId, result.messageId);
  const timestamp = new Date();
  const preview = getInteractivePreview(interactive);
  const batch = db.batch();
  batch.set(messageRef, {
    messageId: result.messageId,
    clientMessageId,
    chatId,
    organizationId: organization.id,
    direction: "outgoing",
    phoneNumberId: credentials.phoneNumberId || null,
    type: "interactive",
    text: preview,
    interactive,
    timestamp,
    status: "sending",
    source: "interactive",
    sender: decoded.uid
  });
  batch.set(chatRef, {
    customerPhone: chatId,
    ...(credentials.phoneNumberId ? { phoneNumberId: credentials.phoneNumberId } : {}),
    lastMessage: preview,
    lastMessageAt: timestamp,
    lastMessageDirection: "outgoing",
    updatedAt: timestamp
  }, { merge: true });
  batch.set(claim.ref, { status: "completed", messageId: result.messageId, updatedAt: timestamp }, { merge: true });
  try {
    await batch.commit();
  } catch (error) {
    // Meta has already accepted this message. Never let a retry send it twice.
    try {
      await claim.ref.set({
        status: "unknown",
        messageId: result.messageId,
        persistenceError: String(error.message || "Message persistence failed.").slice(0, 300),
        updatedAt: new Date()
      }, { merge: true });
    } catch (claimError) {
      console.error("Could not mark interactive send request uncertain:", claimError);
    }
    throw error;
  }
  await recordTenantFirstResponse(db, organization.id, chatId, decoded.uid, decoded.email, timestamp);
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
  const quotaReservation = await reserveTenantMessageQuota(db, organization.id, clientMessageId, claim.ref);
  const mediaQuotaReservation = headerMedia ? await reserveTenantMediaQuota(db, organization.id, `template_header_${clientMessageId}`, Buffer.byteLength(headerMedia.base64, "base64"), claim.ref, quotaReservation) : null;
  const template = { name: templateName, language: { code: language } };
  const components = [];
  let uploadedHeaderMediaId = "";
  if (headerMedia) {
    const mimeType = headerMediaMimeType;
    const buffer = Buffer.from(headerMedia.base64, "base64");
    let uploaded;
    try {
      uploaded = await uploadWhatsAppMedia(buffer, mimeType, headerMedia.filename, credentials);
      await settleTenantMediaQuota(db, mediaQuotaReservation, "sent", buffer.length);
    } catch (error) {
      await settleTenantMediaQuota(db, mediaQuotaReservation, error?.definitive === true ? "failed" : "sent", error?.definitive === true ? 0 : buffer.length);
      await settleTenantMessageQuota(db, quotaReservation, { definitive: true });
      await markTenantSendRequestFailed(claim.ref, error);
      throw error;
    }
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
    await settleTenantMessageQuota(db, quotaReservation);
  } catch (error) {
    await settleTenantMessageQuota(db, quotaReservation, error);
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
  await recordTenantFirstResponse(db, organization.id, to, decoded.uid, decoded.email, timestamp);
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
  const quotaReservation = await reserveTenantMessageQuota(db, organization.id, clientMessageId, claim.ref);
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
    await settleTenantMessageQuota(db, quotaReservation);
    const newRef=getTenantMessageRef(db,organization.id,chatId,newMessageId);
    const preview=`Template: ${templateName}`;
    const batch=db.batch();
    batch.set(newRef,{messageId:newMessageId,clientMessageId,chatId,organizationId:organization.id,direction:"outgoing",phoneNumberId,type:"template",text:preview,templateName,templateLanguage:language,templateVariables:saved,timestamp,status:"sending",source:"template-retry",retryOf:originalMessageId,sender:decoded.uid});
    batch.set(chatRef,{customerPhone:chatId,phoneNumberId,lastMessage:preview,lastMessageAt:timestamp,lastMessageDirection:"outgoing",updatedAt:timestamp},{merge:true});
    batch.set(claim.ref,{status:"completed",messageId:newMessageId,updatedAt:timestamp},{merge:true});
    await batch.commit();
    await recordTenantFirstResponse(db, organization.id, chatId, decoded.uid, decoded.email, timestamp);
    return jsonResponse(event,200,{success:true,messageId:newMessageId,clientMessageId});
  } catch(error) { await settleTenantMessageQuota(db, quotaReservation, error); await markTenantSendRequestFailed(claim.ref,error); throw error; }
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

  const quotaReservation = await reserveTenantMessageQuota(db, organization.id, clientMessageId, claim.ref);
  let result;
  try {
    result = await sendWhatsAppText(chatId, messageText, undefined, credentials);
    await settleTenantMessageQuota(db, quotaReservation);
  } catch (error) {
    await settleTenantMessageQuota(db, quotaReservation, error);
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
  await recordTenantFirstResponse(db, organization.id, chatId, decoded.uid, decoded.email, timestamp);
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
  const quotaReservation = await reserveTenantMessageQuota(db, organization.id, clientMessageId, claim.ref);
  const mediaQuotaReservation = await reserveTenantMediaQuota(db, organization.id, `outgoing_${clientMessageId}`, buffer.length, claim.ref, quotaReservation);
  let uploaded, result, sendStarted = false;
  try {
    uploaded = await uploadWhatsAppMedia(buffer, mimeType, filename, credentials);
    await settleTenantMediaQuota(db, mediaQuotaReservation, "sent", buffer.length);
    sendStarted = true;
    result = await sendWhatsAppMedia(to, type, uploaded.mediaId, caption, filename, replyContext?.contextMessageId, credentials);
    await settleTenantMessageQuota(db, quotaReservation);
  } catch (error) {
    if (!sendStarted) {
      await settleTenantMediaQuota(db, mediaQuotaReservation, error?.definitive === true ? "failed" : "sent", error?.definitive === true ? 0 : buffer.length);
      error.definitive = true; error.retryable = false;
    }
    await settleTenantMessageQuota(db, quotaReservation, error);
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
  await recordTenantFirstResponse(db, organization.id, chatId, decoded.uid, decoded.email, timestamp);
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
  const credentials = await getWhatsAppCredentials(getDb(), organization.id, message.phoneNumberId || undefined);
  const mediaQuotaReservation = await reserveTenantMediaQuota(
    getDb(), organization.id, `media_proxy_${messageId}_${crypto.randomUUID()}`,
    Number.isSafeInteger(Number(message.mediaSize)) && Number(message.mediaSize) > 0 ? Number(message.mediaSize) : null
  );
  let media;
  try {
    media = await fetchWhatsAppMediaForProxy(message.mediaId, credentials);
    await settleTenantMediaQuota(getDb(), mediaQuotaReservation, "sent", media.buffer.length);
  } catch (error) {
    await settleTenantMediaQuota(getDb(), mediaQuotaReservation, "failed", 0);
    throw error;
  }
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

async function handleTenantInvitations(event) {
  const method = getMethod(event);
  if (!["GET", "POST", "DELETE"].includes(method)) return jsonResponse(event, 405, { error: "Method not allowed." });
  const decoded = await authenticateUser(event);
  let body = {};
  if (method !== "GET") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const params = event.queryStringParameters || {};
  const organizationId = method === "GET" ? params.organizationId : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "members:manage");
  if (method === "GET") {
    const invitations = await listTenantInvitations(getDb(), organization.id);
    return jsonResponse(event, 200, { invitations });
  }
  if (method === "POST") {
    if (String(body.role || "agent").toLowerCase() === "admin" && organization.role !== "owner") {
      return jsonResponse(event, 403, { error: "Only the workspace owner can invite an admin." });
    }
    const invitation = await createTenantInvitation(getDb(), organization.id, decoded, {
      email: body.email,
      role: body.role
    });
    return jsonResponse(event, 201, { invitation });
  }
  const result = await revokeTenantInvitation(getDb(), organization.id, body.email, decoded.uid);
  return jsonResponse(event, 200, { invitation: result });
}

async function handleAcceptTenantInvitation(event) {
  let body;
  try { body = parseBody(event); }
  catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  const decoded = await authenticateUser(event);
  const result = await acceptTenantInvitation(getDb(), body.organizationId, body.token, decoded);
  return jsonResponse(event, 200, { success: true, membership: result });
}

async function handleTenantInternalNotes(event) {
  const method = getMethod(event);
  if (!["GET", "POST"].includes(method)) return jsonResponse(event, 405, { error: "Method not allowed." });
  const decoded = await authenticateUser(event);
  let body = {};
  if (method === "POST") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const params = event.queryStringParameters || {};
  const organizationId = method === "GET" ? params.organizationId : body.organizationId;
  const chatId = method === "GET" ? params.chatId : body.chatId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, method === "GET" ? "chats:read" : "chats:manage");
  if (method === "GET") {
    const notes = await listTenantInternalNotes(getDb(), organization.id, chatId);
    return jsonResponse(event, 200, { notes });
  }
  const note = await addTenantInternalNote(getDb(), organization.id, chatId, body, decoded);
  return jsonResponse(event, 201, { note });
}

async function handleTenantBilling(event) {
  const method = getMethod(event);
  const decoded = await authenticateUser(event);
  let body = {};
  if (method === "POST") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organizationId = method === "GET" ? event.queryStringParameters?.organizationId : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "settings:manage");
  const subscriptionRef = organization.ref.collection("billing").doc("subscription");

  if (method === "GET") {
    const [snapshot, plans] = await Promise.all([
      subscriptionRef.get(),
      Promise.resolve(getConfiguredBillingPlans().map(({ key, name, monthlyPriceInr, annualPriceInr, priceId, annualPriceId, limits }) => ({ key, name, monthlyPriceInr, annualPriceInr, monthlyAvailable: Boolean(priceId), annualAvailable: Boolean(annualPriceId), currency: "INR", intervals: ["month", "year"], limits, trialDays: 7 })))
    ]);
    const value = snapshot.exists ? snapshot.data() || {} : {};
    const usage = snapshot.exists ? await getTenantMessageUsage(getDb(), organization.id, value).catch(error => ({ error: error.message })) : null;
    const asIso = input => input?.toDate ? input.toDate().toISOString()
      : input instanceof Date ? input.toISOString() : null;
    return jsonResponse(event, 200, {
      billingEnabled: plans.length > 0,
      plans,
      subscription: snapshot.exists ? {
        plan: String(value.plan || value.checkoutPlan || "unknown"),
         interval: value.interval === "year" || value.billingInterval === "year" || value.checkoutInterval === "year" ? "year" : "month",
        status: String(value.status || "incomplete"),
        currentPeriodEnd: asIso(value.currentPeriodEnd),
        trialEnd: asIso(value.trialEnd),
        cancelAtPeriodEnd: value.cancelAtPeriodEnd === true,
         usage
      } : null
    });
  }
  if (method !== "POST") return jsonResponse(event, 405, { error: "Method not allowed." });
  if (body.action === "checkout") {
    const session = await createCheckoutSession({
      organization,
      decoded,
      planKey: String(body.plan || ""),
      interval: String(body.interval || "month")
    });
    return jsonResponse(event, 200, { success: true, checkout: session });
  }
  if (body.action === "portal") {
    const session = await createPortalSession({ organization });
    return jsonResponse(event, 200, { success: true, portal: session });
  }
  return jsonResponse(event, 400, { error: "Choose a valid billing action." });
}

async function handleStripeBillingWebhook(event) {
  const rawBody = getRawBody(event);
  const signature = getHeader(event, "stripe-signature");
  if (!verifyStripeSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)) {
    return textResponse(event, 400, "Invalid Stripe signature.");
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { return textResponse(event, 400, "Invalid Stripe event JSON."); }
  try {
    const result = await processStripeWebhookEvent(getDb(), payload);
    if (result.inProgress) return textResponse(event, 503, "Stripe event is already being processed.");
    return textResponse(event, 200, "EVENT_RECEIVED");
  } catch (error) {
    console.error("Stripe billing webhook failed:", error);
    return textResponse(event, error.statusCode && error.statusCode < 500 ? error.statusCode : 500, "Stripe event processing failed.");
  }
}

async function handleTenantCampaigns(event) {
  const method = getMethod(event);
  const decoded = await authenticateUser(event);
  let body = {};
  if (method === "POST") {
    try { body = parseBody(event); }
    catch { return jsonResponse(event, 400, { error: "A valid JSON request body is required." }); }
  }
  const organizationId = method === "GET" ? event.queryStringParameters?.organizationId : body.organizationId;
  const organization = await requireOrganization(getDb(), decoded, organizationId);
  requirePermission(organization, "settings:manage");
  const campaigns = organization.ref.collection("campaigns");

  if (method === "GET") {
    const params = event.queryStringParameters || {};
    if (params.campaignId) {
      const campaignId = String(params.campaignId);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(campaignId)) {
        return jsonResponse(event, 400, { error: "A valid campaign ID is required." });
      }
      const campaignRef = campaigns.doc(campaignId);
      const campaignSnapshot = await campaignRef.get();
      if (!campaignSnapshot.exists) return jsonResponse(event, 404, { error: "Campaign was not found." });
      const limit = Math.max(1, Math.min(100, Number(params.limit) || 50));
      const recipientsCollection = campaignRef.collection("recipients");
      let query = recipientsCollection.orderBy("createdAt", "desc").limit(limit);
      if (params.cursor) {
        const cursorId = String(params.cursor);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(cursorId)) return jsonResponse(event, 400, { error: "Invalid campaign recipient cursor." });
        const cursorSnapshot = await recipientsCollection.doc(cursorId).get();
        if (!cursorSnapshot.exists) return jsonResponse(event, 400, { error: "Campaign recipient cursor was not found." });
        query = query.startAfter(cursorSnapshot);
      }
      const recipientSnapshot = await query.get();
      return jsonResponse(event, 200, {
        campaignId,
        recipients: recipientSnapshot.docs.map(document => {
          const value = document.data() || {};
          const asIso = field => field?.toDate ? field.toDate().toISOString()
            : field instanceof Date ? field.toISOString() : null;
          return {
            id: document.id,
            phone: String(value.phone || ""),
            status: String(value.status || "pending"),
            deliveryStatus: String(value.deliveryStatus || ""),
            reason: String(value.reason || ""),
            error: String(value.error || ""),
            messageId: String(value.messageId || ""),
            createdAt: asIso(value.createdAt),
            sentAt: asIso(value.sentAt),
            deliveryUpdatedAt: asIso(value.deliveryUpdatedAt)
          };
        }),
        nextCursor: recipientSnapshot.docs.length === limit ? recipientSnapshot.docs[recipientSnapshot.docs.length - 1].id : null
      });
    }
    const snapshot = await campaigns.orderBy("createdAt", "desc").limit(50).get();
    return jsonResponse(event, 200, {
      campaigns: snapshot.docs.map(document => {
        const value = document.data() || {};
        return {
          id: document.id,
          name: String(value.name || ""),
          templateName: String(value.templateName || ""),
          language: String(value.language || ""),
          category: String(value.category || ""),
          phoneNumberId: String(value.phoneNumberId || ""),
          status: String(value.status || "draft"),
          recipientCount: Number(value.recipientCount || 0),
          skippedRecipients: Number(value.skippedRecipients || 0),
          sentCount: Number(value.sentCount || 0),
          failedCount: Number(value.failedCount || 0),
          uncertainCount: Number(value.uncertainCount || 0),
          deliveredCount: Number(value.deliveredCount || 0),
          readCount: Number(value.readCount || 0),
          deliveryFailedCount: Number(value.deliveryFailedCount || 0),
          skippedCount: Number(value.skippedCount || 0),
          scheduledAt: value.scheduledAt?.toDate ? value.scheduledAt.toDate().toISOString() : null,
          createdAt: value.createdAt?.toDate ? value.createdAt.toDate().toISOString() : null
        };
      })
    });
  }
  if (method !== "POST") return jsonResponse(event, 405, { error: "Method not allowed." });

  if (typeof body.action === "string") {
    const campaignId = String(body.campaignId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(campaignId)) {
      return jsonResponse(event, 400, { error: "A valid campaign ID is required." });
    }
    const campaignRef = campaigns.doc(campaignId);
    const now = new Date();
    const transitions = {
      start: { from: ["draft"], to: "queued" },
      schedule: { from: ["draft"], to: "scheduled" },
      pause: { from: ["queued", "sending", "scheduled"], to: "paused" },
      resume: { from: ["paused"], to: "queued" },
      cancel: { from: ["draft", "scheduled", "queued", "sending", "paused"], to: "cancelled" }
    };
    const transition = transitions[body.action];
    if (!transition) return jsonResponse(event, 400, { error: "Unsupported campaign action." });
    const patch = { status: transition.to, updatedAt: now, updatedBy: decoded.uid };
    if (body.action === "start" || body.action === "resume") patch.queuedAt = now;
    if (body.action === "schedule") {
      const scheduledAt = new Date(body.scheduledAt);
      if (!body.scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) {
        return jsonResponse(event, 400, { error: "Choose a future campaign schedule time." });
      }
      patch.scheduledAt = scheduledAt;
    }
    if (body.action === "cancel") patch.cancelledAt = now;
    if (body.action === "pause") patch.pausedAt = now;
    const transitionResult = await getDb().runTransaction(async transaction => {
      const snapshot = await transaction.get(campaignRef);
      if (!snapshot.exists) return { status: "not_found" };
      const currentStatus = String(snapshot.get("status") || "draft");
      if (!transition.from.includes(currentStatus)) return { status: "conflict", currentStatus };
      transaction.update(campaignRef, patch);
      return { status: transition.to };
    });
    if (transitionResult.status === "not_found") return jsonResponse(event, 404, { error: "Campaign was not found." });
    if (transitionResult.status === "conflict") {
      return jsonResponse(event, 409, { error: `Campaign cannot ${body.action} while status is ${transitionResult.currentStatus}.` });
    }
    return jsonResponse(event, 200, { success: true, campaignId, status: transitionResult.status });
  }

  const definition = normalizeCampaignDefinition(body);
  const normalizedInput = normalizeCampaignRecipients(body.recipients);
  const suppression = await filterSuppressedCampaignRecipients(getDb(), organization.id, normalizedInput.recipients);
  const normalized = { recipients: suppression.recipients, skipped: normalizedInput.skipped + suppression.suppressed };
  if (!normalized.recipients.length) return jsonResponse(event, 400, { error: "No eligible recipients remain after applying WhatsApp opt-out suppressions." });
  const connections = await listWhatsAppConnections(getDb(), organization.id);
  if (!connections.some(item => item.phoneNumberId === definition.phoneNumberId && item.connected)) {
    return jsonResponse(event, 404, { error: "The selected WhatsApp number is not connected to this workspace." });
  }
  const credentials = await getWhatsAppCredentials(getDb(), organization.id, definition.phoneNumberId);
  const version = process.env.GRAPH_API_VERSION || "v26.0";
  const templateUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(definition.wabaId)}/message_templates`);
  templateUrl.searchParams.set("fields", "name,status,language,category,components");
  templateUrl.searchParams.set("name", definition.templateName);
  templateUrl.searchParams.set("limit", "100");
  const templateResponse = await fetch(templateUrl.toString(), {
    headers: { Authorization: `Bearer ${credentials.accessToken}` }
  });
  const templatePayload = await templateResponse.json().catch(() => ({}));
  if (!templateResponse.ok) return jsonResponse(event, 502, {
    error: templatePayload.error?.message || "Meta could not verify this WhatsApp template."
  });
  const approved = (Array.isArray(templatePayload.data) ? templatePayload.data : []).find(item =>
    item.name === definition.templateName && item.language === definition.language &&
    item.status === "APPROVED" && String(item.category || "").toUpperCase() === definition.category
  );
  if (!approved) return jsonResponse(event, 400, {
    error: "The selected template must be approved in the selected language and category."
  });
  const components = Array.isArray(approved.components) ? approved.components : [];
  const bodyText = components.find(item => item.type === "BODY")?.text || "";
  const headerDefinition = components.find(item => item.type === "HEADER");
  const headerText = headerDefinition?.format === "TEXT" ? headerDefinition.text || "" : "";
  const placeholders = [...String(bodyText).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
  const headerPlaceholders = [...String(headerText).matchAll(/\{\{\s*(\d+)\s*\}\}/g)];
  const requiredVariables = placeholders.length ? Math.max(...placeholders) : 0;
  if ((headerDefinition && headerDefinition.format !== "TEXT") || headerPlaceholders.length > 0 ||
      components.some(item => item.type === "BUTTONS" && Array.isArray(item.buttons) &&
        item.buttons.some(button => button.type === "URL" && String(button.url || "").includes("{{")))) {
    return jsonResponse(event, 400, {
      error: "This campaign builder currently supports body-text variables only. Use a template without media headers or dynamic URL buttons."
    });
  }
  const invalidVariables = normalized.recipients.find(recipient =>
    (recipient.variables.length || definition.variables.length) !== requiredVariables
  );
  if (invalidVariables) return jsonResponse(event, 400, {
    error: `Every recipient must have exactly ${requiredVariables} body variable(s), using recipient-specific values or campaign defaults.`
  });

  const db = getDb();
  const campaignRef = campaigns.doc();
  const now = new Date();
  const batch = db.batch();
  batch.set(campaignRef, {
    ...definition,
    organizationId: organization.id,
    status: "preparing",
    recipientCount: normalized.recipients.length,
    skippedRecipients: normalized.skipped,
    sentCount: 0,
    failedCount: 0,
    uncertainCount: 0,
    deliveredCount: 0,
    readCount: 0,
    deliveryFailedCount: 0,
    skippedCount: 0,
    createdBy: decoded.uid,
    createdAt: now,
    updatedAt: now
  });
  await batch.commit();

  try {
    for (let offset = 0; offset < normalized.recipients.length; offset += 400) {
      const recipientBatch = db.batch();
      for (const recipient of normalized.recipients.slice(offset, offset + 400)) {
        const recipientId = crypto.createHash("sha256").update(recipient.phone).digest("hex");
        recipientBatch.set(campaignRef.collection("recipients").doc(recipientId), {
          phone: recipient.phone,
          optedIn: true,
          consentAt: recipient.consentAt,
          consentSource: recipient.consentSource,
          variables: recipient.variables.length ? recipient.variables : definition.variables,
          status: "pending",
          createdAt: now,
          updatedAt: now
        });
      }
      await recipientBatch.commit();
    }
  } catch (error) {
    await campaignRef.set({
      status: "failed",
      preparationError: String(error?.message || "Campaign recipient preparation failed.").slice(0, 300),
      updatedAt: new Date()
    }, { merge: true });
    throw error;
  }
  await campaignRef.set({ status: "draft", updatedAt: new Date() }, { merge: true });
  return jsonResponse(event, 201, {
    campaign: {
      id: campaignRef.id,
      name: definition.name,
      status: "draft",
      recipientCount: normalized.recipients.length,
      skippedRecipients: normalized.skipped,
      templateName: definition.templateName,
      language: definition.language,
      category: definition.category,
      phoneNumberId: definition.phoneNumberId,
      createdAt: now.toISOString()
    }
  });
}

// EventBridge Scheduler invokes this handler through Lambda's IAM permissions.
// Set the configured handler name to "src/index.slaScheduledHandler".
exports.slaScheduledHandler = async () => {
  const [sla, automation] = await Promise.all([
    runScheduledSlaChecks(),
    runScheduledAutomationSteps()
  ]);
  const result = { sla, automation };
  console.info("Scheduled SLA and automation checks completed:", JSON.stringify(result));
  return result;
};

// EventBridge invokes this handler after the retention worker is deployed and staging-verified.
exports.historyRetentionScheduledHandler = async () => {
  const { runScheduledHistoryRetention } = require("./historyRetention");
  const result = await runScheduledHistoryRetention();
  console.info("Scheduled history retention completed:", JSON.stringify(result));
  return result;
};

// Configure a separate EventBridge schedule for campaign delivery.
exports.campaignScheduledHandler = async () => {
  const { runScheduledCampaigns } = require("./campaignWorker");
  const campaigns = await runScheduledCampaigns();
  console.info("Scheduled campaign processing completed:", JSON.stringify(campaigns));
  return campaigns;
};

const LEGACY_OWNER_API_ROUTE_SUFFIXES = Object.freeze([
  "/send",
  "/chat-state",
  "/message-state",
  "/delete-messages",
  "/delete-chats",
  "/send-media",
  "/media",
  "/status",
  "/greeting-settings",
  "/fcm-tokens/register",
  "/fcm-tokens/remove"
]);

function isLegacyOwnerApiRoute(path) {
  // Organization-scoped routes are handled separately and must never be gated here.
  if (typeof path !== "string" || path.includes("/organizations/")) return false;
  return LEGACY_OWNER_API_ROUTE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

exports.handler = async (event) => {
  const method = getMethod(event);
  const path = getPath(event);

  if (method === "OPTIONS") {
    return emptyResponse(event, 204);
  }

  // Legacy single-owner endpoints are opt-in only. New SaaS deployments remain
  // tenant-scoped by default; temporarily enable this only during a controlled
  // migration window with LEGACY_OWNER_API_ENABLED=true.
  if (isLegacyOwnerApiRoute(path) && process.env.LEGACY_OWNER_API_ENABLED !== "true") {
    return jsonResponse(event, 410, {
      error: "This legacy endpoint is disabled. Use the organization-scoped Joy Inbox API."
    });
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

  if (method === "GET" && path.endsWith("/organizations/automation-queue-health")) {
    try { return await handleTenantAutomationQueueHealth(event); }
    catch (error) { console.error("Automation queue health request failed:", error); return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Automation queue health could not be loaded." }); }
  }

  if (method === "GET" && path.endsWith("/organizations/automation-runs")) {
    try { return await handleTenantAutomationRuns(event); }
    catch (error) { console.error("Tenant automation runs request failed:", error); return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Automation run history could not be loaded." }); }
  }

  if (["GET", "POST", "PUT", "DELETE"].includes(method) && path.endsWith("/organizations/automation-rules")) {
    try { return await handleTenantAutomationRules(event); }
    catch (error) { console.error("Tenant automation rules request failed:", error); return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Automation rules request could not be completed." }); }
  }

  if (method === "POST" && path.endsWith("/organizations/invitations/accept")) {
    try { return await handleAcceptTenantInvitation(event); }
    catch (error) {
      console.error("Workspace invitation acceptance failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Workspace invitation could not be accepted."
      });
    }
  }

  if (["GET", "POST", "DELETE"].includes(method) && path.endsWith("/organizations/invitations")) {
    try { return await handleTenantInvitations(event); }
    catch (error) {
      console.error("Workspace invitation request failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Workspace invitations could not be managed."
      });
    }
  }

  if (["GET", "POST"].includes(method) && path.endsWith("/organizations/internal-notes")) {
    try { return await handleTenantInternalNotes(event); }
    catch (error) {
      console.error("Tenant internal note request failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Internal notes could not be loaded or saved."
      });
    }
  }

  if (method === "POST" && path.endsWith("/billing/stripe-webhook")) {
    return await handleStripeBillingWebhook(event);
  }

  if (["GET", "POST"].includes(method) && path.endsWith("/organizations/billing")) {
    try { return await handleTenantBilling(event); }
    catch (error) {
      console.error("Tenant billing request failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Billing request could not be completed."
      });
    }
  }

  if (["GET", "POST"].includes(method) && path.endsWith("/organizations/campaigns")) {
    try { return await handleTenantCampaigns(event); }
    catch (error) {
      console.error("Tenant campaign request failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Campaign request could not be completed."
      });
    }
  }

  if (["GET", "POST", "PUT", "DELETE"].includes(method) && ["/organizations/crm/fields", "/organizations/crm/stages", "/organizations/crm/leads"].some(suffix => path.endsWith(suffix))) {
    const resource = path.endsWith("/fields") ? "fields" : path.endsWith("/stages") ? "stages" : "leads";
    try { return await handleTenantCrm(event, resource); }
    catch (error) {
      console.error("Tenant CRM request failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "CRM request could not be completed." });
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

  if (method === "POST" && path.endsWith("/organizations/send-interactive")) {
    try { return await sendTenantInteractiveMessage(event); }
    catch (error) {
      console.error("Tenant interactive message send failed:", error);
      return jsonResponse(event, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Interactive message could not be sent."
      });
    }
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

  if (["GET", "PUT"].includes(method) && path.endsWith("/organizations/notifications/preferences")) {
    try { return await handleOrganizationNotificationPreferences(event); }
    catch (error) { return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Notification preferences could not be loaded." }); }
  }

  if (["GET", "POST"].includes(method) && path.endsWith("/organizations/notifications")) {
    try { return await handleOrganizationNotifications(event); }
    catch (error) { return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Notifications could not be loaded." }); }
  }

  if (["GET", "PUT"].includes(method) && path.endsWith("/organizations/sla/settings")) {
    try { return await handleOrganizationSlaSettings(event); }
    catch (error) { return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "SLA settings could not be updated." }); }
  }

  if (method === "POST" && path.endsWith("/organizations/sla/check")) {
    try { return await checkTenantSlaAlerts(event); }
    catch (error) {
      console.error("Tenant SLA alert check failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "SLA alerts could not be checked." });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/notifications/member-deliveries")) {
    try { return await listTenantMemberNotificationDeliveries(event); }
    catch (error) {
      console.error("Member notification delivery history failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Member delivery history could not be loaded." });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/notifications/team-deliveries")) {
    try { return await listTenantTeamNotificationDeliveries(event); }
    catch (error) {
      console.error("Team notification delivery analytics failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Team delivery analytics could not be loaded." });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/notifications/deliveries")) {
    try { return await listTenantNotificationDeliveries(event); }
    catch (error) {
      console.error("Tenant notification delivery list failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Delivery history could not be loaded." });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/fcm-tokens/devices")) {
    try { return await listTenantFcmDevices(event); }
    catch (error) {
      console.error("Tenant FCM device list failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Registered devices could not be loaded." });
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

  if (method === "GET" && path.endsWith("/organizations/agent-performance")) {
    try { return await handleTenantAgentPerformance(event); }
    catch (error) {
      console.error("Agent performance load failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Agent performance could not be loaded." });
    }
  }

  if (method === "GET" && path.endsWith("/organizations/chat-assignment-audit")) {
    try { return await handleTenantChatAssignmentAudit(event); }
    catch (error) {
      console.error("Chat assignment audit load failed:", error);
      return jsonResponse(event, error.statusCode || 500, { error: error.statusCode ? error.message : "Conversation activity could not be loaded." });
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
