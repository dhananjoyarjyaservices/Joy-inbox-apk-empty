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
        return { limit() { return { async get() {
          const prefix = path + "/";
          const docs = [...records.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
            .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value }));
          return { docs };
        } }; } };
      }
    };
  }
  return { records, collection };
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

test("tenant resource collection rejects malformed organization IDs and unknown resource names", () => {
  const { getTenantResourceCollection } = require("../src/tenantResources");
  const db = tenantResourceDb();
  assert.throws(() => getTenantResourceCollection(db, "../org_b", "contacts"), { statusCode: 400 });
  assert.throws(() => getTenantResourceCollection(db, "org_a", "members"), { statusCode: 400 });
});
