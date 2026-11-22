const CHAT_ID_PATTERN = /^\d{6,20}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateChatState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.chatId !== "string" || !CHAT_ID_PATTERN.test(input.chatId)) {
    throw httpError("A valid chat ID is required.", 400);
  }
  const allowed = ["chatId", "pinned", "archived", "markRead"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw httpError("Unsupported chat state field.", 400);
  const updates = {};
  for (const key of ["pinned", "archived", "markRead"]) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== "boolean") throw httpError(`${key} must be a boolean.`, 400);
      if (key === "markRead") {
        if (input.markRead) {
          updates.unreadCount = 0;
          updates.lastReadAt = new Date();
        }
      } else updates[key] = input[key];
    }
  }
  if (!Object.keys(updates).length) throw httpError("At least one chat state update is required.", 400);
  updates.updatedAt = new Date();
  return { chatId: input.chatId, updates };
}

function validateMessageState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 3 ||
      typeof input.chatId !== "string" || !CHAT_ID_PATTERN.test(input.chatId) ||
      typeof input.messageId !== "string" || !MESSAGE_ID_PATTERN.test(input.messageId) ||
      typeof input.pinned !== "boolean") {
    throw httpError("Valid chatId, messageId and pinned fields are required.", 400);
  }
  return {
    chatId: input.chatId,
    messageId: input.messageId,
    updates: { pinned: input.pinned, pinnedAt: input.pinned ? new Date() : null, updatedAt: new Date() }
  };
}

function validateMessageIds(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 2 ||
      typeof input.chatId !== "string" || !CHAT_ID_PATTERN.test(input.chatId) ||
      !Array.isArray(input.messageIds) || input.messageIds.length < 1 || input.messageIds.length > 50 ||
      input.messageIds.some((id) => typeof id !== "string" || !MESSAGE_ID_PATTERN.test(id)) ||
      new Set(input.messageIds).size !== input.messageIds.length) {
    throw httpError("Provide a valid chat ID and 1 to 50 unique message IDs.", 400);
  }
  return { chatId: input.chatId, messageIds: input.messageIds };
}

function validateChatIds(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !Array.isArray(input.chatIds) || input.chatIds.length < 1 || input.chatIds.length > 50 ||
      input.chatIds.some((id) => typeof id !== "string" || !CHAT_ID_PATTERN.test(id)) ||
      new Set(input.chatIds).size !== input.chatIds.length) {
    throw httpError("Provide 1 to 50 unique valid chat IDs.", 400);
  }
  return input.chatIds;
}

function tenantChatRef(db, organizationId, chatId) {
  return db.collection("organizations").doc(organizationId).collection("chats").doc(chatId);
}

async function updateTenantChatState(db, organizationId, input) {
  const { chatId, updates } = validateChatState(input);
  const ref = tenantChatRef(db, organizationId, chatId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw httpError("Conversation was not found.", 404);
  await ref.update(updates);
}

async function updateTenantMessageState(db, organizationId, input) {
  const { chatId, messageId, updates } = validateMessageState(input);
  const ref = tenantChatRef(db, organizationId, chatId).collection("messages").doc(messageId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw httpError("Message was not found.", 404);
  await ref.update(updates);
}

async function deleteTenantMessages(db, organizationId, input) {
  const { chatId, messageIds } = validateMessageIds(input);
  const chatRef = tenantChatRef(db, organizationId, chatId);
  const chat = await chatRef.get();
  if (!chat.exists) throw httpError("Conversation was not found.", 404);
  const refs = messageIds.map((id) => chatRef.collection("messages").doc(id));
  const snapshots = await Promise.all(refs.map((ref) => ref.get()));
  if (snapshots.some((snapshot) => !snapshot.exists)) throw httpError("One or more selected messages were not found.", 404);
  const batch = db.batch();
  refs.forEach((ref) => batch.delete(ref));
  await batch.commit();
  return messageIds;
}

async function deleteTenantChats(db, organizationId, input) {
  const chatIds = validateChatIds(input);
  const deletedChatIds = [];
  for (const chatId of chatIds) {
    const ref = tenantChatRef(db, organizationId, chatId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw httpError("One or more conversations were not found.", 404);
    await db.recursiveDelete(ref);
    deletedChatIds.push(chatId);
  }
  return deletedChatIds;
}

module.exports = {
  validateChatState,
  validateMessageState,
  validateMessageIds,
  validateChatIds,
  updateTenantChatState,
  updateTenantMessageState,
  deleteTenantMessages,
  deleteTenantChats
};
