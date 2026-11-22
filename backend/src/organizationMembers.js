function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validUid(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function requireManager(actor) {
  if (!actor || !["owner", "admin"].includes(actor.role)) {
    throw httpError("Only organization owners and admins can manage members.", 403);
  }
}

async function listOrganizationMembers(db, organization) {
  const snapshot = await organization.ref.collection("members").get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      uid: doc.id,
      email: String(data.email || ""),
      displayName: String(data.displayName || ""),
      role: data.role,
      status: data.status,
      joinedAt: data.joinedAt || null
    };
  });
}

async function addOrganizationMember(db, auth, organization, actor, input) {
  requireManager(actor);
  const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  const role = input?.role || "agent";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError("A valid member email is required.", 400);
  if (!["admin", "agent"].includes(role) || (role === "admin" && actor.role !== "owner")) {
    throw httpError("Only an owner can add an admin; owner role cannot be assigned.", 403);
  }
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code === "auth/user-not-found") throw httpError("This person must create a Joy Inbox account before being added.", 404);
    throw error;
  }
  if (!validUid(user.uid)) throw httpError("The selected account has an invalid user ID.", 400);
  const ref = organization.ref.collection("members").doc(user.uid);
  const existing = await ref.get();
  if (existing.exists && existing.data().status === "active") throw httpError("This person is already an active organization member.", 409);
  const now = new Date();
  await ref.set({
    uid: user.uid,
    email: user.email || email,
    displayName: user.displayName || "",
    role,
    status: "active",
    joinedAt: now,
    updatedAt: now
  }, { merge: true });
  await db.collection("users").doc(user.uid).collection("organizations").doc(organization.id).set({
    organizationId: organization.id,
    name: organization.name || "",
    role,
    status: "active",
    createdAt: now
  }, { merge: true });
  return { uid: user.uid, email: user.email || email, displayName: user.displayName || "", role, status: "active" };
}

async function updateOrganizationMemberRole(organization, actor, input) {
  requireManager(actor);
  const uid = input?.uid;
  const role = input?.role;
  if (!validUid(uid) || !["admin", "agent"].includes(role)) throw httpError("A valid member ID and admin/agent role are required.", 400);
  if (uid === organization.createdBy || (role === "admin" && actor.role !== "owner")) {
    throw httpError("Only the organization owner can assign admin, and owner role cannot be changed.", 403);
  }
  const ref = organization.ref.collection("members").doc(uid);
  const indexRef = organization.ref.firestore.collection("users").doc(uid).collection("organizations").doc(organization.id);
  await organization.ref.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().status !== "active") throw httpError("Active member was not found.", 404);
    if (snapshot.data().role === "owner") throw httpError("The owner role cannot be changed.", 403);
    transaction.set(ref, { role, updatedAt: new Date() }, { merge: true });
    transaction.set(indexRef, { role }, { merge: true });
  });
  return { uid, role };
}

async function removeOrganizationMember(organization, actor, input) {
  requireManager(actor);
  const uid = input?.uid;
  if (!validUid(uid)) throw httpError("A valid member ID is required.", 400);
  if (uid === organization.createdBy || uid === organization.uid) throw httpError("The organization owner cannot be removed.", 403);
  const ref = organization.ref.collection("members").doc(uid);
  const indexRef = organization.ref.firestore.collection("users").doc(uid).collection("organizations").doc(organization.id);
  await organization.ref.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().status !== "active") throw httpError("Active member was not found.", 404);
    if (snapshot.data().role === "owner") throw httpError("The owner cannot be removed.", 403);
    const now = new Date();
    transaction.set(ref, { status: "removed", removedAt: now, updatedAt: now }, { merge: true });
    transaction.set(indexRef, { status: "removed" }, { merge: true });
  });
  return { uid, status: "removed" };
}

module.exports = { listOrganizationMembers, addOrganizationMember, updateOrganizationMemberRole, removeOrganizationMember };
