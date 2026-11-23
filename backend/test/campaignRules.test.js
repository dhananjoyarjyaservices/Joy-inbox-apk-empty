const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_CAMPAIGN_RECIPIENTS,
  normalizeCampaignDefinition,
  normalizeCampaignRecipients,
  canTransitionCampaign
} = require("../src/campaignRules");

test("campaign definition requires a valid WhatsApp template and connection", () => {
  const result = normalizeCampaignDefinition({
    name: "November offer",
    templateName: "november_offer",
    language: "en",
    category: "marketing",
    phoneNumberId: "123456789",
    wabaId: "987654321",
    variables: ["November"]
  });
  assert.equal(result.category, "MARKETING");
  assert.deepEqual(result.variables, ["November"]);
});

test("campaign definition rejects free-form or malformed template metadata", () => {
  assert.throws(() => normalizeCampaignDefinition({ name: "Test", templateName: "Hello world" }), /approved WhatsApp template/);
  assert.throws(() => normalizeCampaignDefinition({
    name: "Test", templateName: "test", language: "en", category: "PROMOTIONAL",
    phoneNumberId: "123456789", wabaId: "987654321"
  }), /category/);
});

test("recipient normalization requires opt-in evidence and deduplicates numbers", () => {
  const result = normalizeCampaignRecipients([
    { phone: "+919876543210", optedIn: true, consentAt: "2026-11-20T10:00:00.000Z", consentSource: "website form" },
    { phone: "919876543210", optedIn: true, consentAt: "2026-11-20T10:00:00.000Z", consentSource: "website form" },
    { phone: "919876543211", optedIn: false, consentAt: "2026-11-20T10:00:00.000Z", consentSource: "website form" },
    { phone: "919876543212", optedIn: true, consentAt: "not-a-date", consentSource: "website form" }
  ]);
  assert.equal(result.recipients.length, 1);
  assert.equal(result.skipped, 3);
  assert.equal(result.recipients[0].phone, "919876543210");
});

test("recipient normalization rejects empty or oversized campaigns", () => {
  assert.throws(() => normalizeCampaignRecipients([]), /1–5000/);
  assert.throws(() => normalizeCampaignRecipients(Array(MAX_CAMPAIGN_RECIPIENTS + 1).fill({})), /1–5000/);
  assert.throws(() => normalizeCampaignRecipients([
    { phone: "919876543210", optedIn: true, consentAt: "2026-11-20", consentSource: "CRM", variables: [42] }
  ]), /variables/);
});

test("campaign state transitions prevent resuming terminal campaigns", () => {
  assert.equal(canTransitionCampaign("draft", "queued"), true);
  assert.equal(canTransitionCampaign("sending", "paused"), true);
  assert.equal(canTransitionCampaign("completed", "queued"), false);
  assert.equal(canTransitionCampaign("cancelled", "sending"), false);
  assert.equal(canTransitionCampaign("unknown", "queued"), false);
});
