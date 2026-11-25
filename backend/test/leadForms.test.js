"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLeadForm, normalizeSubmission, safePublicForm, FORM_ID_PATTERN } = require("../src/leadForms");

const validForm = () => normalizeLeadForm({
  name: "Website enquiry",
  description: "Tell us what you need",
  fields: [
    { key: "full_name", label: "Full name", type: "text", required: true },
    { key: "email", label: "Email", type: "email", required: true },
    { key: "phone", label: "Phone", type: "phone" },
    { key: "interest", label: "Interested in", type: "select", options: ["Inbox", "Campaigns"] },
    { key: "message", label: "Message", type: "textarea" }
  ]
});

test("normalizes a lead form and applies safe defaults", () => {
  const form = validForm();
  assert.equal(form.enabled, true);
  assert.equal(form.consentRequired, true);
  assert.equal(form.createLead, true);
  assert.equal(form.fields.length, 5);
  assert.equal(FORM_ID_PATTERN.test("0123456789abcdef01234567"), true);
});

test("rejects invalid field keys, duplicate fields, unsupported types and select options", () => {
  assert.throws(() => normalizeLeadForm({ name: "Bad", fields: [{ key: "x", label: "Name", type: "text" }] }), /Field keys/);
  assert.throws(() => normalizeLeadForm({ name: "Bad", fields: [{ key: "first_name", label: "Name", type: "text" }, { key: "first_name", label: "Name again", type: "text" }] }), /unique/);
  assert.throws(() => normalizeLeadForm({ name: "Bad", fields: [{ key: "first_name", label: "Name", type: "url" }] }), /supported type/);
  assert.throws(() => normalizeLeadForm({ name: "Bad", fields: [{ key: "choice", label: "Choice", type: "select" }] }), /require at least one option/);
});

test("validates required values, email, E.164 phone and select options", () => {
  const form = validForm();
  assert.throws(() => normalizeSubmission(form, { email: "person@example.com" }), /Full name is required/);
  assert.throws(() => normalizeSubmission(form, { full_name: "A", email: "not-an-email" }), /valid email/);
  assert.throws(() => normalizeSubmission(form, { full_name: "A", email: "a@example.com", phone: "12345" }), /international phone/);
  assert.throws(() => normalizeSubmission(form, { full_name: "A", email: "a@example.com", interest: "Unknown" }), /valid option/);
  assert.deepEqual(normalizeSubmission(form, {
    full_name: "  A User ", email: "a@example.com", phone: "+919876543210", interest: "Inbox", message: "Hello"
  }), { full_name: "A User", email: "a@example.com", phone: "+919876543210", interest: "Inbox", message: "Hello" });
});

test("rejects unexpected submitted fields and overlong input", () => {
  const form = validForm();
  assert.throws(() => normalizeSubmission(form, { full_name: "A", email: "a@example.com", admin: true }), /unknown field/);
  assert.throws(() => normalizeSubmission(form, { full_name: "A".repeat(501), email: "a@example.com" }), /too long/);
});

test("public form projection excludes private management metadata", () => {
  const form = { ...validForm(), createdBy: "owner-secret", updatedBy: "admin-secret", internalNotes: "private" };
  const safe = safePublicForm("0123456789abcdef01234567", form);
  assert.equal(safe.id, "0123456789abcdef01234567");
  assert.equal("createdBy" in safe, false);
  assert.equal("internalNotes" in safe, false);
  assert.equal(safe.fields[0].key, "full_name");
});
