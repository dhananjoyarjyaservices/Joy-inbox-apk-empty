"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_CAMPAIGNS_PER_RUN,
  MAX_RECIPIENTS_PER_CAMPAIGN,
  RECIPIENT_LEASE_MS,
  retryDelayMs,
  classifyCampaignSendError,
  buildTemplatePayload,
  claimCampaignRecipient,
  markExpiredCampaignRecipient
} = require("../src/campaignWorker");

test("campaign worker uses bounded batch sizes and retry delays", () => {
  assert.equal(MAX_CAMPAIGNS_PER_RUN, 5);
  assert.equal(MAX_RECIPIENTS_PER_CAMPAIGN, 10);
  assert.equal(RECIPIENT_LEASE_MS, 120000);
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(2), 2000);
  assert.equal(retryDelayMs(5), 16000);
});

test("classifies rate limits as retryable and ambiguous delivery as uncertain", () => {
  assert.equal(classifyCampaignSendError({ metaStatusCode: 429 }, 1), "retry");
  assert.equal(classifyCampaignSendError({ metaStatusCode: 429 }, 5), "failed");
  assert.equal(classifyCampaignSendError({ metaStatusCode: 400, definitive: true }, 1), "failed");
  assert.equal(classifyCampaignSendError(new Error("network timeout"), 1), "uncertain");
  assert.equal(classifyCampaignSendError({ metaStatusCode: 500 }, 1), "uncertain");
});

test("builds a WhatsApp approved template payload using recipient-specific body variables", () => {
  const payload = buildTemplatePayload(
    { templateName: "order_update", language: "en_US" },
    { phone: "919876543210", variables: ["A-123", "Shipped"] }
  );
  assert.equal(payload.messaging_product, "whatsapp");
  assert.equal(payload.to, "919876543210");
  assert.equal(payload.type, "template");
  assert.equal(payload.template.name, "order_update");
  assert.deepEqual(payload.template.components[0].parameters, [
    { type: "text", text: "A-123" },
    { type: "text", text: "Shipped" }
  ]);
});

test("omits the template body component when the approved template has no variables", () => {
  const payload = buildTemplatePayload(
    { templateName: "hello_world", language: "en" },
    { phone: "919876543210", variables: [] }
  );
  assert.deepEqual(payload.template, { name: "hello_world", language: { code: "en" } });
});

test("claims a pending recipient only while its campaign is queued or sending", async () => {
  const now = new Date("2026-11-23T12:00:00.000Z");
  const campaign = { status: "queued" };
  const recipient = { status: "pending", attempts: 1, phone: "919876543210" };
  const writes = [];
  const db = {
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          return { exists: true, data: () => ref === campaignRef ? campaign : recipient };
        },
        update(ref, patch) { writes.push({ ref, patch }); }
      });
    }
  };
  const campaignRef = {};
  const recipientRef = {};
  const claimed = await claimCampaignRecipient(db, campaignRef, recipientRef, now);
  assert.equal(claimed.attempts, 2);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].patch.status, "sending");
  assert.equal(writes[1].patch.status, "sending");
  assert.equal(writes[1].patch.leaseUntil.getTime(), now.getTime() + RECIPIENT_LEASE_MS);
});

test("does not claim recipients after a campaign is paused", async () => {
  const db = {
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          return { exists: true, data: () => ref === campaignRef ? { status: "paused" } : { status: "pending" } };
        },
        update() { assert.fail("Paused campaigns must not claim recipients."); }
      });
    }
  };
  const campaignRef = {};
  assert.equal(await claimCampaignRecipient(db, campaignRef, {}, new Date()), null);
});

test("marks an expired campaign delivery lease uncertain instead of retrying it", async () => {
  const now = new Date("2026-11-23T12:00:00.000Z");
  const campaign = { uncertainCount: 2 };
  const recipient = { status: "sending", leaseUntil: new Date(now.getTime() - 1) };
  const writes = [];
  const db = {
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          return { exists: true, data: () => ref === recipientRef ? recipient : campaign };
        },
        update(ref, patch) { writes.push({ ref, patch }); }
      });
    }
  };
  const campaignRef = {};
  const recipientRef = {};
  assert.equal(await markExpiredCampaignRecipient(db, campaignRef, recipientRef, now), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].patch.status, "uncertain");
  assert.equal(writes[1].patch.uncertainCount, 3);
  assert.match(writes[0].patch.error, /automatic resend was prevented/i);
});
