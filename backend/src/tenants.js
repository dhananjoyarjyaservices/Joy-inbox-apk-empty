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

async function handleTenantRoute(event) {
  const method = getMethod(event);
  const path = getPath(event).replace(/\/$/, "") || "/";
  const isCollection = path === "/organisations";
  const inviteMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/invitations$/);
  const acceptMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/invitations\/accept$/);
  const membersMatch = path.match(/^\/organisations\/([A-Za-z0-9_-]{10,40})\/members$/);
  if (!(isCollection || inviteMatch || acceptMatch || membersMatch)) return null;

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
    if (membersMatch && method === "GET") {
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
