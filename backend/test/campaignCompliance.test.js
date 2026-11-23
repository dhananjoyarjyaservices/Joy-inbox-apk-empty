"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  suppressionDocumentId,
  isWhatsAppOptOutMessage,
  recordCampaignOptOut,
  filterSuppressedCampaignRecipients
} = require("../src/campaignCompliance");

test("recognizes common WhatsApp opt-out keywords without matching ordinary text", () => {
  for (const value of ["STOP", "stop all", "Unsubscribe!", "cancel", "END", "quit", "opt out", "Please stop sending me messages", "dont message me"]) {
    assert.equal(isWhatsAppOptOutMessage(value), true, value);
  }
  for (const value of ["please stop by tomorrow", "stopwatch", "I need help", ""]) {
    assert.equal(isWhatsAppOptOutMessage(value), false, value);
  }
});

test("suppression IDs are deterministic and normalize phone punctuation", () => {
  assert.equal(suppressionDocumentId("+91 98765-43210"), suppressionDocumentId("919876543210"));
  assert.throws(() => suppressionDocumentId("123"), /valid international phone/);
});

test("recordCampaignOptOut creates an organization-scoped suppression record", async () => {
  let stored;
  const ref = {
    async get() { return { exists: Boolean(stored), data: () => stored }; }
  };
  const db = {
    collection(name) {
      assert.equal(name, "organizations");
      return { doc(id) {
        assert.equal(id, "org_123");
        return { collection(child) {
          assert.equal(child, "campaignSuppressions");
          return { doc(id) { assert.equal(id, suppressionDocumentId("919876543210")); return ref; } };
        } };
      } };
    },
    async runTransaction(callback) {
      await callback({
        get: async () => ({ exists: Boolean(stored), data: () => stored }),
        create: (_ref, value) => { stored = value; },
        set: (_ref, value, options) => { stored = options?.merge ? { ...stored, ...value } : value; }
      });
    }
  };
  const result = await recordCampaignOptOut(db, "org_123", "+91 98765 43210", "wamid.123");
  assert.equal(result.status, "opted_out");
  assert.equal(stored.phone, "919876543210");
  assert.equal(stored.source, "whatsapp_inbound");
  assert.equal(stored.lastInboundMessageId, "wamid.123");
});

test("campaign recipient filtering excludes suppressed recipients in bounded batches", async () => {
  const suppressedId = suppressionDocumentId("919876543210");
  const db = {
    collection() {
      return { doc() {
        return { collection() {
          return { doc(id) { return { get: async () => ({ exists: id === suppressedId, data: () => ({ status: "opted_out" }) }) }; } };
        } };
      } };
    }
  };
  const recipients = [
    { phone: "919876543210" },
    { phone: "919876543211" }
  ];
  const result = await filterSuppressedCampaignRecipients(db, "org_123", recipients);
  assert.deepEqual(result.recipients, [recipients[1]]);
  assert.equal(result.suppressed, 1);
});

test("a new STOP reply re-applies suppression even after a prior active status", async () => {
  let stored = {
    phone: "919876543210",
    status: "active",
    optedOutAt: new Date("2026-01-01T00:00:00Z")
  };
  const ref = { async get() { return { exists: true, data: () => stored }; } };
  const db = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
    async runTransaction(callback) {
      await callback({
        get: async () => ({ exists: true, data: () => stored }),
        set: (_ref, value, options) => { stored = options?.merge ? { ...stored, ...value } : value; }
      });
    }
  };
  await recordCampaignOptOut(db, "org_123", "919876543210", "wamid.stop-again");
  assert.equal(stored.status, "opted_out");
  assert.equal(stored.source, "whatsapp_inbound");
  assert.equal(stored.lastInboundMessageId, "wamid.stop-again");
});
