"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listPublicLeads, savePublicLead, deletePublicLead } = require("../src/publicCrmApi");

function fakeDb(seed = {}) {
  const records = new Map(Object.entries(seed));
  let nextId = 0;
  function doc(path) {
    return {
      id: path.split("/").pop(), path,
      collection(name) { return collection(path + "/" + name); },
      async get() { const value = records.get(path); return { exists: Boolean(value), data: () => value }; },
      async set(value, options = {}) { records.set(path, options.merge ? { ...(records.get(path) || {}), ...value } : value); },
      async delete() { records.delete(path); }
    };
  }
  function collection(path) {
    return {
      doc(id) { return doc(path + "/" + (id || "generated_" + (++nextId))); },
      async get() {
        const prefix = path + "/";
        const docs = [...records.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value }));
        return { docs, size: docs.length };
      },
      orderBy() { return { limit(limit) { return { async get() { const result = await collection(path).get(); return { docs: result.docs.slice(0, limit), size: Math.min(result.size, limit) }; } }; }, get: () => collection(path).get() }; }
    };
  }
  return {
    records, collection,
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        async get(ref) { const value = records.get(ref.path); return { exists: Boolean(value), data: () => value }; },
        create(ref, value) { writes.push(() => { if (!records.has(ref.path)) records.set(ref.path, value); }); },
        set(ref, value, options = {}) { writes.push(() => records.set(ref.path, options.merge ? { ...(records.get(ref.path) || {}), ...value } : value)); }
      };
      const result = await callback(tx); writes.forEach(write => write()); return result;
    }
  };
}

test("creates and lists a workspace-scoped lead with a valid stage", async () => {
  const db = fakeDb({ "organizations/org_a/crmStages/new": { active: true } });
  const lead = await savePublicLead(db, "org_a", { title: "Website enquiry", stageId: "new", value: 2500 });
  assert.equal(lead.title, "Website enquiry");
  const listed = await listPublicLeads(db, "org_a", 20);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].id, lead.id);
});

test("updates and deletes only an existing lead in the selected workspace", async () => {
  const db = fakeDb({ "organizations/org_a/crmStages/new": { active: true }, "organizations/org_a/crmLeads/lead_1": { title: "Old" } });
  const updated = await savePublicLead(db, "org_a", { title: "Updated", stageId: "new" }, "lead_1");
  assert.equal(updated.title, "Updated");
  assert.deepEqual(await deletePublicLead(db, "org_a", "lead_1"), { id: "lead_1", deleted: true });
  await assert.rejects(() => deletePublicLead(db, "org_b", "lead_1"), { statusCode: 404 });
});

test("rejects invalid lead payloads, inactive stages and foreign contacts", async () => {
  const db = fakeDb({
    "organizations/org_a/crmStages/new": { active: false },
    "organizations/org_a/crmStages/qualified": { active: true }
  });
  await assert.rejects(() => savePublicLead(db, "org_a", { title: "", stageId: "new" }), { statusCode: 400 });
  await assert.rejects(() => savePublicLead(db, "org_a", { title: "Test", stageId: "new" }), { statusCode: 400 });
  await assert.rejects(() => savePublicLead(db, "org_a", { title: "Test", stageId: "qualified", contactId: "missing" }), { statusCode: 404 });
});
