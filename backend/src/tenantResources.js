const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;\nconst { normalizeCrmFieldValues } = require("./crm");

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function contactInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Contact details are required.", 400);
  const allowed = ["name", "phone", "email", "notes", "source", "tags", "customFields"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw httpError("Unsupported contact field.", 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const rawPhone = typeof input.phone === "string" ? input.phone.trim().replace(/[\s().-]/g, "") : "";
  const phone = rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const source = input.source === "whatsapp" ? "whatsapp" : "local";
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some((tag) => typeof tag !== "string" || tag.trim().length > 30))) {
    throw httpError("Contact tags must be up to 20 labels, each 30 characters or fewer.", 400);
  }
  const normalizedTags = (input.tags || []).map((tag) => tag.trim()).filter(Boolean);
  const tags = normalizedTags.filter((tag, index) => normalizedTags.findIndex((item) => item.toLowerCase() === tag.toLowerCase()) === index);
  if (!name || name.length > 100) throw httpError("Contact name is required (maximum 100 characters).", 400);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw httpError("Enter a valid international phone number.", 400);
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw httpError("Enter a valid email address.", 400);
  if (notes.length > 1000) throw httpError("Contact notes are too long.", 400);
  const result = { name, phone, phoneId: phone.slice(1), email, notes, source, tags };\n  if (input.customFields !== undefined) result.customFields = normalizeCrmFieldValues(input.customFields, arguments[1] || [], { enforceRequired: false });\n  return result;
}

function quickReplyInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Quick Reply details are required.", 400);
  const allowed = ["title", "shortcut", "message"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw httpError("Unsupported Quick Reply field.", 400);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const shortcut = typeof input.shortcut === "string" ? input.shortcut.trim().replace(/^\/+/, "").toLowerCase() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!title || title.length > 60 || message.length > 4096) throw httpError("A title is required (maximum 60 characters); message must be 4096 characters or fewer.", 400);
  if (shortcut.length > 30 || (shortcut && !/^[a-z0-9_-]+$/.test(shortcut))) throw httpError("Shortcut must use letters, numbers, underscores or hyphens (maximum 30).", 400);
  return { title, shortcut, message };
}

function getTenantResourceCollection(db, organizationId, resource) {
  if (!ID_PATTERN.test(organizationId || "")) throw httpError("A valid organization ID is required.", 400);
  if (!["contacts", "quickReplies"].includes(resource)) throw httpError("Unsupported resource.", 400);
  return db.collection("organizations").doc(organizationId).collection(resource);
}

function normalizeContactPageSize(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") return 50;
  const value = Number(rawLimit);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw httpError("Page limit must be an integer between 1 and 100.", 400);
  return value;
}

function decodeContactCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw httpError("Pagination cursor is invalid.", 400);
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw httpError("Pagination cursor is invalid.", 400); }
  if (cursor?.v !== 1 || typeof cursor.name !== "string" || !cursor.name || cursor.name.length > 100 || !ID_PATTERN.test(cursor.id || "")) {
    throw httpError("Pagination cursor is invalid.", 400);
  }
  return cursor;
}

function encodeContactCursor(document) {
  const data = document.data() || {};
  if (typeof data.name !== "string" || !data.name) throw httpError("Contact cannot be used as a pagination cursor because its name is invalid.", 500);
  return Buffer.from(JSON.stringify({ v: 1, name: data.name, id: document.id }), "utf8").toString("base64url");
}

async function listPublicContacts(db, organizationId, rawLimit = 50, rawCursor = null) {
  const limit = normalizeContactPageSize(rawLimit);
  const cursor = decodeContactCursor(rawCursor);
  let query = getTenantResourceCollection(db, organizationId, "contacts")
    .orderBy("name", "asc")
    .orderBy("__name__", "asc");
  if (cursor) query = query.startAfter(cursor.name, cursor.id);
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const docs = snapshot.docs.slice(0, limit);
  return {
    data: docs.map(document => ({ id: document.id, ...document.data() })),
    pagination: {
      limit,
      returned: docs.length,
      hasMore,
      nextCursor: hasMore && docs.length ? encodeContactCursor(docs[docs.length - 1]) : null
    }
  };
}

async function listTenantResource(db, organizationId, resource) {
  const ordered = getTenantResourceCollection(db, organizationId, resource)
    .orderBy(resource === "contacts" ? "name" : "createdAt", resource === "contacts" ? "asc" : "desc");
  // Keep the customer directory bounded, but do not impose an artificial
  // 500-item ceiling on saved Quick Replies.
  const snapshot = resource === "quickReplies"
    ? await ordered.get()
    : await ordered.limit(500).get();
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function saveTenantResource(db, organizationId, resource, input, resourceId, fieldDefinitions = []) {
  const collection = getTenantResourceCollection(db, organizationId, resource);
  const data = resource === "contacts" ? contactInput(input, fieldDefinitions) : quickReplyInput(input);
  const now = new Date();
  if (resource === "contacts") {
    const id = data.phoneId;
    const targetRef = collection.doc(id);
    if (resourceId && resourceId !== id) {
      if (!ID_PATTERN.test(resourceId)) throw httpError("Invalid contact ID.", 400);
      const sourceRef = collection.doc(resourceId);
      await db.runTransaction(async (transaction) => {
        const [sourceSnapshot, targetSnapshot] = await Promise.all([
          transaction.get(sourceRef),
          transaction.get(targetRef)
        ]);
        if (!sourceSnapshot.exists) throw httpError("Contact was not found.", 404);
        if (targetSnapshot.exists) {
          throw httpError("A contact with this phone number already exists in this workspace. Update that contact instead.", 409);
        }
        const sourceData = sourceSnapshot.data() || {};
        transaction.set(targetRef, {
          ...data,
          createdAt: sourceData.createdAt || now,
          updatedAt: now
        });
        transaction.delete(sourceRef);
      });
    } else {
      await targetRef.set({
        ...data,
        ...(resourceId ? {} : { createdAt: now }),
        updatedAt: now
      }, { merge: true });
    }
    return { id, ...data };
  }
  if (resourceId) {
    if (!ID_PATTERN.test(resourceId)) throw httpError("Invalid Quick Reply ID.", 400);
    const ref = collection.doc(resourceId);
    const existing = await ref.get();
    if (!existing.exists) throw httpError("Quick Reply was not found.", 404);
    await ref.set({ ...data, updatedAt: now }, { merge: true });
    return { id: resourceId, ...data };
  }
  const ref = collection.doc();
  await ref.set({ ...data, createdAt: now, updatedAt: now });
  return { id: ref.id, ...data };
}

async function deleteTenantResource(db, organizationId, resource, resourceId) {
  if (!ID_PATTERN.test(resourceId || "")) throw httpError("A valid resource ID is required.", 400);
  const ref = getTenantResourceCollection(db, organizationId, resource).doc(resourceId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw httpError("Resource was not found.", 404);
  await ref.delete();
}

module.exports = { contactInput, quickReplyInput, getTenantResourceCollection, listTenantResource, listPublicContacts, normalizeContactPageSize, encodeContactCursor, decodeContactCursor, saveTenantResource, deleteTenantResource };
