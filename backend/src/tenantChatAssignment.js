const CHAT_ID_PATTERN = /^\\d{6,20}$/;
const UID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const CHAT_STATUSES = new Set(["open", "pending", "resolved"]);

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateChatAssignment(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.chatId !== "string" || !CHAT_ID_PATTERN.test(input.chatId)) {
    throw httpError("A valid chat ID is required.", 400);
  }
  const allowed = new Set(["chatId", "assignedTo", "status"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) ||
      (!Object.hasOwn(input, "assignedTo") && !Object.hasOwn(input, "status"))) {
    throw httpError("Provide an assignee, a conversation status, or both.", 400);
  }
  if (Object.hasOwn(input, "assignedTo") && input.assignedTo !== null &&
      (typeof input.assignedTo !== "string" || !UID_PATTERN.test(input.assignedTo))) {
    throw httpError("A valid active team member or null assignee is required.", 400);
  }
  if (Object.hasOwn(input, "status") &&
      (typeof input.status !== "string" || !CHAT_STATUSES.has(input.status))) {
    throw httpError("Conversation status must be open, pending, or resolved.", 400);
  }
  return {
    chatId: input.chatId,
    hasAssignee: Object.hasOwn(input, "assignedTo"),
    assignedTo: input.assignedTo,
    hasStatus: Object.hasOwn(input, "status"),
    status: input.status
  };
}

async function updateTenantChatAssignment(db, organization, actor, input) {
  if (!organization?.id || !organization.ref || !actor?.uid) {
    throw httpError("Workspace and actor context are required.", 400);
  }
  const parsed = validateChatAssignment(input);
  const chatRef = organization.ref.collection("chats").doc(parsed.chatId);
  const assigneeRef = parsed.hasAssignee && parsed.assignedTo !== null
    ? organization.ref.collection("members").doc(parsed.assignedTo)
    : null;
  let assignee = null;
  await db.runTransaction(async (transaction) => {
    const chatSnapshot = await transaction.get(chatRef);
    if (!chatSnapshot.exists) throw httpError("Conversation was not found.", 404);
    let memberSnapshot = null;
    if (assigneeRef) {
      memberSnapshot = await transaction.get(assigneeRef);
      if (!memberSnapshot.exists || memberSnapshot.data().status !== "active" ||
          !["owner", "admin", "agent"].includes(memberSnapshot.data().role)) {
        throw httpError("The selected assignee is not an active workspace member.", 404);
      }
      const memberData = memberSnapshot.data();
      assignee = {
        uid: parsed.assignedTo,
        email: String(memberData.email || ""),
        displayName: String(memberData.displayName || "")
      };
    }
    const now = new Date();
    const updates = { updatedAt: now };
    if (parsed.hasAssignee) {
      updates.assignedTo = parsed.assignedTo;
      updates.assignedBy = actor.uid;
      updates.assignedAt = parsed.assignedTo === null ? null : now;
      updates.assigneeName = assignee?.displayName || "";
      updates.assigneeEmail = assignee?.email || "";
    }
    if (parsed.hasStatus) {
      updates.status = parsed.status;
      updates.statusUpdatedAt = now;
      updates.statusUpdatedBy = actor.uid;
    }
    transaction.set(chatRef, updates, { merge: true });
  });
  try {
    await organization.ref.collection("auditLogs").doc().set({
      action: parsed.hasAssignee ? "chat.assigned" : "chat.status_changed",
      actorUid: actor.uid,
      actorEmail: String(actor.email || ""),
      actorRole: String(actor.role || ""),
      targetUid: assignee?.uid || "",
      targetEmail: assignee?.email || "",
      details: {
        chatId: parsed.chatId,
        ...(parsed.hasAssignee ? { assignedTo: parsed.assignedTo } : {}),
        ...(parsed.hasStatus ? { status: parsed.status } : {})
      },
      createdAt: new Date()
    });
  } catch (error) {
    console.error("Chat assignment audit write failed:", error);
  }
  return {
    chatId: parsed.chatId,
    ...(parsed.hasAssignee ? { assignedTo: parsed.assignedTo, assignee } : {}),
    ...(parsed.hasStatus ? { status: parsed.status } : {})
  };
}

module.exports = { CHAT_STATUSES, validateChatAssignment, updateTenantChatAssignment };
