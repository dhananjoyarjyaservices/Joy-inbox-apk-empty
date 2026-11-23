const test = require("node:test");
const assert = require("node:assert/strict");
const { validateChatAssignment, updateTenantChatAssignment } = require("./tenantChatAssignment");

const validChatId = "123456789012345";

test("validates assignment and status payloads", () => {
  assert.deepEqual(validateChatAssignment({ chatId: validChatId, assignedTo: "agent_1" }), {
    chatId: validChatId, hasAssignee: true, assignedTo: "agent_1",
    hasStatus: false, status: undefined
  });
  assert.throws(() => validateChatAssignment({ chatId: validChatId }), /assignee.*status/i);
  assert.throws(() => validateChatAssignment({ chatId: "bad", assignedTo: null }), /chat ID/i);
  assert.throws(() => validateChatAssignment({ chatId: validChatId, assignedTo: "bad uid!" }), /active team member/i);
  assert.throws(() => validateChatAssignment({ chatId: validChatId, status: "closed" }), /status must be/i);
  assert.throws(() => validateChatAssignment({ chatId: validChatId, assignedTo: null, unexpected: true }), /Unsupported|Provide/i);
});

function makeDb({ chatExists = true, member = { status: "active", role: "agent", email: "agent@example.com", displayName: "Agent One" } } = {}) {
  const writes = [];
  const chatRef = { path: "organizations/org_1/chats/" + validChatId };
  const memberRef = { path: "organizations/org_1/members/agent_1" };
  const organizationRef = {
    collection(name) {
      if (name === "chats") return { doc: () => chatRef };
      if (name === "members") return { doc: () => memberRef };
      if (name === "auditLogs") return { doc: () => ({ set: async data => writes.push(data) }) };
      throw new Error("Unexpected collection " + name);
    }
  };
  const db = {
    async runTransaction(callback) {
      const updates = [];
      await callback({
        async get(ref) {
          if (ref === chatRef) return { exists: chatExists };
          if (ref === memberRef) return { exists: Boolean(member), data: () => member };
          throw new Error("Unexpected document");
        },
        set(ref, data, options) { updates.push({ ref, data, options }); }
      });
      writes.push(...updates);
    }
  };
  return { db, organization: { id: "org_1", ref: organizationRef }, writes };
}

test("assigns a chat to an active member and records an audit event", async () => {
  const { db, organization, writes } = makeDb();
  const result = await updateTenantChatAssignment(db, organization,
    { uid: "owner_1", email: "owner@example.com", role: "owner" },
    { chatId: validChatId, assignedTo: "agent_1" });
  assert.equal(result.assignedTo, "agent_1");
  assert.deepEqual(result.assignee, { uid: "agent_1", email: "agent@example.com", displayName: "Agent One" });
  const chatUpdate = writes.find(item => item.ref?.path === "organizations/org_1/chats/" + validChatId);
  assert.equal(chatUpdate.data.assignedTo, "agent_1");
  assert.equal(chatUpdate.data.assignedBy, "owner_1");
  assert.equal(writes.find(item => item.action === "chat.assigned").targetUid, "agent_1");
});

test("rejects assignment to an inactive member without writing", async () => {
  const { db, organization, writes } = makeDb({ member: { status: "disabled", role: "agent" } });
  await assert.rejects(
    updateTenantChatAssignment(db, organization, { uid: "owner_1" },
      { chatId: validChatId, assignedTo: "agent_1" }),
    error => error.statusCode === 404
  );
  assert.equal(writes.length, 0);
});

test("updates status without changing assignee", async () => {
  const { db, organization, writes } = makeDb();
  const result = await updateTenantChatAssignment(db, organization,
    { uid: "owner_1", role: "owner" },
    { chatId: validChatId, status: "pending" });
  assert.deepEqual(result, { chatId: validChatId, status: "pending" });
  const chatUpdate = writes.find(item => item.ref?.path === "organizations/org_1/chats/" + validChatId);
  assert.equal(chatUpdate.data.status, "pending");
  assert.equal(chatUpdate.data.assignedTo, undefined);
  assert.equal(writes.find(item => item.action === "chat.status_changed").details.status, "pending");
});

test("rejects updates for a missing conversation", async () => {
  const { db, organization, writes } = makeDb({ chatExists: false });
  await assert.rejects(
    updateTenantChatAssignment(db, organization, { uid: "owner_1" },
      { chatId: validChatId, assignedTo: null }),
    error => error.statusCode === 404
  );
  assert.equal(writes.length, 0);
});
