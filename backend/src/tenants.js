const crypto = require("crypto");
const { getFirebaseAdmin, getDb } = require("./firebase");
const { getHeader, jsonResponse } = require("./security");

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

  const encrypted = encryptSecret(accessToken);
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
    status: "credentials_verified"
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

async function handleTenantRoute(event) {
  const method = getMethod(event);
  const path = getPath(event).replace(/\/$/, "") || "/";
  const isCollection = path === "/organisations";
  const inviteMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/invitations$/);
  const acceptMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/invitations\/accept$/);
  const membersMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/members$/);\n  const whatsappMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/whatsapp-connection$/);
  if (!(isCollection || inviteMatch || acceptMatch || membersMatch || whatsappMatch)) return null;

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
    if (whatsappMatch && method === "GET") {\n      const result = await getWhatsAppConnection(db, user, whatsappMatch[1]);\n      return jsonResponse(event, 200, result);\n    }\n    if (whatsappMatch && method === "POST") {\n      const result = await saveWhatsAppConnection(db, user, whatsappMatch[1], parseBody(event));\n      return jsonResponse(event, 200, { success: true, connection: result });\n    }\n    if (membersMatch && method === "GET") {
      await requireMembership(db, membersMatch[1], user.uid, ["owner", "admin", "manager"]);
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
