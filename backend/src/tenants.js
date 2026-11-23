const crypto = require("crypto");
const { getFirebaseAdmin, getDb } = require("./firebase");
const { getHeader, jsonResponse } = require("./security");
const { normalizePhoneNumber, sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppPayload } = require("./whatsapp");

function getMethod(event) {
  return (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
}

function getPath(event) {
  return event.rawPath || event.path || "/";
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

async function authenticate(event) {
  const authorization = getHeader(event, "authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    fail("Authentication required.", 401);
  }
  const token = authorization.slice(7).trim();
  if (!token) fail("Firebase ID token is missing.", 401);
  try {
    return await getFirebaseAdmin().auth().verifyIdToken(token);
  } catch {
    fail("Firebase ID token is invalid or expired.", 401);
  }
}

function validOrgId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,40}$/.test(value);
}

async function getMembership(db, orgId, uid) {
  const ref = db.collection("organisations").doc(orgId).collection("members").doc(uid);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.data().status !== "active") return null;
  return { ref, ...snapshot.data() };
}

async function requireMembership(db, orgId, uid, allowedRoles = []) {
  if (!validOrgId(orgId)) fail("A valid organisation ID is required.");
  const membership = await getMembership(db, orgId, uid);
  if (!membership) fail("You are not a member of this organisation.", 403);
  if (allowedRoles.length && !allowedRoles.includes(membership.role)) {
    fail("Your role cannot perform this action.", 403);
  }
  return membership;
}

async function createOrganisation(db, user, body) {
  if (user.email_verified !== true) fail("Verify your email before creating an organisation.", 403);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) fail("Organisation name must be 1 to 80 characters.");
  const orgRef = db.collection("organisations").doc();
  const memberRef = orgRef.collection("members").doc(user.uid);
  const now = new Date();
  await db.runTransaction(async (tx) => {
    tx.create(orgRef, {
      name,
      ownerUid: user.uid,
      status: "active",
      plan: "free",
      createdAt: now,
      updatedAt: now
    });
    tx.create(memberRef, {
      uid: user.uid,
      email: String(user.email || "").toLowerCase(),
      role: "owner",
      status: "active",
      joinedAt: now
    });
  });
  return { id: orgRef.id, name, role: "owner", status: "active" };
}

async function listOrganisations(db, uid) {
  const memberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  const rows = await Promise.all(memberships.docs.filter((doc) => doc.data().status === "active").map(async (memberDoc) => {
    const orgRef = memberDoc.ref.parent.parent;
    if (!orgRef) return null;
    const org = await orgRef.get();
    if (!org.exists || org.data().status !== "active") return null;
    return { id: org.id, ...org.data(), role: memberDoc.data().role };
  }));
  return rows.filter(Boolean);
}

async function createInvitation(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin"]);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = body.role || "agent";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    fail("A valid email address is required.");
  }
  if (!["admin", "manager", "agent"].includes(role)) {
    fail("Invitation role must be admin, manager, or agent.");
  }
  const invitationId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await db.collection("organisations").doc(orgId).collection("invitations").doc(invitationId).create({
    email,
    role,
    status: "pending",
    createdBy: user.uid,
    createdAt: now,
    expiresAt
  });
  return { invitationId, email, role, expiresAt: expiresAt.toISOString() };
}

async function acceptInvitation(db, user, orgId, body) {
  if (!user.email || user.email_verified !== true) {
    fail("Verify your email before accepting an organisation invitation.", 403);
  }
  const invitationId = typeof body.invitationId === "string" ? body.invitationId : "";
  if (!/^[0-9a-f-]{36}$/i.test(invitationId)) fail("A valid invitation ID is required.");
  const orgRef = db.collection("organisations").doc(orgId);
  const inviteRef = orgRef.collection("invitations").doc(invitationId);
  const memberRef = orgRef.collection("members").doc(user.uid);
  const now = new Date();
  let role;
  await db.runTransaction(async (tx) => {
    const [orgSnap, inviteSnap, memberSnap] = await Promise.all([
      tx.get(orgRef), tx.get(inviteRef), tx.get(memberRef)
    ]);
    if (!orgSnap.exists || orgSnap.data().status !== "active") fail("Organisation was not found.", 404);
    if (!inviteSnap.exists) fail("Invitation was not found.", 404);
    const invite = inviteSnap.data();
    if (invite.status !== "pending") fail("This invitation is no longer available.", 409);
    if (invite.expiresAt?.toDate && invite.expiresAt.toDate() < now) fail("This invitation has expired.", 410);
    if (String(invite.email).toLowerCase() !== String(user.email).toLowerCase()) {
      fail("This invitation belongs to a different email address.", 403);
    }
    if (memberSnap.exists && memberSnap.data().status === "active") {
      fail("You are already a member of this organisation.", 409);
    }
    role = invite.role;
    tx.set(memberRef, {
      uid: user.uid,
      email: String(user.email).toLowerCase(),
      role,
      status: "active",
      joinedAt: now
    });
    tx.update(inviteRef, { status: "accepted", acceptedBy: user.uid, acceptedAt: now });
  });
  return { organisationId: orgId, role, status: "active" };
}


function getEncryptionKey() {
  const value = String(process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    fail("WhatsApp credential encryption is not configured on the server.", 503);
  }
  return Buffer.from(value, "hex");
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

function decryptSecret(record) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(record.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

async function saveWhatsAppConnection(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin"]);
  const phoneNumberId = String(body.phoneNumberId || "").trim();
  const wabaId = String(body.wabaId || "").trim();
  const accessToken = String(body.accessToken || "").trim();
  if (!/^\d{5,30}$/.test(phoneNumberId) || !/^\d{5,30}$/.test(wabaId)) {
    fail("Valid WhatsApp Phone Number ID and WhatsApp Business Account ID are required.");
  }
  if (accessToken.length < 40 || accessToken.length > 4096 || /\s/.test(accessToken)) {
    fail("A valid permanent or system-user access token is required.");
  }

  const graphVersion = process.env.GRAPH_API_VERSION || "v26.0";
  const response = await fetch(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || String(result.id) !== phoneNumberId) {
    fail(String(result?.error?.message || "Meta could not verify this WhatsApp number and token.").slice(0, 300), 400);
  }

  const wabaResponse = await fetch(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const wabaResult = await wabaResponse.json().catch(() => ({}));
  const belongsToWaba = Array.isArray(wabaResult.data) && wabaResult.data.some((item) => String(item.id) === phoneNumberId);
  if (!wabaResponse.ok || !belongsToWaba) {
    fail(String(wabaResult?.error?.message || "The Phone Number ID is not accessible under the supplied WABA ID.").slice(0, 300), 400);
  }

  const encrypted = encryptSecret(accessToken);
  const webhookVerifyToken = crypto.randomBytes(32).toString("hex");
  const webhookVerifyTokenHash = crypto.createHash("sha256").update(webhookVerifyToken).digest("hex");
  const now = new Date();
  const ref = db.collection("organisations").doc(orgId).collection("whatsappConnections").doc("primary");
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const oldPhoneId = current.exists ? current.data().phoneNumberId : null;
    const phoneRef = db.collection("whatsappPhoneNumbers").doc(phoneNumberId);
    const phoneSnapshot = await tx.get(phoneRef);
    if (phoneSnapshot.exists && phoneSnapshot.data().orgId !== orgId) {
      fail("This WhatsApp number is already connected to another organisation.", 409);
    }
    if (oldPhoneId && oldPhoneId !== phoneNumberId) {
      tx.delete(db.collection("whatsappPhoneNumbers").doc(oldPhoneId));
    }
    tx.set(ref, {
      phoneNumberId,
      wabaId,
      accessTokenEncrypted: encrypted,
      webhookVerifyTokenHash,
      displayPhoneNumber: String(result.display_phone_number || ""),
      verifiedName: String(result.verified_name || ""),
      status: "credentials_verified",
      updatedAt: now,
      updatedBy: user.uid,
      ...(current.exists ? {} : { createdAt: now })
    }, { merge: true });
    tx.set(phoneRef, { orgId, connectionId: "primary", updatedAt: now });
  });
  return {
    organisationId: orgId,
    phoneNumberId,
    wabaId,
    displayPhoneNumber: String(result.display_phone_number || ""),
    verifiedName: String(result.verified_name || ""),
    status: "credentials_verified",
    webhookVerifyToken
  };
}

async function getWhatsAppConnection(db, user, orgId) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager"]);
  const snapshot = await db.collection("organisations").doc(orgId)
    .collection("whatsappConnections").doc("primary").get();
  if (!snapshot.exists) return { connected: false };
  const data = snapshot.data();
  return {
    connected: data.status === "credentials_verified",
    phoneNumberId: data.phoneNumberId,
    wabaId: data.wabaId,
    displayPhoneNumber: data.displayPhoneNumber || "",
    verifiedName: data.verifiedName || "",
    status: data.status,
    updatedAt: data.updatedAt || null
  };
}


async function sendOrganisationText(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  const to = normalizePhoneNumber(body.to);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!to || !/^\d{6,20}$/.test(to) || !text || text.length > 4096) {
    fail("A valid customer phone number and message text (1 to 4096 characters) are required.");
  }
  const connectionRef = db.collection("organisations").doc(orgId)
    .collection("whatsappConnections").doc("primary");
  const connectionSnapshot = await connectionRef.get();
  if (!connectionSnapshot.exists || connectionSnapshot.data().status !== "credentials_verified") {
    fail("This organisation has no verified WhatsApp Cloud API connection.", 409);
  }
  const connection = connectionSnapshot.data();
  const accessToken = decryptSecret(connection.accessTokenEncrypted);
  const result = await sendWhatsAppText(to, text, undefined, {
    accessToken,
    phoneNumberId: connection.phoneNumberId
  });
  const timestamp = new Date();
  const chatRef = db.collection("organisations").doc(orgId).collection("chats").doc(to);
  await db.runTransaction(async (tx) => {
    const chat = await tx.get(chatRef);
    tx.create(chatRef.collection("messages").doc(result.messageId), {
      messageId: result.messageId,
      chatId: to,
      direction: "outgoing",
      type: "text",
      text,
      timestamp,
      status: "sent",
      source: "manual",
      sender: user.uid
    });
    tx.set(chatRef, {
      organisationId: orgId,
      customerPhone: to,
      lastMessage: text,
      lastMessageAt: timestamp,
      lastMessageDirection: "outgoing",
      updatedAt: timestamp
    }, { merge: true });
  });
  return { messageId: result.messageId, chatId: to, status: "sent" };
}


async function updateOrganisationChat(db, user, orgId, chatId, body, action) {
  const membership = await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  if (!/^\d{6,20}$/.test(chatId)) fail("A valid customer phone number is required.");
  const chatRef = db.collection("organisations").doc(orgId).collection("chats").doc(chatId);
  const chatSnapshot = await chatRef.get();
  if (!chatSnapshot.exists) fail("Conversation was not found.", 404);

  if (action === "assignment") {
    const updates = { updatedAt: new Date() };
    if (Object.prototype.hasOwnProperty.call(body, "assignedToUid")) {
      const assignedToUid = body.assignedToUid === null ? "" : String(body.assignedToUid || "");
      if (membership.role === "agent" && assignedToUid !== user.uid) {
        fail("Agents can only assign conversations to themselves.", 403);
      }
      let assignedToEmail = "";
      if (assignedToUid) {
        const target = await getMembership(db, orgId, assignedToUid);
        if (!target) fail("The selected team member is not active in this organisation.", 404);
        assignedToEmail = target.email || "";
      }
      updates.assignedToUid = assignedToUid || null;
      updates.assignedToEmail = assignedToEmail || null;
      updates.assignedAt = new Date();
      updates.assignedBy = user.uid;
    }
    if (body.status !== undefined) {
      if (!["open", "pending", "resolved"].includes(body.status)) fail("Status must be open, pending or resolved.");
      updates.status = body.status;
    }
    if (Object.keys(updates).length === 1) fail("No conversation assignment or status changes were provided.");
    await chatRef.set(updates, { merge: true });
    return {
      assignedToUid: updates.assignedToUid ?? chatSnapshot.data().assignedToUid ?? null,
      assignedToEmail: updates.assignedToEmail ?? chatSnapshot.data().assignedToEmail ?? null,
      status: updates.status || chatSnapshot.data().status || "open"
    };
  }

  if (action === "note") {
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 2000) fail("Internal note must contain 1 to 2000 characters.");
    const noteRef = chatRef.collection("internalNotes").doc();
    await noteRef.create({
      content,
      authorUid: user.uid,
      authorEmail: String(user.email || ""),
      createdAt: new Date()
    });
    return { id: noteRef.id, content };
  }

  if (action === "tags") {
    if (!["owner", "admin", "manager"].includes(membership.role)) fail("Only managers can edit conversation tags.", 403);
    if (!Array.isArray(body.tags) || body.tags.length > 20 ||
      body.tags.some((tag) => typeof tag !== "string" || !/^[a-z0-9_-]{1,24}$/i.test(tag)) ||
      new Set(body.tags).size !== body.tags.length) {
      fail("Provide up to 20 unique tags using letters, numbers, underscore or hyphen.");
    }
    await chatRef.set({ tags: body.tags, updatedAt: new Date() }, { merge: true });
    return { tags: body.tags };
  }
  fail("Unsupported conversation action.", 400);
}

async function listOrganisationNotes(db, user, orgId, chatId) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  if (!/^\d{6,20}$/.test(chatId)) fail("A valid customer phone number is required.");
  const snapshot = await db.collection("organisations").doc(orgId)
    .collection("chats").doc(chatId).collection("internalNotes")
    .orderBy("createdAt", "desc").limit(50).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}


async function listOrganisationQuickReplies(db, user, orgId) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  const snapshot = await db.collection("organisations").doc(orgId)
    .collection("quickReplies").orderBy("shortcut").limit(500).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function saveOrganisationQuickReply(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager"]);
  const shortcut = String(body.shortcut || "").trim().replace(/^\/+/, "").toLowerCase();
  const title = String(body.title || "").trim();
  const text = String(body.text || "").trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(shortcut)) fail("Shortcut must be 2-32 letters, numbers, underscores or hyphens.");
  if (!title || title.length > 80 || !text || text.length > 4096) {
    fail("A title (max 80) and reply text (max 4096) are required.");
  }
  const ref = db.collection("organisations").doc(orgId).collection("quickReplies").doc(shortcut);
  const now = new Date();
  await ref.set({
    shortcut, title, text,
    createdBy: user.uid,
    updatedBy: user.uid,
    updatedAt: now,
    createdAt: now
  }, { merge: true });
  return { id: shortcut, shortcut, title, text };
}

async function deleteOrganisationQuickReply(db, user, orgId, shortcut) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager"]);
  if (!/^[a-z0-9_-]{2,32}$/.test(shortcut)) fail("Invalid quick reply shortcut.");
  const ref = db.collection("organisations").doc(orgId).collection("quickReplies").doc(shortcut);
  const snapshot = await ref.get();
  if (!snapshot.exists) fail("Quick reply was not found.", 404);
  await ref.delete();
  return { deleted: shortcut };
}


async function sendOrganisationMedia(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  const to = normalizePhoneNumber(body.to);
  const type = String(body.type || "");
  const caption = String(body.caption || "").trim();
  const filename = String(body.filename || "attachment").replace(/[\\\\/\r\n]/g, "_").slice(0, 180);
  const mimeType = String(body.mimeType || "");
  const encoded = String(body.fileBase64 || "");
  if (!/^\d{6,20}$/.test(to) || !["image", "video", "audio", "document"].includes(type)) {
    fail("A valid recipient and supported media type are required.");
  }
  const allowed = {
    image: ["image/jpeg", "image/png"],
    video: ["video/mp4", "video/3gpp"],
    audio: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"],
    document: ["application/pdf", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"]
  };
  if (!allowed[type].includes(mimeType)) fail("This media type is not supported for WhatsApp " + type + " messages.");
  if (!encoded || encoded.length > 4_200_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail("Media payload is invalid or exceeds 3 MB.");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > 3 * 1024 * 1024 || buffer.toString("base64") !== encoded) {
    fail("Media payload is invalid or exceeds 3 MB.");
  }
  if (caption.length > 1024 || (type === "audio" && caption)) fail("Caption is invalid for this media type.");

  const connectionSnapshot = await db.collection("organisations").doc(orgId)
    .collection("whatsappConnections").doc("primary").get();
  if (!connectionSnapshot.exists || connectionSnapshot.data().status !== "credentials_verified") {
    fail("This organisation has no verified WhatsApp Cloud API connection.", 409);
  }
  const connection = connectionSnapshot.data();
  const accessToken = decryptSecret(connection.accessTokenEncrypted);
  const graphVersion = process.env.GRAPH_API_VERSION || "v26.0";
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  const uploadResponse = await fetch(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(connection.phoneNumberId)}/media`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form }
  );
  const uploadResult = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !uploadResult.id) {
    fail(String(uploadResult?.error?.message || "WhatsApp media upload failed.").slice(0, 300), 502);
  }
  const sent = await sendWhatsAppMedia(to, type, uploadResult.id, caption, filename, undefined, {
    accessToken, phoneNumberId: connection.phoneNumberId
  });
  const timestamp = new Date();
  const preview = caption || (type[0].toUpperCase() + type.slice(1));
  const chatRef = db.collection("organisations").doc(orgId).collection("chats").doc(to);
  await db.runTransaction(async (tx) => {
    tx.create(chatRef.collection("messages").doc(sent.messageId), {
      messageId: sent.messageId,
      chatId: to,
      direction: "outgoing",
      type,
      text: caption,
      timestamp,
      status: "sent",
      source: "manual",
      sender: user.uid,
      mediaRetained: false
    });
    tx.set(chatRef, {
      organisationId: orgId,
      customerPhone: to,
      lastMessage: preview,
      lastMessageAt: timestamp,
      lastMessageDirection: "outgoing",
      updatedAt: timestamp
    }, { merge: true });
  });
  return { messageId: sent.messageId, chatId: to, status: "sent", mediaRetained: false };
}


async function getOrganisationCredentials(db, orgId) {
  const snapshot = await db.collection("organisations").doc(orgId)
    .collection("whatsappConnections").doc("primary").get();
  if (!snapshot.exists || snapshot.data().status !== "credentials_verified") {
    fail("This organisation has no verified WhatsApp Cloud API connection.", 409);
  }
  const connection = snapshot.data();
  return { accessToken: decryptSecret(connection.accessTokenEncrypted), phoneNumberId: connection.phoneNumberId };
}

async function saveStructuredOutgoingMessage(db, user, orgId, to, messageId, type, text, payload) {
  const timestamp = new Date();
  const chatRef = db.collection("organisations").doc(orgId).collection("chats").doc(to);
  await db.runTransaction(async (tx) => {
    tx.create(chatRef.collection("messages").doc(messageId), {
      messageId, chatId: to, direction: "outgoing", type, text, payload,
      timestamp, status: "sent", source: "manual", sender: user.uid
    });
    tx.set(chatRef, {
      organisationId: orgId, customerPhone: to,
      lastMessage: text || (type === "template" ? "Template message" : "Interactive message"),
      lastMessageAt: timestamp, lastMessageDirection: "outgoing", updatedAt: timestamp
    }, { merge: true });
  });
}

async function sendOrganisationTemplate(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  const to = normalizePhoneNumber(body.to);
  const name = String(body.name || "").trim();
  const language = String(body.language || "en_US").trim();
  const parameters = body.bodyParameters === undefined ? [] : body.bodyParameters;
  if (!/^\d{6,20}$/.test(to) || !/^[a-zA-Z0-9_]{1,512}$/.test(name) ||
      !/^[a-z]{2,3}_[A-Z]{2}$/.test(language) || !Array.isArray(parameters) || parameters.length > 20 ||
      parameters.some((value) => typeof value !== "string" || value.length > 1024)) {
    fail("Provide a valid recipient, approved template name, language and up to 20 text parameters.");
  }
  const template = { name, language: { code: language } };
  if (parameters.length) {
    template.components = [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }];
  }
  const credentials = await getOrganisationCredentials(db, orgId);
  const sent = await sendWhatsAppPayload(to, "template", template, credentials);
  const preview = parameters.length ? parameters.join(" · ").slice(0, 500) : name;
  await saveStructuredOutgoingMessage(db, user, orgId, to, sent.messageId, "template", preview, template);
  return { messageId: sent.messageId, chatId: to, status: "sent" };
}

async function sendOrganisationInteractive(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  const to = normalizePhoneNumber(body.to);
  const kind = String(body.kind || "");
  const messageBody = String(body.body || "").trim();
  const header = String(body.header || "").trim();
  const footer = String(body.footer || "").trim();
  if (!/^\d{6,20}$/.test(to) || !["button", "list"].includes(kind) ||
      !messageBody || messageBody.length > 1024 || header.length > 60 || footer.length > 60) {
    fail("Provide a valid recipient and interactive message content.");
  }
  let interactive;
  if (kind === "button") {
    if (!Array.isArray(body.buttons) || body.buttons.length < 1 || body.buttons.length > 3) {
      fail("Reply-button messages require 1 to 3 buttons.");
    }
    const buttons = body.buttons.map((button) => ({
      type: "reply",
      reply: { id: String(button.id || "").trim(), title: String(button.title || "").trim() }
    }));
    if (buttons.some((button) => !/^[A-Za-z0-9_-]{1,256}$/.test(button.reply.id) ||
      !button.reply.title || button.reply.title.length > 20)) {
      fail("Each reply button needs a unique short ID and a title of up to 20 characters.");
    }
    if (new Set(buttons.map((button) => button.reply.id)).size !== buttons.length) fail("Button IDs must be unique.");
    interactive = { type: "button", body: { text: messageBody }, action: { buttons } };
  } else {
    const sections = body.sections;
    if (!Array.isArray(sections) || sections.length < 1 || sections.length > 10) {
      fail("List messages require 1 to 10 sections.");
    }
    let totalRows = 0;
    const safeSections = sections.map((section, index) => {
      const title = String(section.title || `Options ${index + 1}`).trim();
      if (!Array.isArray(section.rows) || section.rows.length < 1 || title.length > 24) {
        fail("Each list section needs rows and a title of up to 24 characters.");
      }
      const rows = section.rows.map((row) => ({
        id: String(row.id || "").trim(),
        title: String(row.title || "").trim(),
        ...(row.description ? { description: String(row.description).trim() } : {})
      }));
      totalRows += rows.length;
      if (rows.some((row) => !/^[A-Za-z0-9_-]{1,200}$/.test(row.id) ||
        !row.title || row.title.length > 24 || (row.description && row.description.length > 72))) {
        fail("List rows need a valid ID, title (up to 24) and description (up to 72).");
      }
      return { title, rows };
    });
    if (totalRows > 10) fail("A WhatsApp list can contain at most 10 rows in total.");
    const buttonText = String(body.buttonText || "View options").trim();
    if (!buttonText || buttonText.length > 20) fail("List button text must be 1 to 20 characters.");
    interactive = { type: "list", body: { text: messageBody }, action: { button: buttonText, sections: safeSections } };
  }
  if (header) interactive.header = { type: "text", text: header };
  if (footer) interactive.footer = { text: footer };
  const credentials = await getOrganisationCredentials(db, orgId);
  const sent = await sendWhatsAppPayload(to, "interactive", interactive, credentials);
  await saveStructuredOutgoingMessage(db, user, orgId, to, sent.messageId, "interactive", messageBody, interactive);
  return { messageId: sent.messageId, chatId: to, status: "sent" };
}


async function listOrganisationCampaigns(db, user, orgId) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager", "agent"]);
  const snapshot = await db.collection("organisations").doc(orgId)
    .collection("campaigns").orderBy("updatedAt", "desc").limit(100).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function createOrganisationCampaign(db, user, orgId, body) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager"]);
  const title = String(body.title || "").trim();
  const templateName = String(body.templateName || "").trim();
  const language = String(body.language || "en_US").trim();
  const parameters = body.bodyParameters === undefined ? [] : body.bodyParameters;
  if (!title || title.length > 100 || !/^[a-zA-Z0-9_]{1,512}$/.test(templateName) ||
      !/^[a-z]{2,3}_[A-Z]{2}$/.test(language) || !Array.isArray(parameters) ||
      parameters.length > 20 || parameters.some((value) => typeof value !== "string" || value.length > 1024)) {
    fail("Provide a campaign title, approved template name, language and up to 20 text parameters.");
  }
  const ref = db.collection("organisations").doc(orgId).collection("campaigns").doc();
  const now = new Date();
  const campaign = {
    title, templateName, language, bodyParameters: parameters,
    audience: { consentRequired: true, tags: Array.isArray(body.tags) ? body.tags.slice(0, 20) : [] },
    status: "draft", createdBy: user.uid, createdAt: now, updatedAt: now
  };
  await ref.create(campaign);
  return { id: ref.id, ...campaign };
}

async function previewOrganisationCampaign(db, user, orgId, campaignId) {
  await requireMembership(db, orgId, user.uid, ["owner", "admin", "manager"]);
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(campaignId)) fail("A valid campaign ID is required.");
  const campaignRef = db.collection("organisations").doc(orgId).collection("campaigns").doc(campaignId);
  const campaignSnapshot = await campaignRef.get();
  if (!campaignSnapshot.exists) fail("Campaign was not found.", 404);
  const campaign = campaignSnapshot.data();
  const contacts = await db.collection("organisations").doc(orgId).collection("contacts").limit(5000).get();
  const requiredTags = Array.isArray(campaign.audience?.tags) ? campaign.audience.tags : [];
  const eligible = contacts.docs.filter((doc) => {
    const contact = doc.data();
    if (contact.whatsappOptIn !== true || !contact.whatsappOptInAt) return false;
    const tags = Array.isArray(contact.tags) ? contact.tags : [];
    return requiredTags.every((tag) => tags.includes(tag));
  });
  return {
    campaignId,
    eligibleCount: eligible.length,
    excludedCount: contacts.size - eligible.length,
    requiresExplicitConsent: true,
    sendingEnabled: false,
    message: "Preview only. Campaign delivery is not enabled yet; no WhatsApp messages were sent."
  };
}

async function handleTenantRoute(event) {
  const method = getMethod(event);
  const path = getPath(event).replace(/\/$/, "") || "/";
  const isCollection = path === "/organisations";
  const inviteMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/invitations$/);
  const acceptMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/invitations\/accept$/);
  const membersMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/members$/);
  const whatsappMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/whatsapp-connection$/);
  const orgMessagesMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/messages$/);
  const orgTemplateMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/messages\/template$/);
  const orgInteractiveMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/messages\/interactive$/);
  const orgMediaMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/media$/);
  const orgChatActionMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/chats\/(\d{6,20})\/(assignment|notes|tags)$/);
  const quickRepliesMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/quick-replies(?:\/([a-z0-9_-]{2,32}))?$/);\n  const campaignsMatch = path.match(/^\\/organisations\\/([A-Za-z0-9_-]{10,40})\\/campaigns(?:\\/([A-Za-z0-9_-]{10,40})\\/preview)?$/);
  const campaignsMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/campaigns(?:\/([A-Za-z0-9_-]{10,40})\/preview)?$/);
  if (!(isCollection || inviteMatch || acceptMatch || membersMatch || whatsappMatch || orgMessagesMatch || orgTemplateMatch || orgInteractiveMatch || orgMediaMatch || orgChatActionMatch || quickRepliesMatch || campaignsMatch)) return null;

  try {
    const user = await authenticate(event);
    const db = getDb();
    if (isCollection && method === "POST") {
      const result = await createOrganisation(db, user, parseBody(event));
      return jsonResponse(event, 201, { success: true, organisation: result });
    }
    if (isCollection && method === "GET") {
      const organisations = await listOrganisations(db, user.uid);
      return jsonResponse(event, 200, { organisations });
    }
    if (inviteMatch && method === "POST") {
      const result = await createInvitation(db, user, inviteMatch[1], parseBody(event));
      return jsonResponse(event, 201, { success: true, invitation: result });
    }
    if (acceptMatch && method === "POST") {
      const result = await acceptInvitation(db, user, acceptMatch[1], parseBody(event));
      return jsonResponse(event, 200, { success: true, membership: result });
    }


    if (campaignsMatch && method === "GET" && !campaignsMatch[2]) {
      const campaigns = await listOrganisationCampaigns(db, user, campaignsMatch[1]);
      return jsonResponse(event, 200, { campaigns });
    }
    if (campaignsMatch && method === "POST" && !campaignsMatch[2]) {
      const campaign = await createOrganisationCampaign(db, user, campaignsMatch[1], parseBody(event));
      return jsonResponse(event, 201, { success: true, campaign });
    }
    if (campaignsMatch && method === "GET" && campaignsMatch[2]) {
      const preview = await previewOrganisationCampaign(db, user, campaignsMatch[1], campaignsMatch[2]);
      return jsonResponse(event, 200, { preview });
    }
    if (quickRepliesMatch && method === "GET" && !quickRepliesMatch[2]) {
      const quickReplies = await listOrganisationQuickReplies(db, user, quickRepliesMatch[1]);
      return jsonResponse(event, 200, { quickReplies });
    }
    if (quickRepliesMatch && method === "POST" && !quickRepliesMatch[2]) {
      const quickReply = await saveOrganisationQuickReply(db, user, quickRepliesMatch[1], parseBody(event));
      return jsonResponse(event, 201, { success: true, quickReply });
    }
    if (quickRepliesMatch && method === "DELETE" && quickRepliesMatch[2]) {
      const result = await deleteOrganisationQuickReply(db, user, quickRepliesMatch[1], quickRepliesMatch[2]);
      return jsonResponse(event, 200, { success: true, result });
    }
    if (orgChatActionMatch && orgChatActionMatch[3] === "notes" && method === "GET") {
      const notes = await listOrganisationNotes(db, user, orgChatActionMatch[1], orgChatActionMatch[2]);
      return jsonResponse(event, 200, { notes });
    }
    if (orgChatActionMatch && method === "POST") {
      const action = orgChatActionMatch[3] === "notes" ? "note" : orgChatActionMatch[3];
      const result = await updateOrganisationChat(db, user, orgChatActionMatch[1], orgChatActionMatch[2], parseBody(event), action);
      return jsonResponse(event, 200, { success: true, result });
    }
    if (orgTemplateMatch && method === "POST") {
      const result = await sendOrganisationTemplate(db, user, orgTemplateMatch[1], parseBody(event));
      return jsonResponse(event, 200, { success: true, message: result });
    }
    if (orgInteractiveMatch && method === "POST") {
      const result = await sendOrganisationInteractive(db, user, orgInteractiveMatch[1], parseBody(event));
      return jsonResponse(event, 200, { success: true, message: result });
    }
    if (orgMediaMatch && method === "POST") {
      const result = await sendOrganisationMedia(db, user, orgMediaMatch[1], parseBody(event));
      return jsonResponse(event, 200, { success: true, message: result });
    }
    if (orgMessagesMatch && method === "POST") {
      const result = await sendOrganisationText(db, user, orgMessagesMatch[1], parseBody(event));
      return jsonResponse(event, 200, { success: true, message: result });
    }
    if (whatsappMatch && method === "GET") {
      const result = await getWhatsAppConnection(db, user, whatsappMatch[1]);
      return jsonResponse(event, 200, result);
    }
    if (whatsappMatch && method === "POST") {
      const result = await saveWhatsAppConnection(db, user, whatsappMatch[1], parseBody(event));
      return jsonResponse(event, 200, { success: true, connection: result });
    }
    if (membersMatch && method === "GET") {
      await requireMembership(db, membersMatch[1], user.uid, ["owner", "admin", "manager", "agent"]);
      const snapshot = await db.collection("organisations").doc(membersMatch[1]).collection("members").where("status", "==", "active").get();
      const members = snapshot.docs.map((doc) => ({
        uid: doc.id,
        email: doc.data().email || "",
        role: doc.data().role,
        status: doc.data().status,
        joinedAt: doc.data().joinedAt || null
      }));
      return jsonResponse(event, 200, { members });
    }
    return jsonResponse(event, 405, { error: "Method not allowed." });
  } catch (error) {
    return jsonResponse(event, error.statusCode || 500, {
      error: error.statusCode ? error.message : "Organisation request could not be completed."
    });
  }
}

module.exports = { handleTenantRoute };
