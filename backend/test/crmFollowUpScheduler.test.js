"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runScheduledCrmFollowUpReminders, timestampMillis } = require("../src/crmFollowUpScheduler");

function createDb({ leads = [], stages = {}, members = {} } = {}) {
  const records = new Map();
  function makeRef(path, initial) {
    if (initial !== undefined && !records.has(path)) records.set(path, initial);
    return {
      id: path.split("/").pop(), path,
      collection(name) { return makeCollection(path + "/" + name); },
      async get() { const value = records.get(path); return { exists: value !== undefined, data: () => value }; },
      async set(value, options = {}) {
        if (options.merge) {
          const next = { ...(records.get(path) || {}) };
          for (const [key, field] of Object.entries(value)) { if (field?.__delete) delete next[key]; else next[key] = field; }
          records.set(path, next);
        } else records.set(path, value);
      }
    };
  }
  function makeCollection(path) {
    return {
      doc(id) { return makeRef(path + "/" + id); },
      orderBy() { return makeQuery(path); },
      where() { return makeQuery(path); }
    };
  }
  function makeQuery(path) {
    let max = 100;
    const query = {
      where() { return query; }, orderBy() { return query; },
      limit(value) { max = value; return query; }, startAfter() { return query; },
      async get() {
        if (path === "organizations") {
          return { docs: [{ id: "org_a", ref: makeRef("organizations/org_a", {}), data: () => ({}) }], empty: false, size: 1 };
        }
        if (path === "organizations/org_a/crmLeads") {
          const docs = leads.slice(0, max).map(lead => {
            const ref = makeRef(path + "/" + lead.id, lead);
            return { id: lead.id, ref, data: () => records.get(ref.path) };
          });
          return { docs, empty: docs.length === 0, size: docs.length };
        }
        return { docs: [], empty: true, size: 0 };
      }
    };
    return query;
  }
  records.set("organizations/org_a/crmStages/new", stages.new || { active: true });
  for (const [id, value] of Object.entries(stages)) records.set("organizations/org_a/crmStages/" + id, value);
  for (const [id, value] of Object.entries(members)) records.set("organizations/org_a/members/" + id, value);
  return {
    records, collection: makeCollection,
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) { const value = records.get(ref.path); return { exists: value !== undefined, data: () => value }; },
        update(ref, patch) { writes.push(() => {
          const next = { ...(records.get(ref.path) || {}) };
          for (const [key, value] of Object.entries(patch)) { if (value?.__delete) delete next[key]; else next[key] = value; }
          records.set(ref.path, next);
        }); }
      };
      const result = await callback(transaction); writes.forEach(write => write()); return result;
    }
  };
}

const admin = {
  firestore: {
    FieldPath: { documentId: () => "__name__" },
    FieldValue: { delete: () => ({ __delete: true }) },
    Timestamp: { fromDate: date => date }
  }
};

test("timestampMillis accepts Firestore-like timestamps and dates", () => {
  assert.equal(timestampMillis(new Date("2026-11-24T00:00:00Z")), Date.parse("2026-11-24T00:00:00Z"));
  assert.equal(timestampMillis({ toMillis: () => 1234 }), 1234);
  assert.ok(Number.isNaN(timestampMillis(null)));
});

test("sends one reminder for an overdue follow-up assigned to an active member", async () => {
  const now = new Date("2026-11-24T12:00:00Z"), due = new Date("2026-11-24T10:00:00Z");
  const db = createDb({
    leads: [{ id: "lead_1", title: "Website redesign", stageId: "new", ownerUid: "agent_1", nextFollowUpAt: due }],
    members: { agent_1: { status: "active", role: "agent" } }
  });
  const calls = [];
  const notify = async (...args) => calls.push(args);
  const first = await runScheduledCrmFollowUpReminders({ db, admin, now, notify });
  const second = await runScheduledCrmFollowUpReminders({ db, admin, now, notify });
  assert.equal(first.remindersSent, 1);
  assert.equal(first.failed, 0);
  assert.equal(second.remindersSent, 0);
  assert.equal(calls.length, 1);
  assert.ok([...db.records.keys()].some(key => key.includes("/notifications/crm_followup_lead_1_")));
});

test("skips unassigned, inactive-member and won/lost leads", async () => {
  const now = new Date("2026-11-24T12:00:00Z"), due = new Date("2026-11-24T10:00:00Z");
  const db = createDb({
    leads: [
      { id: "unassigned", title: "A", stageId: "new", ownerUid: "", nextFollowUpAt: due },
      { id: "inactive", title: "B", stageId: "new", ownerUid: "agent_1", nextFollowUpAt: due },
      { id: "won", title: "C", stageId: "won", ownerUid: "agent_2", nextFollowUpAt: due }
    ],
    stages: { new: { active: true }, won: { active: true, isWon: true } },
    members: { agent_1: { status: "disabled", role: "agent" }, agent_2: { status: "active", role: "agent" } }
  });
  const result = await runScheduledCrmFollowUpReminders({ db, admin, now, notify: async () => assert.fail("must not notify") });
  assert.equal(result.remindersSent, 0);
  assert.equal(result.skipped, 3);
});

test("releases reminder claim after notification failure so the next schedule can retry", async () => {
  const now = new Date("2026-11-24T12:00:00Z"), due = new Date("2026-11-24T10:00:00Z");
  const db = createDb({
    leads: [{ id: "lead_2", title: "Demo", stageId: "new", ownerUid: "agent_1", nextFollowUpAt: due }],
    members: { agent_1: { status: "active", role: "agent" } }
  });
  const failed = await runScheduledCrmFollowUpReminders({ db, admin, now, notify: async () => { throw new Error("push unavailable"); } });
  const succeeded = await runScheduledCrmFollowUpReminders({ db, admin, now, notify: async () => {} });
  assert.equal(failed.failed, 1);
  assert.equal(succeeded.remindersSent, 1);
});


test("respects a member's disabled CRM follow-up notification preference", async () => {
  const now = new Date("2026-11-24T12:00:00Z"), due = new Date("2026-11-24T10:00:00Z");
  const db = createDb({
    leads: [{ id: "lead_opt_out", title: "Do not alert", stageId: "new", ownerUid: "agent_1", nextFollowUpAt: due }],
    members: { agent_1: { status: "active", role: "agent" } }
  });
  db.records.set("organizations/org_a/members/agent_1/settings/notifications", { crm: false });
  const result = await runScheduledCrmFollowUpReminders({ db, admin, now, notify: async () => assert.fail("must not notify") });
  assert.equal(result.remindersSent, 0);
  assert.equal(result.skipped, 1);
});
