const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldApplyMessageStatus } = require("../src/webhook");

test("WhatsApp message status can advance from sent to delivered and read", () => {
  assert.equal(shouldApplyMessageStatus("sent", "delivered"), true);
  assert.equal(shouldApplyMessageStatus("delivered", "read"), true);
  assert.equal(shouldApplyMessageStatus(undefined, "sent"), true);
});

test("WhatsApp delivery failure can replace sent status", () => {
  assert.equal(shouldApplyMessageStatus("sent", "failed"), true);
  assert.equal(shouldApplyMessageStatus("failed", "failed"), false);
});

test("late failure cannot overwrite delivered or read status", () => {
  assert.equal(shouldApplyMessageStatus("delivered", "failed"), false);
  assert.equal(shouldApplyMessageStatus("read", "failed"), false);
});

test("WhatsApp message status cannot move backwards", () => {
  assert.equal(shouldApplyMessageStatus("read", "delivered"), false);
  assert.equal(shouldApplyMessageStatus("delivered", "sent"), false);
  assert.equal(shouldApplyMessageStatus("sent", "sent"), false);
});

test("unknown message statuses are rejected", () => {
  assert.equal(shouldApplyMessageStatus("sent", "queued"), false);
  assert.equal(shouldApplyMessageStatus(undefined, "unknown"), false);
});
