const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeFaqEntry, matchesFaqEntry, findMatchingFaqEntry } = require("../src/faqKnowledge");

test("normalizes FAQ entries and removes duplicate keywords", () => {
  assert.deepEqual(normalizeFaqEntry({
    question: "  What are your hours? ", answer: " We open at 9 AM. ",
    keywords: ["opening hours", "Opening Hours", "timing"], priority: 5
  }), {
    question: "What are your hours?", answer: "We open at 9 AM.",
    keywords: ["opening hours", "timing"], matchMode: "any", enabled: true, priority: 5
  });
});

test("rejects invalid FAQ entries and unsupported fields", () => {
  assert.throws(() => normalizeFaqEntry({ question: "", answer: "Answer", keywords: ["hours"] }), { statusCode: 400 });
  assert.throws(() => normalizeFaqEntry({ question: "Hours?", answer: "", keywords: ["hours"] }), { statusCode: 400 });
  assert.throws(() => normalizeFaqEntry({ question: "Hours?", answer: "Answer", keywords: [] }), { statusCode: 400 });
  assert.throws(() => normalizeFaqEntry({ question: "Hours?", answer: "Answer", keywords: ["hours"], hidden: true }), { statusCode: 400 });
  assert.throws(() => normalizeFaqEntry({ question: "Hours?", answer: "Answer", keywords: ["hours"], priority: 1001 }), { statusCode: 400 });
});

test("matches whole keyword phrases without accidental partial-word matches", () => {
  const entry = normalizeFaqEntry({ question: "Hours?", answer: "9 to 5", keywords: ["hours", "opening time"], matchMode: "any" });
  assert.equal(matchesFaqEntry(entry, "What are your opening time?"), true);
  assert.equal(matchesFaqEntry(entry, "What are the hours?"), true);
  assert.equal(matchesFaqEntry(entry, "Showers are expected"), false);
  assert.equal(matchesFaqEntry(entry, "hourglass"), false);
});

test("supports ALL matching and ignores disabled entries", () => {
  const entry = normalizeFaqEntry({ question: "Shipping?", answer: "3 days", keywords: ["shipping", "delivery"], matchMode: "all" });
  assert.equal(matchesFaqEntry(entry, "What about shipping?"), false);
  assert.equal(matchesFaqEntry(entry, "shipping and delivery time"), true);
  assert.equal(matchesFaqEntry({ ...entry, enabled: false }, "shipping and delivery"), false);
});

test("selects the lowest-priority-number matching FAQ", () => {
  const entries = [
    { id: "later", priority: 20, enabled: true, matchMode: "any", keywords: ["refund"] },
    { id: "first", priority: 2, enabled: true, matchMode: "any", keywords: ["refund"] }
  ];
  assert.equal(findMatchingFaqEntry(entries, "Can I get a refund?").id, "first");
  assert.equal(findMatchingFaqEntry([], "refund"), null);
});
