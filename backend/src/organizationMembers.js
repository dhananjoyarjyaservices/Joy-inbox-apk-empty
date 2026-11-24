const { getBillingPlanCatalog } = require("./billing");

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validUid(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

async function writeMemberAudit(organization, actor, action, target, details = {}) {
  try {
    const auditRef = organization.ref.collection("auditLogs").doc();
    await auditRef.set({
      action,
      actorUid: String(actor?.uid || ""),
      actorEmail: String(actor?.email || ""),
      actorRole: String(actor?.role || ""),
      targetUid: String(target?.uid || ""),
      targetEmail: String(target?.email || ""),
      details,
      createdAt: new Date()
    });
  } catch (error) {
    console.error("Workspace member audit write failed:", error);
  }
}

async function listOrganizationMemberAudit(db, organization, options = {}) {
  const requestedLimit = Number(options.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 25;
  const cursor = options.cursor || "";
  if (cursor && !/^[A-Za-z0-9_-]{1,150}$/.test(cursor)) {
    throw httpError("A valid activity page cursor is required.", 400);
  }
  const auditRef = organization.ref.collection("auditLogs");
  let query = auditRef.orderBy("createdAt", "desc");
  if (cursor) {
    const cursorSnapshot = await auditRef.doc(cursor).get();
    if (!cursorSnapshot.exists) throw httpError("The activity page cursor is no longer valid. Refresh the history.", 400);
    query = query.startAfter(cursorSnapshot);
  }
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const pageDocs = snapshot.docs.slice(0, limit);
  return {
    events: pageDocs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        action: String(data.action || ""),
        actorUid: String(data.actorUid || ""),
        actorEmail: String(data.actorEmail || ""),
        actorRole: String(data.actorRole || ""),
        targetUid: String(data.targetUid || ""),
        targetEmail: String(data.targetEmail || ""),
        details: data.details && typeof data.details === "object" ? data.details : {},
        createdAt: data.createdAt || null
      };
    }),
    nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null
  };
}

function requireManager(actor) {
  if (!actor || !["owner", "admin"].includes(actor.role)) {
    throw httpError("Only organization owners and admins can manage members.", 403);
  }
}

async function listOrganizationMembers(db, organization, options = {}) {
  const requestedLimit = Number(options.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 25;
  const cursor = options.cursor || "";
  if (cursor && !validUid(cursor)) throw httpError("A valid member page cursor is required.", 400);

  const membersRef = organization.ref.collection("members");
  let query = membersRef.orderBy("__name__");
  if (cursor) {
    const cursorSnapshot = await membersRef.doc(cursor).get();
    if (!cursorSnapshot.exists) throw httpError("The member page cursor is no longer valid. Refresh the list.", 400);
    query = query.startAfter(cursorSnapshot);
  }
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const pageDocs = snapshot.docs.slice(0, limit);
  return {
    members: pageDocs.map((doc) => {
      const data = doc.data();
      return {
        uid: doc.id,
        email: String(data.email || ""),
        displayName: String(data.displayName || ""),
        role: data.role,
        status: data.status,
        joinedAt: data.joinedAt || null
      };
    }),
    nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null
  };
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
    if (error?.code === "auth/user-not-found") throw httpError("This person must create a Joy Inbox account before being added.", 404);
    if (error?.code === "auth/user-disabled") throw httpError("This Firebase account is disabled and cannot be added.", 403);
    if (error?.code === "auth/invalid-email") throw httpError("Firebase could not verify this email address.", 400);
    if (["auth/too-many-requests", "auth/internal-error", "auth/network-request-failed"].includes(error?.code)) {
      throw httpError("Firebase account lookup is temporarily unavailable. Please try again.", 503);
    }
    throw httpError("Firebase account lookup failed. Please try again later.", 502);
  }
  if (!user || !validUid(user.uid)) throw httpError("Firebase returned an invalid user account.", 502);
  if (user.email && typeof user.email !== "string") throw httpError("Firebase returned invalid account details.", 502);
  const ref = organization.ref.collection("members").doc(user.uid);
  const indexRef = db.collection("users").doc(user.uid).collection("organizations").doc(organization.id);
  const now = new Date();
  const subscriptionRef = organization.ref.collection("billing").doc("subscription");
  const activeMembersQuery = organization.ref.collection("members").where("status", "==", "active");
  await db.runTransaction(async (transaction) => {
    const [existing, subscriptionSnapshot, activeMembersSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(subscriptionRef),
      transaction.get(activeMembersQuery)
    ]);
    if (existing.exists && existing.data().status === "active") {
      throw httpError("This person is already an active organization member.", 409);
    }
    if (subscriptionSnapshot.exists) {
      const subscription = subscriptionSnapshot.data() || {};
      if (["active", "trialing"].includes(String(subscription.status || ""))) {
        const plan = getBillingPlanCatalog().find(item => item.key === String(subscription.plan || ""));
        if (!plan) throw httpError("The workspace plan could not be verified. Member changes are paused.", 503);
        const activeSeatCount = activeMembersSnapshot.docs.filter(document =>
          ["owner", "admin", "agent"].includes(String(document.data()?.role || ""))
        ).length;
        if (activeSeatCount >= plan.limits.agents) {
          throw httpError(`The ${plan.name} plan allows ${plan.limits.agents} active team seat(s). Upgrade the plan before adding another member.`, 409);
        }
      }
    }
    transaction.set(ref, {
      uid: user.uid,
      email: user.email || email,
      displayName: user.displayName || "",
      role,
      status: "active",
      joinedAt: now,
      removedAt: null,
      updatedAt: now
    }, { merge: true });
    transaction.set(indexRef, {
      organizationId: organization.id,
      name: organization.name || "",
      role,
      status: "active",
      removedAt: null,
      createdAt: now
    }, { merge: true });
  });
  await writeMemberAudit(organization, actor, "member.added", {
    uid: user.uid, email: user.email || email
  }, { role });
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
  let targetEmail = "";
  await organization.ref.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().status !== "active") throw httpError("Active member was not found.", 404);
    if (snapshot.data().role === "owner") throw httpError("The owner role cannot be changed.", 403);
    if (snapshot.data().role === "admin" && actor.role !== "owner") {
      throw httpError("Only the organization owner can change another admin's role.", 403);
    }
    targetEmail = String(snapshot.data().email || "");
    transaction.set(ref, { role, updatedAt: new Date() }, { merge: true });
    transaction.set(indexRef, { role }, { merge: true });
  });
  await writeMemberAudit(organization, actor, "member.role_changed", { uid, email: targetEmail }, { role });
  return { uid, role };
}

async function removeOrganizationMember(organization, actor, input) {
  requireManager(actor);
  const uid = input?.uid;
  if (!validUid(uid)) throw httpError("A valid member ID is required.", 400);
  if (uid === organization.createdBy || uid === organization.uid) throw httpError("The organization owner cannot be removed.", 403);
  const ref = organization.ref.collection("members").doc(uid);
  const indexRef = organization.ref.firestore.collection("users").doc(uid).collection("organizations").doc(organization.id);
  let targetEmail = "";
  await organization.ref.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().status !== "active") throw httpError("Active member was not found.", 404);
    if (snapshot.data().role === "owner") throw httpError("The owner cannot be removed.", 403);
    if (snapshot.data().role === "admin" && actor.role !== "owner") {
      throw httpError("Only the organization owner can remove another admin.", 403);
    }
    targetEmail = String(snapshot.data().email || "");
    const now = new Date();
    transaction.set(ref, { status: "removed", removedAt: now, updatedAt: now }, { merge: true });
    transaction.set(indexRef, { status: "removed" }, { merge: true });
  });
  await writeMemberAudit(organization, actor, "member.removed", { uid, email: targetEmail }, {});
  return { uid, status: "removed" };
}

module.exports = { listOrganizationMembers, listOrganizationMemberAudit, addOrganizationMember, updateOrganizationMemberRole, removeOrganizationMember };
