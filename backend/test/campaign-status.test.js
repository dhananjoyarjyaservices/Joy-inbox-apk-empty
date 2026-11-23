const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldAdvanceDeliveryStatus } = require("../src/webhook");

test("campaign delivery status advances from sent to delivered and read", () => {
  assert.equal(shouldAdvanceDeliveryStatus("sent", "delivered"), true);
  assert.equal(shouldAdvanceDeliveryStatus("delivered", "read"), true);
  assert.equal(shouldAdvanceDeliveryStatus("sent", "read"), true);
});

test("campaign delivery status ignores stale or terminal updates", () => {
  assert.equal(shouldAdvanceDeliveryStatus("read", "delivered"), false);
  assert.equal(shouldAdvanceDeliveryStatus("read", "failed"), false);
  assert.equal(shouldAdvanceDeliveryStatus("delivered", "sent"), false);
  assert.equal(shouldAdvanceDeliveryStatus("failed", "delivered"), false);
  assert.equal(shouldAdvanceDeliveryStatus("queued", "unknown"), false);
});

test("campaign delivery failures can replace sent but not delivered", () => {
  assert.equal(shouldAdvanceDeliveryStatus("sent", "failed"), true);
  assert.equal(shouldAdvanceDeliveryStatus("delivered", "failed"), false);
});
