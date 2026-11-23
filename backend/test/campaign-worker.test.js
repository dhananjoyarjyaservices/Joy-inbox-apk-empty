const test = require("node:test");
const assert = require("node:assert/strict");
const worker = require("../src/campaign-worker");

test("campaign delivery is disabled unless explicitly enabled", () => {
  const previous = process.env.CAMPAIGN_DELIVERY_ENABLED;
  delete process.env.CAMPAIGN_DELIVERY_ENABLED;
  assert.equal(worker.deliveryEnabled(), false);
  process.env.CAMPAIGN_DELIVERY_ENABLED = "false";
  assert.equal(worker.deliveryEnabled(), false);
  process.env.CAMPAIGN_DELIVERY_ENABLED = "true";
  assert.equal(worker.deliveryEnabled(), true);
  if (previous === undefined) delete process.env.CAMPAIGN_DELIVERY_ENABLED;
  else process.env.CAMPAIGN_DELIVERY_ENABLED = previous;
});

test("campaign retry backoff grows exponentially and is capped", () => {
  assert.equal(worker.retryDelayMs(1), 60_000);
  assert.equal(worker.retryDelayMs(2), 120_000);
  assert.equal(worker.retryDelayMs(3), 240_000);
  assert.equal(worker.retryDelayMs(20), 3_600_000);
});
