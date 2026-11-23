const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidScheduledStepIndex } = require("../src/automationScheduler");

test("accepts zero-based automation flow step indexes", () => {
  for (let index = 0; index <= 4; index += 1) {
    assert.equal(isValidScheduledStepIndex(index), true, `step ${index} should be valid`);
  }
});

test("rejects out-of-range and non-integer automation step indexes", () => {
  for (const value of [-1, 5, 1.5, "0", NaN, Infinity, null]) {
    assert.equal(isValidScheduledStepIndex(value), false);
  }
});
