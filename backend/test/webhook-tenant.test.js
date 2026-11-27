const test = require("node:test");
const assert = require("node:assert/strict");
const { saveTenantIncomingMessage } = require("../src/webhook");

function fakeDb() {
  const docs = new Map();
  function doc(path) {
    return {
      path,
      collection(name) { return collection(path + "/" + name); }
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
      const transaction = {
        async get(ref) {
          const value = docs.get(ref.path);
          return { exists: Boolean(value), id: ref.path.split("/").pop(), data: () => value };
        },
        set(ref, value, options) {
          writes.push([ref.path, value, options]);
        }
      };
      const result = await callback(transaction);
      for (const [path, value, options] of writes) {
        docs.set(path, options?.merge ? { ...(docs.get(path) || {}), ...value } : value);
      }
      return result;
    }
  };
}

test("incoming WhatsApp message is saved only under the resolved organization and sender chat", async () => {
  const db = fakeDb();
  const organization = { id: "org_alpha", ref: db.collection("organizations").doc("org_alpha") };
  const created = await saveTenantIncomingMessage(db, organization, {
    id: "wamid.incoming1",
    from: "15551234567",
    timestamp: "1760000000",
    type: "text",
    text: { body: "Hello from customer" }
  }, "Customer One", "123456789012345");

  assert.equal(created, true);
  const message = db.docs.get("organizations/org_alpha/chats/15551234567/messages/wamid.incoming1");
  const chat = db.docs.get("organizations/org_alpha/chats/15551234567");
  assert.equal(message.organizationId, "org_alpha");
  assert.equal(message.phoneNumberId, "123456789012345");
  assert.equal(message.direction, "incoming");
  assert.equal(message.text, "Hello from customer");
  assert.equal(chat.customerName, "Customer One");
  assert.equal(chat.phoneNumberId, "123456789012345");
  assert.equal(chat.unreadCount, 1);
  assert.equal(db.docs.has("organizations/org_beta/chats/15551234567/messages/wamid.incoming1"), false);
});

test("duplicate webhook delivery does not create a second message or increment unread count", async () => {
  const db = fakeDb();
  const organization = { id: "org_duplicate", ref: db.collection("organizations").doc("org_duplicate") };
  const payload = {
    id: "wamid.duplicate",
    from: "15557654321",
    timestamp: "1760000000",
    type: "text",
    text: { body: "One delivery" }
  };

  assert.equal(await saveTenantIncomingMessage(db, organization, payload, "Customer", "987654321012345"), true);
  assert.equal(await saveTenantIncomingMessage(db, organization, payload, "Customer", "987654321012345"), false);
  assert.equal(db.docs.get("organizations/org_duplicate/chats/15557654321").unreadCount, 1);
  assert.equal([...db.docs.keys()].filter(path => path.includes("/messages/")).length, 1);
});

test("invalid incoming message identifiers and phone numbers are ignored", async () => {
  const db = fakeDb();
  const organization = { id: "org_invalid", ref: db.collection("organizations").doc("org_invalid") };
  assert.equal(await saveTenantIncomingMessage(db, organization, {
    id: "../escape",
    from: "15551234567",
    type: "text",
    text: { body: "bad id" }
  }, "Customer", "123456789012345"), false);
  assert.equal(await saveTenantIncomingMessage(db, organization, {
    id: "wamid.valid",
    from: "not-a-phone",
    type: "text",
    text: { body: "bad phone" }
  }, "Customer", "123456789012345"), false);
  assert.equal(db.docs.size, 0);
});
