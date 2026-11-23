const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAutomationRule, matchesAutomationRule } = require("../src/automationRules");

test("normalizes valid keyword automation rules and defaults", () => {
  assert.deepEqual(normalizeAutomationRule({
    name: "  Pricing  ", keyword: " PRICE ", response: " Our plans start at ₹499. "
  }), {
    name: "Pricing", keyword: "PRICE", matchType: "contains",
    response: "Our plans start at ₹499.", enabled: true, priority: 100
  });
});

test("rejects invalid rule input and oversized replies", () => {
  assert.throws(() => normalizeAutomationRule({ name: "", keyword: "hi", response: "hello" }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ name: "Rule", keyword: "hi", response: "x".repeat(1025) }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ name: "Rule", keyword: "hi", response: "hello", enabled: "yes" }), { statusCode: 400 });
});

test("matches contains, exact and starts_with case-insensitively", () => {
  assert.equal(matchesAutomationRule({ keyword: "price", matchType: "contains" }, "What is the PRICE?"), true);
  assert.equal(matchesAutomationRule({ keyword: "price", matchType: "exact" }, " PRICE "), true);
  assert.equal(matchesAutomationRule({ keyword: "hi", matchType: "starts_with" }, "Hi there"), true);
  assert.equal(matchesAutomationRule({ keyword: "hi", matchType: "exact" }, "Hi there"), false);
  assert.equal(matchesAutomationRule({ keyword: "hi", matchType: "contains" }, ""), false);
});
