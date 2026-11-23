"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeInternalNote,
  listTenantInternalNotes,
  addTenantInternalNote
} = require("../src/tenantInternalNotes");

test("internal notes reject empty or oversized text", () => {
  assert.throws(() => normalizeInternalNote({ text: "   " }), /cannot be empty/);
  assert.throws(() => normalizeInternalNote({ text: "x".repeat(2001) }), /2000 characters/);
  assert.deepEqual(normalizeInternalNote({ text: "  Keep this internal  " }), { text: "Keep this internal" });
});

test("internal note collection requires valid organization and chat IDs", async () => {
  await assert.rejects(listTenantInternalNotes({}, "../other-tenant", "chat_1"), /valid organization and chat ID/);
  await assert.rejects(listTenantInternalNotes({}, "org_1", "../other-chat"), /valid organization and chat ID/);
});

test("lists only the bounded latest tenant internal notes", async () => {
  let orderedBy = "";
  let requestedLimit = 0;
  const db = {
    collection(name) {
      assert.equal(name, "organizations");
      return { doc(orgId) {
        assert.equal(orgId, "org_1");
        return { collection(child) {
          assert.equal(child, "chats");
          return { doc(chatId) {
            assert.equal(chatId, "chat_1");
            return { async get() { return { exists: true }; }, collection(notes) {
              assert.equal(notes, "internalNotes");
              return {
                orderBy(field, direction) { orderedBy = field + ":" + direction; return this; },
                limit(value) { requestedLimit = value; return this; },
                async get() { return { docs: [{ id: "note_1", data: () => ({ text: "Private", visibility: "internal" }) }] }; }
              };
            } };
          } };
        } };
      } };
    }
  };
  const result = await listTenantInternalNotes(db, "org_1", "chat_1", 1000);
  assert.equal(orderedBy, "createdAt:desc");
  assert.equal(requestedLimit, 100);
  assert.deepEqual(result, [{ id: "note_1", text: "Private", visibility: "internal", createdAt: null }]);
});

test("creates a private note with authenticated author metadata", async () => {
  let saved = null;
  const db = {
    collection() {
      return { doc() {
        return { async get() { return { exists: true }; }, collection() {
          return { doc() {
            return { id: "note_123", async set(value) { saved = value; } };
          } };
        } };
      } };
    }
  };
  const result = await addTenantInternalNote(db, "org_1", "chat_1", { text: "Call customer tomorrow" }, {
    uid: "agent_1", name: "Agent One", email: "agent@example.com"
  });
  assert.equal(result.id, "note_123");
  assert.equal(saved.text, "Call customer tomorrow");
  assert.equal(saved.authorUid, "agent_1");
  assert.equal(saved.authorName, "Agent One");
  assert.equal(saved.visibility, "internal");
  assert.ok(saved.createdAt instanceof Date);
});

test("internal notes require an authenticated actor", async () => {
  const db = {
    collection() { return { doc() { return { collection() { return { doc() { return { set: async () => assert.fail("Must not write without actor.") }; } }; } }; } }; }
  };
  await assert.rejects(addTenantInternalNote(db, "org_1", "chat_1", { text: "Private" }, null), /Authentication required/);
});
