const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PIPELINE_STAGES,
  normalizeCrmFieldDefinition,
  normalizeCrmFieldValues,
  normalizePipelineStage,
  canAccessCrmLead,
  normalizeCrmLead
} = require("../src/crm");

test("normalizes custom field definitions and select options", () => {
  assert.deepEqual(normalizeCrmFieldDefinition({
    key: "Lead Source", label: "Lead source", type: "select", options: ["Website", " Referral ", "Website"]
  }), {
    key: "lead_source", label: "Lead source", type: "select", options: ["Website", "Referral"], required: false, active: true
  });
});

test("rejects unsafe or unsupported custom field definitions", () => {
  assert.throws(() => normalizeCrmFieldDefinition({ key: "__proto__", label: "Bad", type: "text" }), { statusCode: 400 });
  assert.throws(() => normalizeCrmFieldDefinition({ key: "source", label: "Source", type: "select" }), { statusCode: 400 });
  assert.throws(() => normalizeCrmFieldDefinition({ key: "source", label: "Source", type: "text", options: ["x"] }), { statusCode: 400 });
  assert.throws(() => normalizeCrmFieldDefinition({ key: "source", label: "Source", type: "unknown" }), { statusCode: 400 });
});

test("validates custom field values against active definitions and data types", () => {
  const definitions = [
    { key: "budget", label: "Budget", type: "number", active: true },
    { key: "vip", label: "VIP", type: "boolean", active: true },
    { key: "source", label: "Source", type: "select", options: ["Web", "Referral"], active: true },
    { key: "inactive", label: "Inactive", type: "text", active: false }
  ];
  assert.deepEqual(normalizeCrmFieldValues({ budget: 1250, vip: true, source: "Web" }, definitions), {
    budget: 1250, vip: true, source: "Web"
  });
  assert.throws(() => normalizeCrmFieldValues({ budget: "1250" }, definitions), { statusCode: 400 });
  assert.throws(() => normalizeCrmFieldValues({ source: "Other" }, definitions), { statusCode: 400 });
  assert.throws(() => normalizeCrmFieldValues({ inactive: "value" }, definitions), { statusCode: 400 });
  assert.throws(() => normalizeCrmFieldValues({ arbitrary: "value" }, definitions), { statusCode: 400 });
  assert.throws(() => normalizeCrmFieldValues({ due_date: "2026-02-31" }, [{ key: "due_date", label: "Due date", type: "date", active: true }]), { statusCode: 400 });
});

test("enforces required custom fields even when omitted", () => {
  const definitions = [{ key: "company", label: "Company", type: "text", required: true, active: true }];
  assert.throws(() => normalizeCrmFieldValues({}, definitions), { statusCode: 400 });
  assert.deepEqual(normalizeCrmFieldValues({ company: "Acme" }, definitions), { company: "Acme" });
});

test("validates pipeline stages and mutually exclusive outcome flags", () => {
  assert.deepEqual(normalizePipelineStage({ id: "proposal", name: "Proposal", position: 30 }), {
    id: "proposal", name: "Proposal", position: 30, isWon: false, isLost: false, isDefault: false, active: true
  });
  assert.throws(() => normalizePipelineStage({ id: "won", name: "Won", isWon: true, isLost: true }), { statusCode: 400 });
  assert.throws(() => normalizePipelineStage({ id: "1invalid", name: "Invalid" }), { statusCode: 400 });
});

test("normalizes lead data, custom fields and follow-up dates", () => {
  const fields = [{ key: "budget", label: "Budget", type: "number", active: true }];
  const lead = normalizeCrmLead({
    title: " Website redesign ", contactId: "919876543210", stageId: "qualified",
    ownerUid: "agent_1", source: "Website", value: 25000, notes: "Call tomorrow",
    nextFollowUpAt: "2026-12-01T10:00:00.000Z", customFields: { budget: 30000 }
  }, fields);
  assert.equal(lead.title, "Website redesign");
  assert.equal(lead.value, 25000);
  assert.equal(lead.nextFollowUpAt.toISOString(), "2026-12-01T10:00:00.000Z");
  assert.deepEqual(lead.customFields, { budget: 30000 });
});

test("rejects invalid lead references, values and dates", () => {
  assert.throws(() => normalizeCrmLead({ title: "Deal", stageId: "../other" }), { statusCode: 400 });
  assert.throws(() => normalizeCrmLead({ title: "Deal", stageId: "new", value: -1 }), { statusCode: 400 });
  assert.throws(() => normalizeCrmLead({ title: "Deal", stageId: "new", nextFollowUpAt: "not-a-date" }), { statusCode: 400 });
});

test("ships a default sales pipeline with exactly one initial stage", () => {
  assert.equal(DEFAULT_PIPELINE_STAGES.length, 5);
  assert.equal(DEFAULT_PIPELINE_STAGES.filter(stage => stage.isDefault).length, 1);
  assert.equal(DEFAULT_PIPELINE_STAGES.filter(stage => stage.isWon).length, 1);
  assert.equal(DEFAULT_PIPELINE_STAGES.filter(stage => stage.isLost).length, 1);
});

test("agent CRM visibility is limited to leads owned by that agent", () => {
  assert.equal(canAccessCrmLead("agent", "agent_a", { ownerUid: "agent_a" }), true);
  assert.equal(canAccessCrmLead("agent", "agent_a", { ownerUid: "agent_b" }), false);
  assert.equal(canAccessCrmLead("agent", "agent_a", { ownerUid: "" }), false);
  assert.equal(canAccessCrmLead("admin", "admin_a", { ownerUid: "agent_b" }), true);
  assert.equal(canAccessCrmLead("owner", "owner_a", { ownerUid: "" }), true);
});
