const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAutomationRule, matchesAutomationRule } = require("../src/automationRules");

test("normalizes valid keyword automation rules and defaults", () => {
  assert.deepEqual(normalizeAutomationRule({
    name: "  Pricing  ", keyword: " PRICE ", response: " Our plans start at ₹499. "
  }), {
    name: "Pricing", keyword: "PRICE", matchType: "contains",
    response: "Our plans start at ₹499.", steps: [{ message: "Our plans start at ₹499.", delaySeconds: 0 }], enabled: true, priority: 100
  });
});

test("rejects invalid rule input and oversized replies", () => {
  assert.throws(() => normalizeAutomationRule({ name: "", keyword: "hi", response: "hello" }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ name: "Rule", keyword: "hi", response: "x".repeat(1025) }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ name: "Rule", keyword: "hi", response: "hello", enabled: "yes" }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ name: "Rule", keyword: "hi\nthere", response: "hello" }), { statusCode: 400 });
});

test("matches contains, exact and starts_with case-insensitively", () => {
  assert.equal(matchesAutomationRule({ keyword: "price", matchType: "contains" }, "What is the PRICE?"), true);
  assert.equal(matchesAutomationRule({ keyword: "price", matchType: "exact" }, " PRICE "), true);
  assert.equal(matchesAutomationRule({ keyword: "hi", matchType: "starts_with" }, "Hi there"), true);
  assert.equal(matchesAutomationRule({ keyword: "hi", matchType: "exact" }, "Hi there"), false);
  assert.equal(matchesAutomationRule({ keyword: "hi", matchType: "contains" }, ""), false);
});

test("normalizes multi-step reply sequences and enforces the five-step limit", () => {
  const normalized = normalizeAutomationRule({
    name: "Product details", keyword: "details", steps: ["First message", "Second message"],
    matchType: "contains", priority: 10
  });
  assert.equal(normalized.response, "First message");
  assert.deepEqual(normalized.steps, [{ message: "First message", delaySeconds: 0 }, { message: "Second message", delaySeconds: 0 }]);
  assert.throws(() => normalizeAutomationRule({
    name: "Too many", keyword: "details", steps: ["1", "2", "3", "4", "5", "6"]
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Empty step", keyword: "details", steps: ["First", " "]
  }), { statusCode: 400 });
});

test("keeps legacy single-response rules compatible", () => {
  const normalized = normalizeAutomationRule({ name: "Legacy", keyword: "hello", response: "Welcome" });
  assert.deepEqual(normalized.steps, [{ message: "Welcome", delaySeconds: 0 }]);
});

test("validates delay seconds for later workflow steps", () => {
  const normalized = normalizeAutomationRule({
    name: "Delayed follow-up", keyword: "hello",
    steps: [{ message: "Welcome", delaySeconds: 0 }, { message: "Are you still there?", delaySeconds: 300 }]
  });
  assert.equal(normalized.steps[1].delaySeconds, 300);
  assert.throws(() => normalizeAutomationRule({
    name: "Too long delay", keyword: "hello",
    steps: [{ message: "Welcome" }, { message: "Follow up", delaySeconds: 86401 }]
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Invalid delay", keyword: "hello",
    steps: [{ message: "Welcome" }, { message: "Follow up", delaySeconds: 1.5 }]
  }), { statusCode: 400 });
});


test("rejects unknown workflow-step fields and invalid explicit match types", () => {
  assert.throws(() => normalizeAutomationRule({
    name: "Unsafe step", keyword: "hello",
    steps: [{ message: "Welcome", delaySeconds: 0, action: "send_payment" }]
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Invalid match", keyword: "hello", response: "Welcome", matchType: "regex"
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Invalid priority", keyword: "hello", response: "Welcome", priority: 1001
  }), { statusCode: 400 });
});

test("accepts only documented workflow step properties", () => {
  assert.deepEqual(normalizeAutomationRule({
    name: "Welcome", keyword: "hello",
    steps: [{ message: "Welcome", delaySeconds: 30 }]
  }).steps, [{ message: "Welcome", delaySeconds: 30 }]);
});
