"use strict";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeInternalNote(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("An internal note is required.", 400);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw httpError("Internal note cannot be empty.", 400);
  if (text.length > 2000) throw httpError("Internal note must be 2000 characters or fewer.", 400);
  return { text };
}

function getInternalNotesCollection(db, organizationId, chatId) {
  if (!ID_PATTERN.test(String(organizationId || "")) || !ID_PATTERN.test(String(chatId || ""))) {
    throw httpError("A valid organization and chat ID are required.", 400);
  }
  return db.collection("organizations").doc(organizationId)
    .collection("chats").doc(chatId).collection("internalNotes");
}

async function listTenantInternalNotes(db, organizationId, chatId, limit = 100) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  const snapshot = await getInternalNotesCollection(db, organizationId, chatId)
    .orderBy("createdAt", "desc").limit(safeLimit).get();
  return snapshot.docs.map(document => {
    const value = document.data() || {};
    const createdAt = value.createdAt?.toDate ? value.createdAt.toDate().toISOString()
      : value.createdAt instanceof Date ? value.createdAt.toISOString() : value.createdAt || null;
    return { id: document.id, ...value, createdAt };
  });
}

async function addTenantInternalNote(db, organizationId, chatId, input, actor) {
  const { text } = normalizeInternalNote(input);
  if (!actor?.uid) throw httpError("Authentication required.", 401);
  const now = new Date();
  const ref = getInternalNotesCollection(db, organizationId, chatId).doc();
  const note = {
    text,
    authorUid: String(actor.uid),
    authorName: String(actor.name || actor.email || actor.uid).slice(0, 120),
    createdAt: now,
    visibility: "internal"
  };
  await ref.set(note);
  return { id: ref.id, ...note };
}

module.exports = {
  normalizeInternalNote,
  getInternalNotesCollection,
  listTenantInternalNotes,
  addTenantInternalNote
};
