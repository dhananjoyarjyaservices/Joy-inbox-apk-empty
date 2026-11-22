const test = require("node:test");
const assert = require("node:assert/strict");
const { contactInput, quickReplyInput } = require("../src/tenantResources");

test("validates and normalizes tenant contact data", () => {
  const result = contactInput({ name: " Alex ", phone: "+91 98765-43210", email: "", notes: "" });
  assert.equal(result.name, "Alex");
  assert.equal(result.phone, "+919876543210");
  assert.equal(result.phoneId, "919876543210");
  assert.equal(result.source, "local");
});

test("rejects invalid contact phone and extra fields", () => {
  assert.throws(() => contactInput({ name: "Alex", phone: "123" }), { statusCode: 400 });
  assert.throws(() => contactInput({ name: "Alex", phone: "+919876543210", organizationId: "other-org" }), { statusCode: 400 });
});

test("validates Quick Reply content and normalizes shortcut", () => {
  const result = quickReplyInput({ title: "Stock", shortcut: "/MStock", message: "Hello" });
  assert.deepEqual(result, { title: "Stock", shortcut: "mstock", message: "Hello" });
});

test("rejects invalid Quick Reply shortcut and oversized message", () => {
  assert.throws(() => quickReplyInput({ title: "x", shortcut: "bad shortcut", message: "ok" }), { statusCode: 400 });
  assert.throws(() => quickReplyInput({ title: "x", shortcut: "", message: "x".repeat(4097) }), { statusCode: 400 });
});
