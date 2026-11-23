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
  markExpiredCampaignRecipient,
  finishRecipient,
  verifyApprovedTemplate,
  processCampaign
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

test("revalidates template approval and reads the approved body variable count", async () => {
  let requestedUrl = "";
  const count = await verifyApprovedTemplate(
    { wabaId: "123456789", templateName: "order_update", language: "en", category: "UTILITY" },
    { accessToken: "server-secret" },
    async (url, options) => {
      requestedUrl = url;
      assert.equal(options.headers.Authorization, "Bearer server-secret");
      return {
        ok: true,
        async json() {
          return { data: [{
            name: "order_update", language: "en", status: "APPROVED", category: "UTILITY",
            components: [{ type: "BODY", text: "Order {{1}} is {{2}}" }]
          }] };
        }
      };
    }
  );
  assert.equal(count, 2);
  assert.match(requestedUrl, /message_templates/);
  await assert.rejects(
    verifyApprovedTemplate(
      { wabaId: "123456789", templateName: "media_update", language: "en", category: "UTILITY" },
      { accessToken: "server-secret" },
      async () => ({
        ok: true,
        async json() {
          return { data: [{
            name: "media_update", language: "en", status: "APPROVED", category: "UTILITY",
            components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello" }]
          }] };
        }
      })
    ),
    /header or button parameter not supported/i
  );
});

function createCampaignHarness(suppressionStatus = null) {
  const campaign = {
    status: "queued", organizationId: "org_1", phoneNumberId: "123456789",
    wabaId: "987654321", templateName: "order_update", language: "en",
    category: "UTILITY", recipientCount: 1, sentCount: 0, failedCount: 0,
    uncertainCount: 0, skippedCount: 0, createdAt: new Date()
  };
  const recipient = {
    status: "pending", phone: "919876543210", optedIn: true,
    consentAt: "2026-11-20T10:00:00.000Z", consentSource: "website form",
    variables: ["ORD-1"], updatedAt: new Date()
  };
  const writes = [];
  const suppressionRef = { async get() { return { exists: Boolean(suppressionStatus), get: () => suppressionStatus }; } };
  const campaignRef = {
    id: "campaign_1",
    parent: { parent: null },
    async get() { return { exists: true, data: () => campaign, get: key => campaign[key] }; },
    async set(patch, options) { Object.assign(campaign, patch); writes.push({ type: "campaignSet", patch, options }); },
    collection(name) {
      if (name !== "recipients") throw new Error("Unexpected collection " + name);
      return {
        where(field, operator, value) {
          let status = value;
          return {
            orderBy() { return this; },
            limit() { return this; },
            async get() {
              const docs = recipient.status === status ? [{
                id: "recipient_1",
                ref: recipientRef,
                get: key => recipient[key],
                data: () => recipient
              }] : [];
              return { docs, size: docs.length };
            }
          };
        }
      };
    }
  };
  const organizationRef = {
    collection(name) {
      if (name === "campaignSuppressions") {
        return { doc() { return suppressionRef; } };
      }
      if (name === "chats") {
        return { doc(phone) {
          return {
            collection(child) {
              assert.equal(child, "messages");
              return { doc(messageId) { return { path: phone + "/messages/" + messageId }; } };
            },
            path: "chats/" + phone
          };
        } };
      }
      throw new Error("Unexpected organization collection " + name);
    }
  };
  campaignRef.parent.parent = organizationRef;
  const recipientRef = {
    id: "recipient_1",
    async update(patch) { Object.assign(recipient, patch); writes.push({ type: "recipientUpdate", patch }); }
  };
  const db = {
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          if (ref === suppressionRef) return { exists: Boolean(suppressionStatus), get: () => suppressionStatus };
          const value = ref === campaignRef ? campaign : recipient;
          return { exists: true, data: () => value, get: key => value[key] };
        },
        update(ref, patch) { Object.assign(ref === campaignRef ? campaign : recipient, patch); writes.push({ type: "update", ref, patch }); },
        set(ref, value, options) { writes.push({ type: "set", ref, value, options }); }
      });
    }
  };
  return { db, campaignRef, campaign, recipient, writes };
}

test("campaign worker suppresses opted-out recipients immediately before sending", async () => {
  const harness = createCampaignHarness("opted_out");
  let sendCalls = 0;
  const result = await processCampaign(harness.db, harness.campaignRef, {
    now: () => new Date("2026-11-23T12:00:00.000Z"),
    getCredentials: async () => ({ accessToken: "server-secret", phoneNumberId: "123456789" }),
    fetch: async () => ({ ok: true, async json() { return { data: [{
      name: "order_update", language: "en", status: "APPROVED", category: "UTILITY",
      components: [{ type: "BODY", text: "Order {{1}}" }]
    }] }; } }),
    sendRecipient: async () => { sendCalls += 1; return { messageId: "wamid.1" }; }
  });
  assert.equal(sendCalls, 0);
  assert.equal(result.skipped, 1);
  assert.equal(harness.recipient.status, "skipped");
  assert.equal(harness.recipient.reason, "whatsapp_opt_out_suppression");
  assert.equal(harness.campaign.skippedCount, 1);
  assert.equal(harness.campaign.status, "failed");
});

test("campaign worker sends an eligible recipient and records message and campaign counters", async () => {
  const harness = createCampaignHarness(null);
  let sendCalls = 0;
  const result = await processCampaign(harness.db, harness.campaignRef, {
    now: () => new Date("2026-11-23T12:00:00.000Z"),
    getCredentials: async () => ({ accessToken: "server-secret", phoneNumberId: "123456789" }),
    fetch: async () => ({ ok: true, async json() { return { data: [{
      name: "order_update", language: "en", status: "APPROVED", category: "UTILITY",
      components: [{ type: "BODY", text: "Order {{1}}" }]
    }] }; } }),
    sendRecipient: async () => { sendCalls += 1; return { messageId: "wamid.confirmed" }; }
  });
  assert.equal(sendCalls, 1);
  assert.equal(result.sent, 1);
  assert.equal(harness.recipient.status, "sent");
  assert.equal(harness.recipient.messageId, "wamid.confirmed");
  assert.equal(harness.campaign.sentCount, 1);
  assert.equal(harness.campaign.status, "completed");
  assert.ok(harness.writes.some(write => write.type === "set" && write.value?.source === "campaign"));
});

test("transient Meta template verification failures keep campaigns queued without sending", async () => {
  const harness = createCampaignHarness(null);
  let sendCalls = 0;
  const result = await processCampaign(harness.db, harness.campaignRef, {
    now: () => new Date("2026-11-23T12:00:00.000Z"),
    getCredentials: async () => ({ accessToken: "server-secret", phoneNumberId: "123456789" }),
    fetch: async () => ({ ok: false, status: 503, async json() { return { error: { message: "Meta temporarily unavailable" } }; } }),
    sendRecipient: async () => { sendCalls += 1; return { messageId: "wamid.should-not-send" }; }
  });
  assert.equal(result.retryingVerification, true);
  assert.equal(sendCalls, 0);
  assert.equal(harness.campaign.status, "queued");
  assert.match(harness.campaign.verificationError, /temporarily unavailable/);
});

test("persists a known Meta message ID when Firestore delivery persistence is uncertain", async () => {
  const harness = createCampaignHarness(null);
  harness.recipient.status = "sending";
  harness.campaign.status = "sending";
  const saved = await finishRecipient(
    harness.db,
    harness.campaignRef,
    { id: "recipient_1" },
    harness.recipient,
    "uncertain",
    { messageId: "wamid.accepted", error: "Firestore write acknowledgement was lost." },
    { now: () => new Date("2026-11-23T12:00:00.000Z") }
  );
  assert.equal(saved, true);
  assert.equal(harness.recipient.status, "uncertain");
  assert.equal(harness.recipient.deliveryStatus, "sent");
  assert.equal(harness.recipient.messageId, "wamid.accepted");
  assert.equal(harness.campaign.uncertainCount, 1);
  const messageWrite = harness.writes.find(write => write.type === "set" && write.value?.source === "campaign");
  assert.ok(messageWrite);
  assert.equal(messageWrite.value.messageId, "wamid.accepted");
  assert.equal(messageWrite.value.persistenceUncertain, true);
});

test("campaign worker skips recipients whose consent timestamp is in the future", async () => {
  const harness = createCampaignHarness(null);
  harness.recipient.consentAt = "2026-11-24T10:00:00.000Z";
  let sendCalls = 0;
  const result = await processCampaign(harness.db, harness.campaignRef, {
    now: () => new Date("2026-11-23T12:00:00.000Z"),
    getCredentials: async () => ({ accessToken: "server-secret", phoneNumberId: "123456789" }),
    fetch: async () => ({ ok: true, async json() { return { data: [{
      name: "order_update", language: "en", status: "APPROVED", category: "UTILITY",
      components: [{ type: "BODY", text: "Order {{1}}" }]
    }] }; } }),
    sendRecipient: async () => { sendCalls += 1; return { messageId: "wamid.future-consent" }; }
  });
  assert.equal(sendCalls, 0);
  assert.equal(result.skipped, 1);
  assert.equal(harness.recipient.status, "skipped");
  assert.equal(harness.recipient.reason, "missing_or_invalid_opt_in_evidence");
});
