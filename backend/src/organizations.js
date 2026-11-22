function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeOrganizationName(value) {
  if (typeof value !== "string") throw httpError("Business name is required.", 400);
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    throw httpError("Business name must be between 2 and 80 characters.", 400);
  }
  if (/[<>]/.test(name) || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw httpError("Business name contains unsupported characters.", 400);
  }
  return name;
}

function requireUid(decoded) {
  if (!decoded || typeof decoded.uid !== "string" || !decoded.uid) {
    throw httpError("Authentication required.", 401);
  }
  return decoded.uid;
}

/**
 * Creates the tenant and its first owner in one Firestore transaction.
 * The caller must pass a Firebase Admin-verified ID token payload.
 */
async function createOrganization(db, decoded, input) {
  const uid = requireUid(decoded);
  const name = normalizeOrganizationName(input?.name);
  const organizationRef = db.collection("organizations").doc();
  const memberRef = organizationRef.collection("members").doc(uid);
  const userOrganizationRef = db.collection("users").doc(uid)
    .collection("organizations").doc(organizationRef.id);
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    transaction.create(organizationRef, {
      name,
      status: "active",
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
      plan: "free"
    });
    transaction.create(memberRef, {
      uid,
      role: "owner",
      status: "active",
      joinedAt: now,
      createdAt: now
    });
    transaction.set(userOrganizationRef, {
      organizationId: organizationRef.id,
      name,
      role: "owner",
      status: "active",
      createdAt: now
    });
  });

  return { id: organizationRef.id, name, role: "owner", status: "active" };
}

async function listOrganizations(db, decoded) {
  const uid = requireUid(decoded);
  const snapshot = await db.collection("users").doc(uid)
    .collection("organizations").where("status", "==", "active").get();
  return snapshot.docs.map((document) => ({
    id: document.id,
    ...document.data()
  }));
}

module.exports = {
  createOrganization,
  listOrganizations,
  normalizeOrganizationName
};
