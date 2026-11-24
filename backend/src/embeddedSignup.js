"use strict";

const crypto = require("crypto");

const DEFAULT_GRAPH_VERSION = "v26.0";
const SESSION_TTL_MS = 10 * 60 * 1000;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function getEmbeddedSignupConfig(env = process.env) {
  const appId = String(env.META_APP_ID || "").trim();
  const configId = String(env.META_EMBEDDED_SIGNUP_CONFIG_ID || "").trim();
  if (!/^\d{5,32}$/.test(appId) || !/^\d{5,32}$/.test(configId)) return null;
  const partnerMode = env.META_PARTNER_MODE === "solution_partner" ? "solution_partner" : "tech_provider";
  if (partnerMode === "solution_partner" &&
      (!/^\d{5,32}$/.test(env.META_SYSTEM_USER_ID || "") ||
       !String(env.META_SYSTEM_USER_ACCESS_TOKEN || "").trim() ||
       !/^\d{5,32}$/.test(env.META_EXTENDED_CREDIT_LINE_ID || ""))) return null;
  return {
    appId,
    configId,
    graphApiVersion: /^v\d+\.\d+$/.test(env.GRAPH_API_VERSION || "")
      ? env.GRAPH_API_VERSION
      : DEFAULT_GRAPH_VERSION,
    partnerMode,
    solutionId: /^\d{5,32}$/.test(env.META_EMBEDDED_SIGNUP_SOLUTION_ID || "")
      ? env.META_EMBEDDED_SIGNUP_SOLUTION_ID
      : null
  };
}

async function createSignupSession(db, organizationId, uid, now = Date.now()) {
  if (!validId(organizationId) || typeof uid !== "string" || !uid) {
    throw httpError("A valid workspace and signed-in user are required.", 400);
  }
  const sessionId = crypto.randomBytes(32).toString("base64url");
  const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex");
  const ref = db.collection("organizations").doc(organizationId)
    .collection("whatsappSignupSessions").doc(sessionHash);
  await ref.create({
    organizationId,
    uid,
    status: "pending",
    createdAt: new Date(now),
    expiresAt: new Date(now + SESSION_TTL_MS)
  });
  return { sessionId, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
}

async function claimSignupSession(db, organizationId, uid, sessionId, now = Date.now()) {
  if (!validId(organizationId) || typeof uid !== "string" || !uid ||
      typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(sessionId)) {
    throw httpError("The WhatsApp signup session is invalid. Start again.", 400);
  }
  const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex");
  const ref = db.collection("organizations").doc(organizationId)
    .collection("whatsappSignupSessions").doc(sessionHash);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw httpError("The WhatsApp signup session was not found. Start again.", 400);
    const data = snapshot.data() || {};
    const expiresAt = data.expiresAt instanceof Date
      ? data.expiresAt.getTime()
      : new Date(data.expiresAt).getTime();
    if (data.organizationId !== organizationId || data.uid !== uid) {
      throw httpError("This WhatsApp signup session belongs to a different workspace or user.", 403);
    }
    if (data.status !== "pending") throw httpError("This WhatsApp signup session has already been used. Start again.", 409);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      transaction.set(ref, { status: "expired", updatedAt: new Date(now) }, { merge: true });
      throw httpError("The WhatsApp signup session expired. Start again.", 410);
    }
    transaction.set(ref, { status: "processing", processingAt: new Date(now) }, { merge: true });
    return { ref, sessionHash };
  });
}

async function finishSignupSession(ref, status, errorCode = null) {
  if (!ref || !["completed", "failed"].includes(status)) return;
  await ref.set({
    status,
    ...(errorCode ? { errorCode: String(errorCode).slice(0, 80) } : {}),
    updatedAt: new Date()
  }, { merge: true });
}

function buildGraphUrl(version, path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function metaRequest(fetchImpl, url, accessToken, options = {}) {
  const response = await fetchImpl(url.toString(), {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(String(payload.error?.message || "Meta could not complete WhatsApp onboarding.").slice(0, 240));
    error.statusCode = 502;
    error.metaCode = String(payload.error?.code || "META_REQUEST_FAILED");
    throw error;
  }
  return payload;
}

async function completeEmbeddedSignup({
  code,
  wabaId,
  phoneNumberId,
  env = process.env,
  fetchImpl = fetch,
  registrationPin
}) {
  const config = getEmbeddedSignupConfig(env);
  const appSecret = String(env.META_APP_SECRET || "").trim();
  if (!config || !appSecret) throw httpError("Joy Inbox WhatsApp onboarding is not configured yet.", 503);
  if (typeof code !== "string" || code.length < 10 || code.length > 4096 || /\s/.test(code)) {
    throw httpError("Meta did not return a valid authorization code. Start again.", 400);
  }
  if (!/^\d{5,32}$/.test(wabaId || "") || !/^\d{5,32}$/.test(phoneNumberId || "")) {
    throw httpError("Meta did not return a valid WhatsApp Business Account and phone number. Start again.", 400);
  }
  if (!/^\d{6}$/.test(registrationPin || "")) {
    throw httpError("A secure six-digit WhatsApp registration PIN could not be prepared.", 500);
  }

  // OAuth code exchange is the one Graph API request authenticated with
  // app credentials in its query string rather than a bearer token.
  const tokenResponse = await fetchImpl(buildGraphUrl(config.graphApiVersion, "oauth/access_token", {
    client_id: config.appId,
    client_secret: appSecret,
    code
  }).toString());
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || tokenPayload.error) {
    const error = new Error(String(tokenPayload.error?.message || "Meta could not authorize this WhatsApp connection.").slice(0, 240));
    error.statusCode = 502;
    error.metaCode = String(tokenPayload.error?.code || "META_CODE_EXCHANGE_FAILED");
    throw error;
  }

  const accessToken = String(tokenPayload.access_token || "");
  if (accessToken.length < 20 || accessToken.length > 4096 || /\s/.test(accessToken)) {
    throw httpError("Meta did not return a usable business access token.", 502);
  }

  const phone = await metaRequest(
    fetchImpl,
    buildGraphUrl(config.graphApiVersion, phoneNumberId, {
      fields: "id,display_phone_number,verified_name"
    }),
    accessToken
  );
  if (String(phone.id || "") !== phoneNumberId) {
    throw httpError("The selected WhatsApp phone number could not be verified with Meta.", 502);
  }

  const waba = await metaRequest(
    fetchImpl,
    buildGraphUrl(config.graphApiVersion, `${wabaId}/phone_numbers`, {
      fields: "id,display_phone_number,verified_name",
      limit: 100
    }),
    accessToken
  );
  const belongsToWaba = Array.isArray(waba.data) && waba.data.some(item => String(item.id || "") === phoneNumberId);
  if (!belongsToWaba) {
    throw httpError("The selected phone number does not belong to the WhatsApp Business Account shared with Joy Inbox.", 403);
  }

  let billingModel = "meta_direct";
  if (config.partnerMode === "solution_partner") {
    const systemUserId = String(env.META_SYSTEM_USER_ID || "");
    const systemUserToken = String(env.META_SYSTEM_USER_ACCESS_TOKEN || "");
    const creditLineId = String(env.META_EXTENDED_CREDIT_LINE_ID || "");
    const currency = /^[A-Z]{3}$/.test(env.META_CREDIT_LINE_CURRENCY || "")
      ? env.META_CREDIT_LINE_CURRENCY
      : "INR";

    await metaRequest(
      fetchImpl,
      buildGraphUrl(config.graphApiVersion, `${wabaId}/assigned_users`, {
        user: systemUserId,
        tasks: JSON.stringify(["MANAGE", "DEVELOP"])
      }),
      systemUserToken,
      { method: "POST", body: JSON.stringify({}) }
    );
    await metaRequest(
      fetchImpl,
      buildGraphUrl(config.graphApiVersion, `${creditLineId}/whatsapp_credit_sharing_and_attach`, {
        waba_currency: currency,
        waba_id: wabaId
      }),
      systemUserToken,
      { method: "POST", body: JSON.stringify({}) }
    );
    billingModel = "joy_inbox_partner_credit_line";
  }

  // Subscribe Joy Inbox's Meta app to the customer's WABA before registration.
  // If phone registration is rejected, the customer can safely retry signup.
  await metaRequest(
    fetchImpl,
    buildGraphUrl(config.graphApiVersion, `${wabaId}/subscribed_apps`),
    accessToken,
    { method: "POST", body: JSON.stringify({}) }
  );

  // Embedded Signup verifies ownership; Cloud API registration and two-step
  // verification are a separate required step. The PIN is generated server-side.
  await metaRequest(
    fetchImpl,
    buildGraphUrl(config.graphApiVersion, `${phoneNumberId}/register`),
    accessToken,
    { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", pin: registrationPin }) }
  );

  return {
    accessToken,
    wabaId,
    phoneNumberId,
    displayPhoneNumber: String(phone.display_phone_number || "").slice(0, 40),
    verifiedName: String(phone.verified_name || "").slice(0, 100),
    registrationPin,
    billingModel
  };
}

function generateRegistrationPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

module.exports = {
  SESSION_TTL_MS,
  getEmbeddedSignupConfig,
  createSignupSession,
  claimSignupSession,
  finishSignupSession,
  completeEmbeddedSignup,
  generateRegistrationPin
};
