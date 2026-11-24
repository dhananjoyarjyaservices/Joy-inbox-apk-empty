"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { importCrmLeads } = require("../src/crmBulkImport");

function makeDb({ fields = [], stages = {}, contacts = {}, members = {} } = {}) {
  const records = new Map();
  let id = 0;
  function collectionFor(path) {
    return {
      doc(docId) {
        const docPath = path + "/" + (docId || "generated_" + (++id));
        return {
          id: docPath.split("/").pop(),
          path: docPath,
          async get() { const value = records.get(docPath); return { exists: value !== undefined, data: () => value }; },
          collection(name) { return collectionFor(docPath + "/" + name); }
        };
      },
      async get() {
        const prefix = path + "/";
        return { docs: [...records.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value })) };
      }
    };
  }
  const orgPath = "organizations/org_a";
  for (const [key, value] of Object.entries(stages)) records.set(orgPath + "/crmStages/" + key, value);
  for (const [key, value] of Object.entries(contacts)) records.set(orgPath + "/contacts/" + key, value);
  for (const [key, value] of Object.entries(members)) records.set(orgPath + "/members/" + key, value);
  for (const field of fields) records.set(orgPath + "/crmFields/" + field.id, field);
  const orgRef = { id: "org_a", collection: name => collectionFor(orgPath + "/" + name) };
  const db = {
    records,
    batch() {
      const writes = [];
      return { set(ref, value) { writes.push(() => records.set(ref.path, value)); }, async commit() { writes.forEach(write => write()); } };
    }
  };
  return { db, organization: { id: "org_a", ref: orgRef, role: "owner" } };
}

test("imports valid CRM leads and returns row-specific validation errors", async () => {
  const { db, organization } = makeDb({
    stages: { new: { name: "New", active: true } },
    contacts: { contact_1: { name: "Customer" } },
    members: { agent_1: { status: "active" } }
  });
  const result = await importCrmLeads(db, organization, "owner_1", [
    { title: "Website enquiry", stageId: "new", contactId: "contact_1", ownerUid: "agent_1", value: 5000 },
    { title: "", stageId: "new" },
    { title: "Unknown stage", stageId: "missing" }
  ], new Date("2026-11-24T12:00:00Z"));
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.errors[0].row, 3);
  assert.equal([...db.records.keys()].filter(path => path.includes("/crmLeads/")).length, 1);
});

test("rejects agent bulk import and batches larger than 200 rows", async () => {
  const { db, organization } = makeDb();
  await assert.rejects(() => importCrmLeads(db, { ...organization, role: "agent" }, "agent_1", [{ title: "Lead" }]), { statusCode: 403 });
  await assert.rejects(() => importCrmLeads(db, organization, "owner_1", Array.from({ length: 201 }, () => ({ title: "Lead" }))), { statusCode: 400 });
});

test("does not write any rows when every imported row fails validation", async () => {
  const { db, organization } = makeDb();
  const result = await importCrmLeads(db, organization, "owner_1", [{ title: "" }, { title: "Invalid stage", stageId: "bad" }]);
  assert.equal(result.imported, 0);
  assert.equal(result.failed, 2);
  assert.equal([...db.records.keys()].filter(path => path.includes("/crmLeads/")).length, 0);
});
