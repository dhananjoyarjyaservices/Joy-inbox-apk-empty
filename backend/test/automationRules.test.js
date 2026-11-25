const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAutomationRule, matchesAutomationRule, selectAutomationBranch, findMatchingAutomationRule, findMatchingOutOfOfficeRule, getOutOfOfficeSkipReason } = require("../src/automationRules");

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
  assert.equal(normalizeAutomationMatchText("  ＰＲＩＣＥ\t  LIST  "), "price list");
  assert.equal(matchesAutomationRule({ keyword: "price list", matchType: "exact" }, "  PRICE\nLIST "), true);
  assert.equal(matchesAutomationRule({
    conditions: [{ keyword: "monthly plan" }, { keyword: "₹ ５００" }],
    conditionMode: "all"
  }, "Monthly\tplan costs ₹ 500"), true);
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


test("supports ends_with, not_contains and not_exact conditions", () => {
  assert.equal(matchesAutomationRule({ keyword: "thanks", matchType: "ends_with" }, "Many thanks"), true);
  assert.equal(matchesAutomationRule({ keyword: "price", matchType: "not_contains" }, "I need support"), true);
  assert.equal(matchesAutomationRule({ keyword: "hello", matchType: "not_exact" }, "hello there"), true);
  assert.equal(matchesAutomationRule({ keyword: "hello", matchType: "not_exact" }, "HELLO"), false);
  assert.equal(matchesAutomationRule({ keyword: "price", matchType: "not_contains" }, "What is the price?"), false);
});

test("validates and evaluates expanded operators in all/any condition groups", () => {
  const rule = normalizeAutomationRule({
    name: "Support without pricing",
    conditions: [
      { keyword: "help", matchType: "starts_with" },
      { keyword: "price", matchType: "not_contains" }
    ],
    conditionMode: "all",
    response: "How can we help?"
  });
  assert.equal(matchesAutomationRule(rule, "Help me with setup"), true);
  assert.equal(matchesAutomationRule(rule, "Help me with price details"), false);
  assert.throws(() => normalizeAutomationRule({
    name: "Invalid operator",
    conditions: [{ keyword: "hello", matchType: "regex" }],
    response: "Welcome"
  }), { statusCode: 400 });
});


test("validates timezone-aware weekday automation schedules", () => {
  const scheduled = normalizeAutomationRule({
    name: "Business hours", keyword: "hello", response: "Welcome",
    schedule: { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" }
  });
  assert.deepEqual(scheduled.schedule, {
    timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00"
  });
  assert.throws(() => normalizeAutomationRule({
    name: "Bad timezone", keyword: "hello", response: "Welcome",
    schedule: { timezone: "Mars/Olympus", days: [1], startTime: "09:00", endTime: "18:00" }
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Bad day", keyword: "hello", response: "Welcome",
    schedule: { timezone: "UTC", days: [1, 1], startTime: "09:00", endTime: "18:00" }
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Overnight not supported", keyword: "hello", response: "Welcome",
    schedule: { timezone: "UTC", days: [1], startTime: "22:00", endTime: "06:00" }
  }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({
    name: "Unknown schedule key", keyword: "hello", response: "Welcome",
    schedule: { timezone: "UTC", days: [1], startTime: "09:00", endTime: "18:00", enabled: true }
  }), { statusCode: 400 });
});

test("matches scheduled automations using the configured local timezone and weekday", () => {
  const { isWithinAutomationSchedule, findMatchingAutomationRule } = require("../src/automationRules");
  const rule = normalizeAutomationRule({
    name: "Weekday support", keyword: "help", response: "Support",
    schedule: { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" }
  });
  assert.equal(isWithinAutomationSchedule(rule, new Date("2026-11-23T04:00:00.000Z")), true); // Monday 09:30 IST
  assert.equal(isWithinAutomationSchedule(rule, new Date("2026-11-23T13:00:00.000Z")), false); // Monday 18:30 IST
  assert.equal(isWithinAutomationSchedule(rule, new Date("2026-11-22T04:00:00.000Z")), false); // Sunday
  assert.equal(findMatchingAutomationRule([rule], "help", new Date("2026-11-23T04:00:00.000Z")).name, "Weekday support");
  assert.equal(findMatchingAutomationRule([rule], "help", new Date("2026-11-23T13:00:00.000Z")), null);
  assert.equal(isWithinAutomationSchedule({ keyword: "help" }, new Date("invalid")), true);
});


test("normalizes bounded conditional branches with separate reply paths", () => {
  const { selectAutomationSteps } = require("../src/automationRules");
  const rule = normalizeAutomationRule({
    name: "Product routing", keyword: "details", response: "General help",
    branches: [
      { name: "Pricing", conditions: [{ keyword: "price" }], steps: ["Pricing details"] },
      { name: "Support", conditions: [{ keyword: "help" }, { keyword: "issue" }], conditionMode: "any",
        steps: [{ message: "Support team", delaySeconds: 60 }] }
    ]
  });
  assert.equal(rule.branches.length, 2);
  assert.deepEqual(selectAutomationSteps(rule, "What is the PRICE?"), [{ message: "Pricing details", delaySeconds: 0 }]);
  assert.deepEqual(selectAutomationSteps(rule, "I need help"), [{ message: "Support team", delaySeconds: 60 }]);
  assert.deepEqual(selectAutomationSteps(rule, "Something else"), rule.steps);
});

test("rejects malformed or unsafe automation branch definitions", () => {
  const base = { name: "Branches", keyword: "hello", response: "Fallback" };
  assert.throws(() => normalizeAutomationRule({ ...base, branches: [] }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ ...base, branches: [{ name: "x", conditions: [], steps: ["Reply"] }] }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ ...base, branches: [
    { name: "same", conditions: [{ keyword: "a" }], steps: ["A"] },
    { name: "SAME", conditions: [{ keyword: "b" }], steps: ["B"] }
  ] }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ ...base, branches: [
    { name: "unsafe", conditions: [{ keyword: "a", matchType: "regex" }], steps: ["A"] }
  ] }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ ...base, branches: [
    { name: "unsafe step", conditions: [{ keyword: "a" }], steps: [{ message: "A", action: "send" }] }
  ] }), { statusCode: 400 });
});


test("selects the first matching branch and exposes branch metadata", () => {
  const rule = {
    steps: [{ message: "Default reply", delaySeconds: 0 }],
    branches: [
      { name: "Pricing", conditionMode: "all", conditions: [{ keyword: "price", matchType: "contains" }, { keyword: "monthly", matchType: "contains" }], steps: [{ message: "Monthly pricing", delaySeconds: 30 }] },
      { name: "Support", conditionMode: "any", conditions: [{ keyword: "help", matchType: "contains" }], steps: [{ message: "Support reply", delaySeconds: 0 }] }
    ]
  };
  assert.deepEqual(selectAutomationBranch(rule, "What is the monthly price?"), {
    branchName: "Pricing", branchIndex: 0, steps: [{ message: "Monthly pricing", delaySeconds: 30 }]
  });
  assert.deepEqual(selectAutomationBranch(rule, "I need help"), {
    branchName: "Support", branchIndex: 1, steps: [{ message: "Support reply", delaySeconds: 0 }]
  });
  assert.deepEqual(selectAutomationBranch(rule, "Hello"), {
    branchName: null, branchIndex: null, steps: [{ message: "Default reply", delaySeconds: 0 }]
  });
});


test("validates out-of-office fallback replies and requires a schedule", () => {
  const base = { name: "Support hours", keyword: "support", response: "We are online.", schedule: { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" } };
  const normalized = normalizeAutomationRule({ ...base, outOfOfficeMessage: "We are away. We will reply during business hours." });
  assert.equal(normalized.outOfOfficeMessage, "We are away. We will reply during business hours.");
  assert.throws(() => normalizeAutomationRule({ ...base, schedule: undefined, outOfOfficeMessage: "Away" }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ ...base, outOfOfficeMessage: "x".repeat(1025) }), { statusCode: 400 });
  assert.throws(() => normalizeAutomationRule({ ...base, outOfOfficeMessage: 12 }), { statusCode: 400 });
});

test("selects an out-of-office fallback only outside its configured local hours", () => {
  const rule = normalizeAutomationRule({
    name: "Support", keyword: "support", response: "A teammate will help.",
    schedule: { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" },
    outOfOfficeMessage: "We are currently away."
  });
  const rules = [{ ...rule, id: "support" }];
  assert.equal(findMatchingAutomationRule(rules, "I need support", new Date("2026-11-25T05:00:00Z")).id, "support");
  assert.equal(findMatchingOutOfOfficeRule(rules, "I need support", new Date("2026-11-25T15:00:00Z")).id, "support");
  assert.equal(findMatchingOutOfOfficeRule(rules, "I need support", new Date("2026-11-25T05:00:00Z")), null);
  assert.equal(findMatchingOutOfOfficeRule(rules, "I need pricing", new Date("2026-11-25T15:00:00Z")), null);
});
test("suppresses repeated out-of-office replies for 24 hours and concurrent sends", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  assert.equal(getOutOfOfficeSkipReason({ outOfOfficeSentAt: new Date(now.getTime() - 23 * 60 * 60 * 1000) }, now), "out_of_office_cooldown");
  assert.equal(getOutOfOfficeSkipReason({ outOfOfficeSentAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, now), null);
  assert.equal(getOutOfOfficeSkipReason({
    outOfOfficeClaimedFor: "run-1",
    outOfOfficeClaimedAt: new Date(now.getTime() - 60 * 1000)
  }, now), "out_of_office_send_in_progress");
  assert.equal(getOutOfOfficeSkipReason({
    outOfOfficeClaimedFor: "run-1",
    outOfOfficeClaimedAt: new Date(now.getTime() - 3 * 60 * 1000)
  }, now), null);
});
