const test = require("node:test");
const assert = require("node:assert/strict");
const { saveTenantIncomingMessage } = require("../src/webhook");

function createRef(path, id = path.split("/").pop()) {
  return {
    path,
    id,
    collection(name) {
      return {
        doc(childId) {
          return createRef(path + "/" + name + "/" + childId, childId);
        }
      };
    }
  };
}

function createFakeDb() {
  const documents = new Map();
  return {
    documents,
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = documents.get(ref.path);
          return {
            exists: value !== undefined,
            data: () => value || {},
            get: key => value?.[key]
          };
        },
        set(ref, value, options) {
          writes.push({ ref, value, options });
        }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const previous = documents.get(write.ref.path) || {};
        documents.set(write.ref.path, write.options?.merge
          ? { ...previous, ...write.value }
          : write.value);
      }
      return result;
    }
  };
}

test("incoming customer media stores message metadata only, never image bytes or Storage paths", async () => {
  const db = createFakeDb();
  const organization = {
    id: "org_test",
    ref: createRef("organizations/org_test", "org_test")
  };
  const saved = await saveTenantIncomingMessage(db, organization, {
    from: "919876543210",
    id: "wamid.test-image-001",
    timestamp: "1795435200",
    type: "image",
    image: {
      id: "meta-media-id-123",
      mime_type: "image/jpeg",
      sha256: "abc123",
      file_size: 2048,
      caption: "Please check this"
    }
  }, "Customer", "123456789012345");

  assert.equal(saved, true);
  const message = db.documents.get(
    "organizations/org_test/chats/919876543210/messages/wamid.test-image-001"
  );
  assert.equal(message.direction, "incoming");
  assert.equal(message.type, "image");
  assert.equal(message.text, "Please check this");
  assert.equal(message.mediaId, "meta-media-id-123");
  assert.equal(message.mediaMimeType, "image/jpeg");

  for (const forbiddenField of [
    "mediaData",
    "mediaBytes",
    "fileBase64",
    "buffer",
    "mediaStoragePath",
    "storagePath",
    "downloadUrl"
  ]) {
    assert.equal(Object.hasOwn(message, forbiddenField), false, forbiddenField);
  }
});

test("duplicate incoming customer media message is not written twice", async () => {
  const db = createFakeDb();
  const organization = {
    id: "org_test",
    ref: createRef("organizations/org_test", "org_test")
  };
  const payload = {
    from: "919876543210",
    id: "wamid.duplicate-image",
    timestamp: "1795435200",
    type: "image",
    image: { id: "meta-media-id-456", mime_type: "image/jpeg" }
  };
  assert.equal(await saveTenantIncomingMessage(db, organization, payload, "Customer", "123456789012345"), true);
  assert.equal(await saveTenantIncomingMessage(db, organization, payload, "Customer", "123456789012345"), false);
  assert.equal(db.documents.size, 2);
});
