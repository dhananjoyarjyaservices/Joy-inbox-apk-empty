const test = require("node:test");
const assert = require("node:assert/strict");
const { validateChatState, validateMessageState, validateMessageIds, validateChatIds } = require("../src/tenantChatActions");

test("validates chat pin, archive and read state", () => {
  const result = validateChatState({ chatId: "919876543210", pinned: true, archived: false, markRead: true });
  assert.equal(result.chatId, "919876543210");
  assert.equal(result.updates.pinned, true);
  assert.equal(result.updates.archived, false);
  assert.equal(result.updates.unreadCount, 0);
  assert.ok(result.updates.lastReadAt instanceof Date);
});

test("rejects unknown fields and invalid chat state", () => {
  assert.throws(() => validateChatState({ chatId: "1234567", pinned: true, organizationId: "other" }), { statusCode: 400 });
  assert.throws(() => validateChatState({ chatId: "1234567", pinned: "yes" }), { statusCode: 400 });
});

test("validates pinned message updates", () => {
  assert.equal(validateMessageState({ chatId: "1234567", messageId: "wamid.abc", pinned: true }).updates.pinned, true);
  assert.throws(() => validateMessageState({ chatId: "1234567", messageId: "bad id", pinned: true }), { statusCode: 400 });
});

test("validates bounded unique message and chat deletion lists", () => {
  assert.deepEqual(validateMessageIds({ chatId: "1234567", messageIds: ["a", "b"] }).messageIds, ["a", "b"]);
  assert.deepEqual(validateChatIds({ chatIds: ["1234567"] }), ["1234567"]);
  assert.throws(() => validateMessageIds({ chatId: "1234567", messageIds: ["a", "a"] }), { statusCode: 400 });
  assert.throws(() => validateChatIds({ chatIds: [] }), { statusCode: 400 });
});
