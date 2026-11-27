const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldApplyMessageStatus, getCampaignDeliveryCounterPatch } = require("../src/webhook");

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

test("a failed WhatsApp delivery status is terminal and cannot return to sent", () => {
  assert.equal(shouldApplyMessageStatus("failed", "sent"), false);
  assert.equal(shouldApplyMessageStatus("failed", "delivered"), false);
  assert.equal(shouldApplyMessageStatus("failed", "read"), false);
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


function fakeStatusOrganization(initialStatus = "sent") {
  const writes = [];
  const message = initialStatus === null ? null : { status: initialStatus };
  const ref = {
    firestore: {
      async runTransaction(callback) {
        return callback({
          async get() {
            return { exists: Boolean(message), data: () => message ? ({ ...message }) : undefined };
          },
          update(_ref, value) {
            writes.push(value);
            Object.assign(message, value);
          }
        });
      }
    }
  };
  const organization = {
    id: "org_status_test",
    ref: {
      collection(name) {
        assert.equal(name, "chats");
        return {
          doc(phone) {
            assert.equal(phone, "15551234567");
            return {
              collection(collectionName) {
                assert.equal(collectionName, "messages");
                return { doc(id) { assert.equal(id, "wamid.status.1"); return ref; } };
              }
            };
          }
        };
      }
    }
  };
  return { organization, message, writes };
}

test("replayed delivery status events are idempotent and do not write twice", async () => {
  const { updateTenantMessageStatus } = require("../src/webhook");
  const { organization, message, writes } = fakeStatusOrganization("sent");
  const event = { id: "wamid.status.1", recipient_id: "15551234567", status: "delivered" };
  await updateTenantMessageStatus(organization, event);
  await updateTenantMessageStatus(organization, event);
  assert.equal(message.status, "delivered");
  assert.equal(writes.length, 1);
});

test("late status events cannot downgrade a read message", async () => {
  const { updateTenantMessageStatus } = require("../src/webhook");
  const { organization, message, writes } = fakeStatusOrganization("read");
  await updateTenantMessageStatus(organization, {
    id: "wamid.status.1", recipient_id: "15551234567", status: "delivered"
  });
  await updateTenantMessageStatus(organization, {
    id: "wamid.status.1", recipient_id: "15551234567", status: "sent"
  });
  assert.equal(message.status, "read");
  assert.equal(writes.length, 0);
});

test("invalid status event identifiers, recipients and status values are ignored", async () => {
  const { updateTenantMessageStatus } = require("../src/webhook");
  const { organization, writes } = fakeStatusOrganization("sent");
  await updateTenantMessageStatus(organization, { id: "../bad", recipient_id: "15551234567", status: "read" });
  await updateTenantMessageStatus(organization, { id: "wamid.status.1", recipient_id: "not-a-phone", status: "read" });
  await updateTenantMessageStatus(organization, { id: "wamid.status.1", recipient_id: "15551234567", status: "queued" });
  assert.equal(writes.length, 0);
});


test("missing outgoing message causes a retryable webhook error instead of dropping its status", async () => {
  const { updateTenantMessageStatus } = require("../src/webhook");
  const { organization } = fakeStatusOrganization(null);
  await assert.rejects(
    updateTenantMessageStatus(organization, {
      id: "wamid.status.1",
      recipient_id: "15551234567",
      status: "delivered"
    }),
    (error) => error.statusCode === 503 && error.retryable === true
  );
});

test("campaign delivery counters advance monotonically with Meta delivery statuses", () => {
  assert.deepEqual(
    getCampaignDeliveryCounterPatch({ deliveredCount: 2, readCount: 1 }, "sent", "delivered"),
    { deliveredCount: 3 }
  );
  assert.deepEqual(
    getCampaignDeliveryCounterPatch({ deliveredCount: 2, readCount: 1 }, "delivered", "read"),
    { readCount: 2 }
  );
  assert.deepEqual(
    getCampaignDeliveryCounterPatch({ deliveredCount: 2, readCount: 1 }, "sent", "read"),
    { deliveredCount: 3, readCount: 2 }
  );
  assert.deepEqual(
    getCampaignDeliveryCounterPatch({ deliveryFailedCount: 4 }, "sent", "failed"),
    { deliveryFailedCount: 5 }
  );
  assert.deepEqual(
    getCampaignDeliveryCounterPatch({ deliveredCount: 2 }, "delivered", "failed"),
    {}
  );
});

test("Meta delivery webhooks update campaign recipient and delivery counters idempotently", async () => {
  const crypto = require("node:crypto");
  const { updateTenantMessageStatus } = require("../src/webhook");
  const phone = "15551234567";
  const recipientId = crypto.createHash("sha256").update(phone).digest("hex");
  const message = { status: "sent", source: "campaign", campaignId: "campaign_1" };
  const recipient = { deliveryStatus: "sent" };
  const campaign = { deliveredCount: 0, readCount: 0, deliveryFailedCount: 0 };
  const messageRef = {};
  const recipientRef = {};
  const campaignRef = {
    collection(name) {
      assert.equal(name, "recipients");
      return { doc(id) { assert.equal(id, recipientId); return recipientRef; } };
    }
  };
  const refs = new Map([[messageRef, message], [campaignRef, campaign], [recipientRef, recipient]]);
  const writes = [];
  messageRef.firestore = {
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          const value = refs.get(ref);
          return { exists: Boolean(value), data: () => value ? ({ ...value }) : undefined, get: key => value?.[key] };
        },
        update(ref, patch) {
          Object.assign(refs.get(ref), patch);
          writes.push({ ref, patch });
        }
      });
    }
  };
  const organization = {
    id: "org_1",
    ref: {
      collection(name) {
        if (name === "chats") {
          return { doc(id) {
            assert.equal(id, phone);
            return { collection(child) {
              assert.equal(child, "messages");
              return { doc(messageId) {
                assert.equal(messageId, "wamid.campaign.1");
                return messageRef;
              } };
            } };
          } };
        }
        if (name === "campaigns") {
          return { doc(id) {
            assert.equal(id, "campaign_1");
            return campaignRef;
          } };
        }
        throw new Error("Unexpected collection " + name);
      }
    }
  };
  const event = { id: "wamid.campaign.1", recipient_id: phone, status: "delivered" };
  await updateTenantMessageStatus(organization, event);
  await updateTenantMessageStatus(organization, event);
  assert.equal(message.status, "delivered");
  assert.equal(recipient.deliveryStatus, "delivered");
  assert.equal(campaign.deliveredCount, 1);
  assert.equal(writes.length, 3);
});
