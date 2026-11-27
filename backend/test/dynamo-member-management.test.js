"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoMemberManagement } = require("../src/aws/dynamoMemberManagement");

function fixture(overrides = {}) {
  const calls = [];
  const members = new Map([
    ["owner_1", { uid: "owner_1", role: "owner", status: "active" }],
    ["admin_1", { uid: "admin_1", role: "admin", status: "active" }],
    ["agent_1", { uid: "agent_1", role: "agent", status: "active" }]
  ]);
  const organizationStore = {
    addMember: async input => { calls.push(["add", input]); members.set(input.uid, { ...input, status: "active" }); return { uid: input.uid, role: input.role, status: "active" }; },
    getMembership: async (_org, uid) => members.get(uid) || null,
    updateMemberRole: async input => { calls.push(["update", input]); members.set(input.uid, { ...members.get(input.uid), role: input.role }); return { uid: input.uid, role: input.role }; },
    removeMember: async input => { calls.push(["remove", input]); members.delete(input.uid); return { uid: input.uid, removed: true }; },
    listMembers: async (_org, options) => ({ items: [], lastEvaluatedKey: null, options })
  };
  const service = createDynamoMemberManagement({
    organizationStore,
    getSeatLimit: async organizationId => { calls.push(["seatLimit", organizationId]); return 5; },
    recordAudit: async event => { calls.push(["audit", event]); },
    ...overrides
  });
  return { service, calls, members };
}

test("adds agents with verified plan seat limit and writes audit event", async () => {
  const { service, calls } = fixture();
  const result = await service.addMember({ organizationId: "org_1", actor: { uid: "owner_1", role: "owner" }, uid: "agent_2" });
  assert.deepEqual(result, { uid: "agent_2", role: "agent", status: "active" });
  assert.deepEqual(calls.find(item => item[0] === "add")[1], { organizationId: "org_1", uid: "agent_2", role: "agent", seatLimit: 5 });
  assert.equal(calls.find(item => item[0] === "audit")[1].action, "member.added");
});

test("only owners can grant admin role", async () => {
  const { service, calls } = fixture();
  await assert.rejects(() => service.addMember({ organizationId: "org_1", actor: { uid: "admin_1", role: "admin" }, uid: "agent_2", role: "admin" }), { statusCode: 403 });
  assert.equal(calls.length, 0);
});

test("only owners can change or remove another admin", async () => {
  const { service, calls } = fixture();
  await assert.rejects(() => service.updateMemberRole({ organizationId: "org_1", actor: { uid: "admin_1", role: "admin" }, uid: "admin_1", role: "agent" }), { statusCode: 403 });
  await assert.rejects(() => service.removeMember({ organizationId: "org_1", actor: { uid: "admin_1", role: "admin" }, uid: "admin_1" }), { statusCode: 403 });
  assert.equal(calls.length, 0);
});

test("protects owner from role changes and removal", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.updateMemberRole({ organizationId: "org_1", actor: { uid: "owner_1", role: "owner" }, uid: "owner_1", role: "agent" }), { statusCode: 409 });
  await assert.rejects(() => service.removeMember({ organizationId: "org_1", actor: { uid: "owner_1", role: "owner" }, uid: "owner_1" }), { statusCode: 409 });
});

test("agents cannot list or manage organization members", async () => {
  const { service, calls } = fixture();
  const actor = { uid: "agent_1", role: "agent" };
  await assert.rejects(() => service.listMembers({ organizationId: "org_1", actor }), { statusCode: 403 });
  await assert.rejects(() => service.removeMember({ organizationId: "org_1", actor, uid: "admin_1" }), { statusCode: 403 });
  assert.equal(calls.length, 0);
});

test("requires trusted seat limit and audit writer dependencies", () => {
  const organizationStore = { addMember() {}, updateMemberRole() {}, removeMember() {}, listMembers() {} };
  assert.throws(() => createDynamoMemberManagement({ organizationStore, recordAudit() {} }), /seat-limit resolver/);
  assert.throws(() => createDynamoMemberManagement({ organizationStore, getSeatLimit() {} }), /audit writer/);
});
