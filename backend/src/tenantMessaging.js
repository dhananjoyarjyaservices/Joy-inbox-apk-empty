const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function getTenantChatRef(db, organizationId, chatId) {
  return db.collection("organizations").doc(organizationId)
    .collection("chats").doc(chatId);
}

function getTenantMessageRef(db, organizationId, chatId, messageId) {
  return getTenantChatRef(db, organizationId, chatId)
    .collection("messages").doc(messageId);
}

function getTenantSendRequestRef(db, organizationId, chatId, clientMessageId) {
  return getTenantChatRef(db, organizationId, chatId)
    .collection("sendRequests").doc(clientMessageId);
}

async function claimTenantSendRequest(db, organizationId, chatId, clientMessageId, payloadHash) {
  const ref = getTenantSendRequestRef(db, organizationId, chatId, clientMessageId);
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) {
      const request = snapshot.data();
      if (request.payloadHash !== payloadHash) {
        const error = new Error("This send ID was already used for a different message.");
        error.statusCode = 409;
        error.retryable = false;
        throw error;
      }
      if (request.status === "completed") return { state: "completed", messageId: request.messageId };
      if (request.status !== "failed") return { state: "pending" };
      transaction.set(ref, {
        status: "processing",
        attempts: Number(request.attempts || 0) + 1,
        updatedAt: new Date()
      }, { merge: true });
      return { state: "claimed" };
    }
    transaction.create(ref, {
      payloadHash,
      status: "processing",
      attempts: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    return { state: "claimed" };
  });
  return { ...result, ref };
}

function getRetryableTenantTextMessage(message) {
  if (!message || message.direction !== "outgoing" || message.type !== "text" ||
      message.status !== "failed" || typeof message.text !== "string" || !message.text.trim()) {
    const error = new Error("Only failed outgoing text messages can be retried.");
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  if (typeof message.phoneNumberId !== "string" || !message.phoneNumberId.trim()) {
    const error = new Error("The original WhatsApp number is missing. Send the message manually instead.");
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  return { text: message.text.trim(), phoneNumberId: message.phoneNumberId.trim() };
}

async function resolveTenantReplyContext(db, organizationId, chatId, body) {
  const hasReplyId = body.replyToMessageId !== undefined;
  const hasLegacyContextId = body.contextMessageId !== undefined;
  if (!hasReplyId && !hasLegacyContextId) return null;
  const requestedId = hasReplyId ? body.replyToMessageId : body.contextMessageId;
  if (typeof requestedId !== "string" || !MESSAGE_ID_PATTERN.test(requestedId) ||
    (hasReplyId && hasLegacyContextId && body.replyToMessageId !== body.contextMessageId)) {
    const error = new Error("A valid reply message ID is required.");
    error.statusCode = 400;
    throw error;
  }
  const snapshot = await getTenantMessageRef(db, organizationId, chatId, requestedId).get();
  if (!snapshot.exists) {
    const error = new Error("The message being replied to was not found in this organization.");
    error.statusCode = 404;
    throw error;
  }
  const message = snapshot.data();
  const whatsappMessageId = message.messageId || snapshot.id;
  if (typeof whatsappMessageId !== "string" || !MESSAGE_ID_PATTERN.test(whatsappMessageId)) {
    throw new Error("The original message has no valid WhatsApp message ID.");
  }
  return {
    messageDocumentId: snapshot.id,
    contextMessageId: whatsappMessageId,
    text: String(message.text || ""),
    sender: message.direction === "outgoing" ? "You" : String(message.sender || chatId),
    type: String(message.type || "unknown")
  };
}

function getTenantReplyMessageFields(replyContext) {
  if (!replyContext) return {};
  return {
    replyToMessageId: replyContext.messageDocumentId,
    replyToMessageText: replyContext.text,
    replyToMessageSender: replyContext.sender,
    replyToMessageType: replyContext.type
  };
}

async function markTenantSendRequestFailed(ref, error) {
  if (!error?.definitive) return;
  await ref.set({
    status: "failed",
    error: String(error.message || "Message could not be sent.").slice(0, 300),
    updatedAt: new Date()
  }, { merge: true });
}

module.exports = {
  getTenantChatRef,
  getTenantMessageRef,
  getTenantSendRequestRef,
  claimTenantSendRequest,
  getRetryableTenantTextMessage,
  resolveTenantReplyContext,
  getTenantReplyMessageFields,
  markTenantSendRequestFailed
};
