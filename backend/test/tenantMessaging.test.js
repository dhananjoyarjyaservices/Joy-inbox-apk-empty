const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getTenantChatRef,
  getTenantMessageRef,
  claimTenantSendRequest,
  resolveTenantReplyContext,
  getTenantReplyMessageFields
} = require("../src/tenantMessaging");

function fakeDb() {
  const docs = new Map();
  function doc(path) {
    return {
      path,
      collection(name) { return collection(path + "/" + name); },
      async get() {
        const value = docs.get(path);
        return { exists: Boolean(value), id: path.split("/").pop(), data: () => value };
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
      return callback({
        async get(ref) {
          const value = docs.get(ref.path);
          return { exists: Boolean(value), data: () => value };
        },
        create(ref, value) { docs.set(ref.path, value); },
        set(ref, value, options) {
          docs.set(ref.path, options ? { ...(docs.get(ref.path) || {}), ...value } : value);
        }
      });
    }
  };
}

test("tenant chat, message and idempotency records are scoped under the organization", async () => {
  const db = fakeDb();
  const chat = getTenantChatRef(db, "org_one", "15551234567");
  assert.equal(chat.path, "organizations/org_one/chats/15551234567");
  assert.equal(getTenantMessageRef(db, "org_one", "15551234567", "wamid.1").path,
    "organizations/org_one/chats/15551234567/messages/wamid.1");

  const first = await claimTenantSendRequest(db, "org_one", "15551234567", "client-1", "hash-a");
  assert.equal(first.state, "claimed");
  const retry = await claimTenantSendRequest(db, "org_one", "15551234567", "client-1", "hash-a");
  assert.equal(retry.state, "pending");
  const otherTenant = await claimTenantSendRequest(db, "org_two", "15551234567", "client-1", "hash-a");
  assert.equal(otherTenant.state, "claimed");
  assert.notEqual(first.ref.path, otherTenant.ref.path);
  await assert.rejects(
    () => claimTenantSendRequest(db, "org_one", "15551234567", "client-1", "different"),
    { statusCode: 409 }
  );
});

test("tenant reply lookup cannot read another organization's message", async () => {
  const db = fakeDb();
  await getTenantMessageRef(db, "org_one", "15551234567", "wamid.original").set({
    messageId: "wamid.original",
    direction: "incoming",
    text: "Original customer message",
    type: "text",
    sender: "Customer"
  });
  const reply = await resolveTenantReplyContext(db, "org_one", "15551234567", {
    replyToMessageId: "wamid.original"
  });
  assert.equal(reply.contextMessageId, "wamid.original");
  assert.deepEqual(getTenantReplyMessageFields(reply), {
    replyToMessageId: "wamid.original",
    replyToMessageText: "Original customer message",
    replyToMessageSender: "Customer",
    replyToMessageType: "text"
  });
  await assert.rejects(
    () => resolveTenantReplyContext(db, "org_two", "15551234567", {
      replyToMessageId: "wamid.original"
    }),
    { statusCode: 404 }
  );
});
