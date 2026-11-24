"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCrmActivityEvent, summarizeLead } = require("../src/crmActivity");

test("creates a safe CRM lead creation activity snapshot", () => {
  const event = buildCrmActivityEvent({
    organizationId: "org_a", leadId: "lead_a", actorUid: "user_a", action: "created",
    after: { title: "Website redesign", stageId: "new", value: 1200, notes: "private notes", customFields: { secret: "omit" } },
    at: new Date("2026-11-24T12:00:00.000Z")
  });
  assert.equal(event.action, "created");
  assert.equal(event.after.title, "Website redesign");
  assert.equal(event.after.value, 1200);
  assert.equal("notes" in event.after, false);
  assert.equal("customFields" in event.after, false);
});

test("records only changed tracked fields for lead updates", () => {
  const event = buildCrmActivityEvent({
    organizationId: "org_a", leadId: "lead_a", actorUid: "user_a", action: "updated",
    before: { title: "Old", stageId: "new", value: 100 },
    after: { title: "New", stageId: "qualified", value: 100 }
  });
  assert.deepEqual(event.changedFields.sort(), ["stageId", "title"]);
});

test("normalizes Firestore timestamps and validates event identity", () => {
  const stamp = { toDate: () => new Date("2026-11-24T12:00:00.000Z") };
  assert.equal(summarizeLead({ nextFollowUpAt: stamp }).nextFollowUpAt, "2026-11-24T12:00:00.000Z");
  assert.throws(() => buildCrmActivityEvent({ organizationId: "org", leadId: "lead", action: "created" }), /invalid/i);
});
