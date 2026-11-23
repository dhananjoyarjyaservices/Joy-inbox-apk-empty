const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateChatAssignment,
  updateTenantChatAssignment
} = require("../src/tenantChatAssignment");

function httpError(statusCode) {
  return (error) => error.statusCode === statusCode;
}

function fakeDb({ chatExists = true, member = { status: "active", role: "agent", email: "agent@example.com", displayName: "Agent One" } } = {}) {
  const writes = [];
  const refs = new Map();
  function doc(path, data, exists = true) {
    const reference = {
      path,
      async get() {
        return { exists, data: () => data };
      },
      async set(value, options) {
        writes.push({ path, value, options });
      }
    };
    refs.set(path, reference);
    return reference;
  }
  const chatRef = doc("organizations/org_1/chats/15551234567", { status: "open" }, chatExists);
  const memberRef = doc("organizations/org_1/members/agent_1", member, Boolean(member));
  const auditCollection = {
    doc() {
      return { async set(value) { writes.push({ path: "audit", value }); } };
    }
  };
  const organizationRef = {
    collection(name) {
      if (name === "chats") return { doc: () => chatRef };
      if (name === "members") return { doc: () => memberRef };
      if (name === "auditLogs") return auditCollection;
      throw new Error("Unexpected collection: " + name);
    }
  };
  const db = {
    async runTransaction(callback) {
      const transaction = {
        async get(reference) { return reference.get(); },
        set(reference, value, options) { writes.push({ path: reference.path, value, options }); }
      };
      await callback(transaction);
    }
  };
  return { db, organization: { id: "org_1", ref: organizationRef }, writes };
}

test("validates assignment, unassignment and conversation status inputs", () => {
  assert.deepEqual(validateChatAssignment({ chatId: "15551234567", assignedTo: "agent_1" }), {
    chatId: "15551234567",
    hasAssignee: true,
    assignedTo: "agent_1",
    hasStatus: false,
    status: undefined
  });
  assert.equal(validateChatAssignment({ chatId: "15551234567", assignedTo: null }).assignedTo, null);
  assert.equal(validateChatAssignment({ chatId: "15551234567", status: "pending" }).status, "pending");
});

test("rejects invalid chat IDs, assignees, statuses and unexpected fields", () => {
  for (const input of [
    { chatId: "abc", assignedTo: "agent_1" },
    { chatId: "15551234567", assignedTo: "../admin" },
    { chatId: "15551234567", status: "closed" },
    { chatId: "15551234567" },
    { chatId: "15551234567", assignedTo: "agent_1", extra: true }
  ]) {
    assert.throws(() => validateChatAssignment(input), httpError(400));
  }
});

test("assigns a conversation only to an active member in the same organization", async () => {
  const { db, organization, writes } = fakeDb();
  const result = await updateTenantChatAssignment(
    db, organization, { uid: "owner_1", email: "owner@example.com", role: "owner" },
    { chatId: "15551234567", assignedTo: "agent_1" }
  );
  assert.equal(result.assignedTo, "agent_1");
  assert.equal(result.assignee.displayName, "Agent One");
  const chatWrite = writes.find((item) => item.path.endsWith("/chats/15551234567"));
  assert.equal(chatWrite.value.assignedTo, "agent_1");
  assert.equal(chatWrite.value.assignedBy, "owner_1");
  assert.equal(writes.some((item) => item.path === "audit"), true);
});

test("rejects removed or invalid-role assignees", async () => {
  for (const member of [
    { status: "removed", role: "agent" },
    { status: "active", role: "unknown" }
  ]) {
    const { db, organization } = fakeDb({ member });
    await assert.rejects(
      () => updateTenantChatAssignment(db, organization, { uid: "owner_1" }, {
        chatId: "15551234567", assignedTo: "agent_1"
      }),
      httpError(404)
    );
  }
});

test("supports unassigning a conversation and updating its workflow status", async () => {
  const { db, organization, writes } = fakeDb();
  const result = await updateTenantChatAssignment(
    db, organization, { uid: "agent_1", role: "agent" },
    { chatId: "15551234567", assignedTo: null, status: "resolved" }
  );
  assert.equal(result.assignedTo, null);
  assert.equal(result.status, "resolved");
  const chatWrite = writes.find((item) => item.path.endsWith("/chats/15551234567"));
  assert.equal(chatWrite.value.assignedTo, null);
  assert.equal(chatWrite.value.status, "resolved");
});

test("does not update a missing conversation", async () => {
  const { db, organization, writes } = fakeDb({ chatExists: false });
  await assert.rejects(
    () => updateTenantChatAssignment(db, organization, { uid: "owner_1" }, {
      chatId: "15551234567", status: "pending"
    }),
    httpError(404)
  );
  assert.equal(writes.length, 0);
});

test("tenant chat assignment route builds actor context from verified user and stored workspace role", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
  const handlerStart = source.indexOf("async function handleTenantChatAction");
  const handlerEnd = source.indexOf("async function getTenantGreetingSettings", handlerStart + 1);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /const actor = \\{ uid: decoded\\.uid, email: decoded\\.email \\|\\| "", role: organization\\.role \\}/);
  assert.match(handler, /updateTenantChatAssignment\\(getDb\\(\\), organization, actor, actionInput\\)/);
});

