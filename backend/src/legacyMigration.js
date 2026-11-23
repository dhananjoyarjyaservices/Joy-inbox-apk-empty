"use strict";

const LEGACY_MEDIA_FIELDS = new Set([
  "mediaStoragePath", "storagePath", "signedUrl", "mediaUrl", "downloadUrl",
  "thumbnailUrl", "base64", "fileBuffer", "mediaBytes", "rawMedia"
]);

function copySafeFields(value, excluded = LEGACY_MEDIA_FIELDS) {
  const output = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (excluded.has(key) || /(?:storagepath|signedurl|mediaurl|imageurl|videourl|audiourl|documenturl|fileurl|downloadurl|thumbnailurl|avatarurl|profilepictureurl|photourl|base64|mediabytes|rawmedia|filebuffer)/i.test(key)) continue;
    if (item === undefined || typeof item === "function") continue;
    output[key] = item;
  }
  return output;
}

function sanitizeLegacyMessage(value) {
  const source = value || {};
  const result = copySafeFields(source);
  const hadLegacyStorage = Boolean(source.mediaStoragePath || source.storagePath || source.mediaUrl);
  if (hadLegacyStorage && !source.mediaId) {
    result.mediaUnavailable = true;
    delete result.mediaType;
    delete result.mimeType;
    delete result.fileName;
  }
  result.migratedFromLegacy = true;
  return result;
}

function sanitizeLegacyChat(value) {
  return { ...copySafeFields(value), migratedFromLegacy: true };
}

function sanitizeLegacyContact(value) {
  const allowed = new Set([
    "name", "phone", "phoneId", "email", "notes", "source",
    "createdAt", "updatedAt", "lastSeenAt", "tags"
  ]);
  return {
    ...copySafeFields(value, new Set([...LEGACY_MEDIA_FIELDS, ...Object.keys(value || {}).filter(key => !allowed.has(key))])),
    migratedFromLegacy: true
  };
}

function sanitizeLegacyQuickReply(value) {
  const allowed = new Set(["title", "shortcut", "message", "createdAt", "updatedAt"]);
  const source = value || {};
  const result = {
    ...copySafeFields(source, new Set([...LEGACY_MEDIA_FIELDS, ...Object.keys(source).filter(key => !allowed.has(key))])),
    migratedFromLegacy: true
  };
  if (source.imageStoragePath || source.imageUrl || source.imageMediaId) result.imageUnavailable = true;
  return result;
}

async function commitWrites(db, writes, batchSize = 400) {
  for (let offset = 0; offset < writes.length; offset += batchSize) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + batchSize)) {
      batch.set(write.ref, write.data, { merge: true });
    }
    await batch.commit();
  }
}

async function runLegacyMigration(db, options = {}) {
  const organizationId = String(options.organizationId || "");
  const ownerUid = String(options.ownerUid || "");
  const execute = options.execute === true;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerUid)) {
    throw new Error("A valid organization ID and owner UID are required.");
  }
  const organizationRef = db.collection("organizations").doc(organizationId);
  const [organizationSnapshot, memberSnapshot] = await Promise.all([
    organizationRef.get(),
    organizationRef.collection("members").doc(ownerUid).get()
  ]);
  if (!organizationSnapshot.exists || organizationSnapshot.data()?.status !== "active") {
    throw new Error("The target organization must exist and be active.");
  }
  if (!memberSnapshot.exists || memberSnapshot.data()?.status !== "active" || memberSnapshot.data()?.role !== "owner") {
    throw new Error("The selected user must be an active owner of the target organization.");
  }

  const markerRef = organizationRef.collection("settings").doc("legacyMigration");
  const marker = await markerRef.get();
  if (marker.exists && marker.data()?.status === "completed") {
    return { organizationId, execute, alreadyCompleted: true, migrated: { chats: 0, messages: 0, contacts: 0, quickReplies: 0, settings: 0 } };
  }

  const [chatsSnapshot, contactsSnapshot, repliesSnapshot, greetingSnapshot] = await Promise.all([
    db.collection("chats").get(),
    db.collection("users").doc(ownerUid).collection("contacts").get(),
    db.collection("users").doc(ownerUid).collection("quickReplies").get(),
    db.collection("users").doc(ownerUid).collection("settings").doc("greeting").get()
  ]);
  const summary = {
    organizationId,
    ownerUid,
    execute,
    source: {
      chats: chatsSnapshot.size,
      messages: 0,
      contacts: contactsSnapshot.size,
      quickReplies: repliesSnapshot.size,
      greetingSettings: greetingSnapshot.exists ? 1 : 0
    },
    migrated: { chats: 0, messages: 0, contacts: 0, quickReplies: 0, settings: 0 },
    skippedExisting: { chats: 0, messages: 0, contacts: 0, quickReplies: 0, settings: 0 }
  };
  if (!execute) {
    for (const chatDocument of chatsSnapshot.docs) {
      const messages = await chatDocument.ref.collection("messages").get();
      summary.source.messages += messages.size;
    }
    return summary;
  }

  const writes = [];
  for (const chatDocument of chatsSnapshot.docs) {
    const destinationChat = organizationRef.collection("chats").doc(chatDocument.id);
    const existingChat = await destinationChat.get();
    if (!existingChat.exists) {
      writes.push({ ref: destinationChat, data: sanitizeLegacyChat(chatDocument.data()) });
      summary.migrated.chats += 1;
    } else summary.skippedExisting.chats += 1;

    const messages = await chatDocument.ref.collection("messages").get();
    for (const messageDocument of messages.docs) {
      const destinationMessage = destinationChat.collection("messages").doc(messageDocument.id);
      const existingMessage = await destinationMessage.get();
      if (!existingMessage.exists) {
        writes.push({ ref: destinationMessage, data: sanitizeLegacyMessage(messageDocument.data()) });
        summary.migrated.messages += 1;
      } else summary.skippedExisting.messages += 1;
    }
  }

  for (const contact of contactsSnapshot.docs) {
    const destination = organizationRef.collection("contacts").doc(contact.id);
    const existing = await destination.get();
    if (!existing.exists) {
      writes.push({ ref: destination, data: sanitizeLegacyContact(contact.data()) });
      summary.migrated.contacts += 1;
    } else summary.skippedExisting.contacts += 1;
  }

  for (const reply of repliesSnapshot.docs) {
    const destination = organizationRef.collection("quickReplies").doc(reply.id);
    const existing = await destination.get();
    if (!existing.exists) {
      writes.push({ ref: destination, data: sanitizeLegacyQuickReply(reply.data()) });
      summary.migrated.quickReplies += 1;
    } else summary.skippedExisting.quickReplies += 1;
  }

  if (greetingSnapshot.exists) {
    const destination = organizationRef.collection("settings").doc("greeting");
    const existing = await destination.get();
    if (!existing.exists) {
      writes.push({ ref: destination, data: { ...copySafeFields(greetingSnapshot.data()), migratedFromLegacy: true } });
      summary.migrated.settings += 1;
    } else summary.skippedExisting.settings += 1;
  }

  await commitWrites(db, writes);
  await markerRef.set({
    status: "completed",
    version: 1,
    ownerUid,
    completedAt: new Date(),
    summary
  }, { merge: true });
  return summary;
}

module.exports = {
  copySafeFields,
  sanitizeLegacyMessage,
  sanitizeLegacyChat,
  sanitizeLegacyContact,
  sanitizeLegacyQuickReply,
  runLegacyMigration
};
