"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CAMPAIGN_ID_PATTERN, buildPublicCampaignTransition } = require("../src/publicCampaignControl");

test("validates campaign identifiers and builds allowed control transitions", () => {
  assert.equal(CAMPAIGN_ID_PATTERN.test("campaign_123"), true);
  assert.equal(CAMPAIGN_ID_PATTERN.test("bad/campaign"), false);
  const now = new Date("2026-11-24T12:00:00.000Z");
  assert.deepEqual(
    buildPublicCampaignTransition("start", { status: "draft", recipientCount: 3 }, null, now),
    { status: "queued", updatedAt: now, queuedAt: now }
  );
  assert.deepEqual(
    buildPublicCampaignTransition("pause", { status: "sending", recipientCount: 3 }, null, now),
    { status: "paused", updatedAt: now, pausedAt: now }
  );
  assert.deepEqual(
    buildPublicCampaignTransition("cancel", { status: "paused", recipientCount: 3 }, null, now),
    { status: "cancelled", updatedAt: now, cancelledAt: now }
  );
});

test("requires future schedule time and eligible recipients before queueing", () => {
  const now = new Date("2026-11-24T12:00:00.000Z");
  assert.throws(() => buildPublicCampaignTransition("schedule", { status: "draft", recipientCount: 2 }, "2026-11-24T11:59:00.000Z", now), { statusCode: 400 });
  assert.throws(() => buildPublicCampaignTransition("schedule", { status: "draft", recipientCount: 0 }, "2026-11-25T12:00:00.000Z", now), { statusCode: 409 });
  assert.throws(() => buildPublicCampaignTransition("start", { status: "draft", recipientCount: 0 }, null, now), { statusCode: 409 });
  assert.throws(() => buildPublicCampaignTransition("resume", { status: "paused", recipientCount: 0 }, null, now), { statusCode: 409 });
  assert.equal(buildPublicCampaignTransition("schedule", { status: "draft", recipientCount: 1 }, "2026-11-25T12:00:00.000Z", now).status, "scheduled");
});

test("rejects invalid campaign actions and illegal state transitions", () => {
  assert.throws(() => buildPublicCampaignTransition("send_everything", { status: "draft", recipientCount: 2 }), { statusCode: 400 });
  assert.throws(() => buildPublicCampaignTransition("start", { status: "completed", recipientCount: 2 }), { statusCode: 409 });
  assert.throws(() => buildPublicCampaignTransition("resume", { status: "sending", recipientCount: 2 }), { statusCode: 409 });
});
