const test = require("node:test");
const assert = require("node:assert/strict");
const { contactInput, quickReplyInput } = require("../src/tenantResources");

test("validates and normalizes tenant contact data", () => {
  const result = contactInput({ name: " Alex ", phone: "+91 98765-43210", email: "", notes: "" });
  assert.equal(result.name, "Alex");
  assert.equal(result.phone, "+919876543210");
  assert.equal(result.phoneId, "919876543210");
  assert.equal(result.source, "local");
  assert.deepEqual(result.tags, []);
  assert.deepEqual(contactInput({ name: "Alex", phone: "+919876543210", tags: [" VIP ", "vip", "Follow up"] }).tags, ["VIP", "Follow up"]);
  assert.throws(() => contactInput({ name: "Alex", phone: "+919876543210", tags: ["x".repeat(31)] }), { statusCode: 400 });
});

test("rejects invalid contact phone and extra fields", () => {
  assert.throws(() => contactInput({ name: "Alex", phone: "123" }), { statusCode: 400 });
  assert.throws(() => contactInput({ name: "Alex", phone: "+919876543210", organizationId: "other-org" }), { statusCode: 400 });
});

test("validates Quick Reply content and normalizes shortcut", () => {
  const result = quickReplyInput({ title: "Stock", shortcut: "/MStock", message: "Hello" });
  assert.deepEqual(result, { title: "Stock", shortcut: "mstock", message: "Hello" });
});

test("allows image-only Quick Replies while keeping the title required", () => {
  assert.deepEqual(quickReplyInput({ title: "Product photo", shortcut: "photo", message: "" }), {
    title: "Product photo", shortcut: "photo", message: ""
  });
  assert.throws(() => quickReplyInput({ title: "", shortcut: "photo", message: "" }), { statusCode: 400 });
});

test("rejects invalid Quick Reply shortcut and oversized message", () => {
  assert.throws(() => quickReplyInput({ title: "x", shortcut: "bad shortcut", message: "ok" }), { statusCode: 400 });
  assert.throws(() => quickReplyInput({ title: "x", shortcut: "", message: "x".repeat(4097) }), { statusCode: 400 });
});


function tenantResourceDb(seed = {}) {
  const records = new Map(Object.entries(seed));
  let generatedId = 0;
  function reference(path) {
    return {
      id: path.split("/").pop(),
      path,
      async get() {
        const value = records.get(path);
        return { exists: Boolean(value), data: () => value };
      },
      async set(value, options) {
        records.set(path, options?.merge ? { ...(records.get(path) || {}), ...value } : value);
      },
      async delete() { records.delete(path); },
      collection(name) { return collection(path + "/" + name); }
    };
  }
  function collection(path) {
    return {
      doc(id) { return reference(path + "/" + (id || "generated_" + (++generatedId))); },
      orderBy() {
        const read = async () => {
          const prefix = path + "/";
          const docs = [...records.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
            .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value }));
          return { docs };
        };
        const state = { cursor: null, max: Infinity };
        const query = {
          orderBy() { return query; },
          startAfter(name, id) { state.cursor = { name, id }; return query; },
          limit(value) { state.max = value; return query; },
          async get() {
            const result = await read();
            const sorted = result.docs.sort((a, b) => String(a.data()?.name || "").localeCompare(String(b.data()?.name || "")) || a.id.localeCompare(b.id));
            const after = state.cursor ? sorted.filter(doc => {
              const name = String(doc.data()?.name || "");
              return name > state.cursor.name || (name === state.cursor.name && doc.id.localeCompare(state.cursor.id) > 0);
            }) : sorted;
            return { docs: after.slice(0, state.max) };
          }
        };
        return query;
      }
    };
  }
  return {
    records,
    collection,
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = records.get(ref.path);
          return { exists: Boolean(value), data: () => value };
        },
        set(ref, value, options) { writes.push({ type: "set", path: ref.path, value, merge: options?.merge }); },
        delete(ref) { writes.push({ type: "delete", path: ref.path }); }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        if (write.type === "delete") records.delete(write.path);
        else records.set(write.path, write.merge ? { ...(records.get(write.path) || {}), ...write.value } : write.value);
      }
      return result;
    }
  };
}

test("tenant contact updates and deletes stay inside the selected organization", async () => {
  const { getTenantResourceCollection, saveTenantResource, deleteTenantResource } = require("../src/tenantResources");
  const phoneId = "919876543210";
  const db = tenantResourceDb({
    [`organizations/org_a/contacts/${phoneId}`]: { name: "A Contact", phone: "+919876543210" },
    [`organizations/org_b/contacts/${phoneId}`]: { name: "B Private Contact", phone: "+919876543210" }
  });
  await saveTenantResource(db, "org_a", "contacts", { name: "Updated A", phone: "+919876543210" }, phoneId);
  assert.equal(db.records.get(`organizations/org_a/contacts/${phoneId}`).name, "Updated A");
  assert.equal(db.records.get(`organizations/org_b/contacts/${phoneId}`).name, "B Private Contact");
  await deleteTenantResource(db, "org_a", "contacts", phoneId);
  assert.equal(db.records.has(`organizations/org_a/contacts/${phoneId}`), false);
  assert.equal(db.records.get(`organizations/org_b/contacts/${phoneId}`).name, "B Private Contact");
  assert.equal(getTenantResourceCollection(db, "org_b", "contacts").doc(phoneId).id, phoneId);
});


test("changing a tenant contact phone number atomically moves the contact and preserves creation time", async () => {
  const { saveTenantResource } = require("../src/tenantResources");
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const oldId = "919876543210";
  const newId = "919876543211";
  const db = tenantResourceDb({
    [`organizations/org_a/contacts/${oldId}`]: { name: "Alex", phone: "+919876543210", createdAt }
  });
  await saveTenantResource(db, "org_a", "contacts", { name: "Alex Updated", phone: "+919876543211" }, oldId);
  assert.equal(db.records.has(`organizations/org_a/contacts/${oldId}`), false);
  const moved = db.records.get(`organizations/org_a/contacts/${newId}`);
  assert.equal(moved.name, "Alex Updated");
  assert.equal(moved.createdAt, createdAt);
  assert.ok(moved.updatedAt instanceof Date);
});

test("changing a tenant contact phone rejects an existing destination without modifying either contact", async () => {
  const { saveTenantResource } = require("../src/tenantResources");
  const oldId = "919876543210";
  const newId = "919876543211";
  const db = tenantResourceDb({
    [`organizations/org_a/contacts/${oldId}`]: { name: "Original", phone: "+919876543210" },
    [`organizations/org_a/contacts/${newId}`]: { name: "Existing", phone: "+919876543211" }
  });
  await assert.rejects(
    () => saveTenantResource(db, "org_a", "contacts", { name: "Original renamed", phone: "+919876543211" }, oldId),
    { statusCode: 409 }
  );
  assert.equal(db.records.get(`organizations/org_a/contacts/${oldId}`).name, "Original");
  assert.equal(db.records.get(`organizations/org_a/contacts/${newId}`).name, "Existing");
});

test("changing a tenant contact phone rejects a missing source contact", async () => {
  const { saveTenantResource } = require("../src/tenantResources");
  const db = tenantResourceDb();
  await assert.rejects(
    () => saveTenantResource(db, "org_a", "contacts", { name: "Alex", phone: "+919876543211" }, "919876543210"),
    { statusCode: 404 }
  );
  assert.equal(db.records.size, 0);
});

test("tenant Quick Reply updates and deletes cannot affect another organization with the same document ID", async () => {
  const { saveTenantResource, deleteTenantResource } = require("../src/tenantResources");
  const replyId = "shared_reply_id";
  const db = tenantResourceDb({
    [`organizations/org_a/quickReplies/${replyId}`]: { title: "A Reply", message: "A" },
    [`organizations/org_b/quickReplies/${replyId}`]: { title: "B Private Reply", message: "B" }
  });
  await saveTenantResource(db, "org_a", "quickReplies", { title: "Updated A", shortcut: "a", message: "A updated" }, replyId);
  assert.equal(db.records.get(`organizations/org_a/quickReplies/${replyId}`).title, "Updated A");
  assert.equal(db.records.get(`organizations/org_b/quickReplies/${replyId}`).title, "B Private Reply");
  await deleteTenantResource(db, "org_a", "quickReplies", replyId);
  assert.equal(db.records.has(`organizations/org_a/quickReplies/${replyId}`), false);
  assert.equal(db.records.get(`organizations/org_b/quickReplies/${replyId}`).message, "B");
});

test("tenant Quick Reply listing has no artificial 500-item ceiling", async () => {
  const { listTenantResource } = require("../src/tenantResources");
  const seed = {};
  for (let index = 0; index < 501; index += 1) {
    seed[`organizations/org_a/quickReplies/reply_${index}`] = { title: `Reply ${index}`, message: "Hello" };
  }
  const db = tenantResourceDb(seed);
  const replies = await listTenantResource(db, "org_a", "quickReplies");
  assert.equal(replies.length, 501);
});

test("tenant resource collection rejects malformed organization IDs and unknown resource names", () => {
  const { getTenantResourceCollection } = require("../src/tenantResources");
  const db = tenantResourceDb();
  assert.throws(() => getTenantResourceCollection(db, "../org_b", "contacts"), { statusCode: 400 });
  assert.throws(() => getTenantResourceCollection(db, "org_a", "members"), { statusCode: 400 });
});


test("public contacts use stable cursor pagination and reject invalid cursors or limits", async () => {
  const { listPublicContacts } = require("../src/tenantResources");
  const seed = {};
  for (const [id, name] of [["919000000001", "Alex"], ["919000000002", "Alex"], ["919000000003", "Zara"]]) {
    seed[`organizations/org_a/contacts/${id}`] = { name, phone: "+" + id };
  }
  const db = tenantResourceDb(seed);
  const first = await listPublicContacts(db, "org_a", 2);
  assert.equal(first.data.length, 2);
  assert.equal(first.pagination.hasMore, true);
  assert.ok(first.pagination.nextCursor);
  const second = await listPublicContacts(db, "org_a", 2, first.pagination.nextCursor);
  assert.equal(second.data.length, 1);
  assert.equal(second.pagination.hasMore, false);
  assert.equal(second.pagination.nextCursor, null);
  assert.notEqual(first.data[1].id, second.data[0].id);
  await assert.rejects(() => listPublicContacts(db, "org_a", 0), { statusCode: 400 });
  await assert.rejects(() => listPublicContacts(db, "org_a", 101), { statusCode: 400 });
  await assert.rejects(() => listPublicContacts(db, "org_a", 10, "bad-cursor"), { statusCode: 400 });
});


test("tenant contacts persist typed CRM custom fields without requiring lead-only required fields", () => {
  const definitions = [
    { key: "company", label: "Company", type: "text", required: true, active: true },
    { key: "budget", label: "Budget", type: "number", active: true },
    { key: "vip", label: "VIP", type: "boolean", active: true },
    { key: "segment", label: "Segment", type: "select", options: ["Retail", "Wholesale"], active: true }
  ];
  const contact = contactInput({
    name: "Alex", phone: "+919876543210",
    customFields: { company: "Acme", budget: 12500, vip: true, segment: "Wholesale" }
  }, definitions);
  assert.deepEqual(contact.customFields, { company: "Acme", budget: 12500, vip: true, segment: "Wholesale" });
  assert.deepEqual(contactInput({ name: "Sam", phone: "+919876543211", customFields: {} }, definitions).customFields, {});
  assert.throws(() => contactInput({
    name: "Alex", phone: "+919876543210", customFields: { budget: "not-a-number" }
  }, definitions), { statusCode: 400 });
  assert.throws(() => contactInput({
    name: "Alex", phone: "+919876543210", customFields: { segment: "Unknown" }
  }, definitions), { statusCode: 400 });
  assert.throws(() => contactInput({
    name: "Alex", phone: "+919876543210", customFields: { unexpected: "value" }
  }, definitions), { statusCode: 400 });
});

test("tenant contact custom fields survive ordinary edits that do not submit custom field values", async () => {
  const { saveTenantResource } = require("../src/tenantResources");
  const id = "919876543210";
  const db = tenantResourceDb({
    [`organizations/org_a/contacts/${id}`]: {
      name: "Alex", phone: "+919876543210", customFields: { company: "Acme" }
    }
  });
  await saveTenantResource(db, "org_a", "contacts", { name: "Alex Updated", phone: "+919876543210" }, id);
  assert.deepEqual(db.records.get(`organizations/org_a/contacts/${id}`).customFields, { company: "Acme" });
});


test("changing a contact phone preserves existing CRM custom field values", async () => {
  const { saveTenantResource } = require("../src/tenantResources");
  const oldId = "919876543210";
  const newId = "919876543211";
  const customFields = { company: "Acme", vip: true };
  const db = tenantResourceDb({
    [`organizations/org_a/contacts/${oldId}`]: {
      name: "Alex", phone: "+919876543210", customFields, createdAt: new Date("2026-01-01T00:00:00Z")
    }
  });
  await saveTenantResource(db, "org_a", "contacts", { name: "Alex", phone: "+919876543211" }, oldId);
  assert.deepEqual(db.records.get(`organizations/org_a/contacts/${newId}`).customFields, customFields);
});
