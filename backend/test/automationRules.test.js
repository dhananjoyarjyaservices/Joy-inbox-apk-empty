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


test("sorts automation rules by numeric priority including zero with stable tie breakers", () => {
  const { sortAutomationRules } = require("../src/automationRules");
  const sorted = sortAutomationRules([
    { id: "z", name: "Alpha", priority: 100 },
    { id: "b", name: "Beta", priority: 0 },
    { id: "a", name: "Alpha", priority: 0 },
    { id: "c", name: "Default" }
  ]);
  assert.deepEqual(sorted.map(rule => rule.id), ["a", "b", "z", "c"]);
  assert.deepEqual(
    sortAutomationRules([{ id: "x", priority: 0 }, { id: "y", priority: 5 }]).map(rule => rule.id),
    ["x", "y"]
  );
});


test("selects the first enabled matching automation by priority and stable tie-breakers", () => {
  const { findMatchingAutomationRule } = require("../src/automationRules");
  const rules = [
    { id: "later", name: "Later", enabled: true, keyword: "price", priority: 100 },
    { id: "disabled", name: "Disabled", enabled: false, keyword: "price", priority: 0 },
    { id: "same-b", name: "Beta", enabled: true, keyword: "price", priority: 5 },
    { id: "same-a", name: "Alpha", enabled: true, keyword: "price", priority: 5 }
  ];
  assert.equal(findMatchingAutomationRule(rules, "What's the price?").id, "same-a");
  assert.equal(findMatchingAutomationRule(rules, "hello"), null);
});


test("normalizes bounded all/any multi-condition rules", () => {
  const all = normalizeAutomationRule({
    name: "Qualified pricing", conditions: [
      { keyword: "price", matchType: "contains" },
      { keyword: "monthly", matchType: "contains" }
    ], conditionMode: "all", response: "Here are the plans."
  });
  assert.equal(all.conditionMode, "all");
  assert.equal(all.conditions.length, 2);
  assert.equal(all.keyword, "price");
  const any = normalizeAutomationRule({
    name: "Support intent", conditions: [
      { keyword: "help" }, { keyword: "support", matchType: "starts_with" }
    ], conditionMode: "any", response: "How can we help?"
  });
  assert.equal(any.conditionMode, "any");
  assert.throws(() => normalizeAutomationRule({
    name: "Too many conditions", conditions: ["a", "b", "c", "d", "e", "f"].map(keyword => ({ keyword })), response: "Reply"
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Unknown condition field", conditions: [{ keyword: "price", regex: ".*" }], response: "Reply"
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Mixed formats", keyword: "price", conditions: [{ keyword: "monthly" }], response: "Reply"
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Bad condition mode", conditions: [{ keyword: "price" }], conditionMode: "not", response: "Reply"
  }), { statusCode: 400 });
});

test("evaluates all and any automation conditions without changing legacy matching", () => {
  const { matchesAutomationRule } = require("../src/automationRules");
  const allRule = {
    conditions: [{ keyword: "price", matchType: "contains" }, { keyword: "monthly", matchType: "contains" }],
    conditionMode: "all"
  };
  assert.equal(matchesAutomationRule(allRule, "What is the monthly price?"), true);
  assert.equal(matchesAutomationRule(allRule, "What is the price?"), false);
  const anyRule = {
    conditions: [{ keyword: "refund", matchType: "contains" }, { keyword: "cancel", matchType: "starts_with" }],
    conditionMode: "any"
  };
  assert.equal(matchesAutomationRule(anyRule, "Please refund me"), true);
  assert.equal(matchesAutomationRule(anyRule, "cancel my order"), true);
  assert.equal(matchesAutomationRule(anyRule, "I need help"), false);
  assert.equal(matchesAutomationRule({ keyword: "hello", matchType: "exact" }, "HELLO"), true);
});


test("normalizes Unicode compatibility forms and repeated whitespace for all condition modes", () => {
  const { normalizeAutomationMatchText } = require("../src/automationRules");
  assert.equal(normalizeAutomationMatchText("  ＰＲＩＣＥ\\t  LIST  "), "price list");
  assert.equal(matchesAutomationRule({ keyword: "price list", matchType: "exact" }, "  PRICE\\nLIST "), true);
  assert.equal(matchesAutomationRule({
    conditions: [{ keyword: "monthly plan" }, { keyword: "₹ ５００" }],
    conditionMode: "all"
  }, "Monthly\\tplan costs ₹ 500"), true);
});

test("does not match empty text or whitespace-only condition keywords", () => {
  assert.equal(matchesAutomationRule({ keyword: "hello", matchType: "contains" }, "   "), false);
  assert.equal(matchesAutomationRule({
    conditions: [{ keyword: "   " }], conditionMode: "any"
  }, "hello"), false);
});

test("rejects condition mode when no conditions are supplied", () => {
  assert.throws(() => normalizeAutomationRule({
    name: "Orphan mode", keyword: "hello", conditionMode: "any", response: "Welcome"
  }), { statusCode: 400 });
});
