const test = require("node:test");
const assert = require("node:assert/strict");
const { saveTenantIncomingMessage } = require("../src/webhook");

function fakeDb() {
  const docs = new Map();
  function doc(path) {
    return {
      path,
      id: path.split("/").pop(),
      collection(name) { return collection(path + "/" + name); },
      async get() {
        const value = docs.get(path);
        return { exists: Boolean(value), id: this.id, data: () => value };
      },
      async set(value, options) {
        docs.set(path, options ? { ...(docs.get(path) || {}), ...value } : value);
      }
    };
  }
  function collection(path) {
    return { doc(id) { return doc(path + "/" + id); } };
  }
  return {
    docs,
    collection,
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        async get(ref) {
          const value = docs.get(ref.path);
          return { exists: Boolean(value), id: ref.id, data: () => value };
        },
        set(ref, value, options) {
          writes.push([ref.path, options ? { ...(docs.get(ref.path) || {}), ...value } : value]);
        }
      });
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    }
  };
}

test("incoming tenant media persists metadata only, never a storage path or media bytes", async () => {
  const db = fakeDb();
  const organization = {
    id: "org_alpha",
    ref: db.collection("organizations").doc("org_alpha")
  };
  const created = await saveTenantIncomingMessage(db, organization, {
    id: "wamid.incoming.1",
    from: "15551234567",
    timestamp: "1795000000",
    type: "image",
    image: {
      id: "meta-media-id-1",
      mime_type: "image/jpeg",
      file_size: 12345,
      sha256: "abc123"
    }
  }, "Customer");
  assert.equal(created, true);
  const saved = db.docs.get("organizations/org_alpha/chats/15551234567/messages/wamid.incoming.1");
  assert.equal(saved.mediaId, "meta-media-id-1");
  assert.equal(saved.mediaMimeType, "image/jpeg");
  assert.equal(saved.mediaSize, 12345);
  assert.equal(Object.hasOwn(saved, "mediaStoragePath"), false);
  assert.equal(Object.hasOwn(saved, "mediaUrl"), false);
  assert.equal(Object.hasOwn(saved, "mediaBytes"), false);
  assert.equal(db.docs.has("chats/15551234567/messages/wamid.incoming.1"), false);
  assert.equal(await saveTenantIncomingMessage(db, organization, {
    id: "wamid.incoming.1",
    from: "15551234567",
    type: "image",
    image: { id: "meta-media-id-1" }
  }, "Customer"), false);
});
