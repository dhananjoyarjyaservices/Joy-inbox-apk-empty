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

function makeFirestoreMock(formId, formData) {
  const documents = new Map();
  const key = path => path.join("/");
  const collection = path => ({
    doc(id = `auto_${Math.random().toString(16).slice(2)}`) {
      const docPath = [...path, id];
      return {
        id,
        path: key(docPath),
        async get() {
          const data = documents.get(key(docPath));
          return { exists: Boolean(data), data: () => data };
        },
        async set(data, options = {}) {
          const previous = documents.get(key(docPath)) || {};
          documents.set(key(docPath), options.merge ? { ...previous, ...data } : data);
        },
        async create(data) {
          if (documents.has(key(docPath))) throw new Error("already exists");
          documents.set(key(docPath), data);
        },
        collection(name) { return collection([...docPath, name]); }
      };
    }
  });
  const db = {
    collection(name) { return collection([name]); },
    async runTransaction(callback) {
      return callback({
        get: ref => ref.get(),
        set: (ref, data, options) => { void ref.set(data, options); },
        create: (ref, data) => { void ref.create(data); }
      });
    }
  };
  const orgRef = collection(["organizations"]).doc("org_test");
  const formRef = orgRef.collection("leadForms").doc(formId);
  const publicRef = collection(["publicLeadForms"]).doc(formId);
  documents.set(publicRef.path, { organizationId: "org_test", enabled: true });
  documents.set(formRef.path, formData);
  return { db, documents };
}

test("public submissions create one CRM lead and retries return the original response", async () => {
  const { submitPublicLeadForm } = require("../src/leadForms");
  const form = validForm();
  const formId = "0123456789abcdef01234567";
  const { db, documents } = makeFirestoreMock(formId, form);
  const options = {
    consent: true, ip: "203.0.113.10", idempotencyKey: "visitor-session-0001",
    now: new Date("2026-11-25T08:00:00.000Z")
  };
  const first = await submitPublicLeadForm(db, formId, { full_name: "A User", email: "a@example.com" }, options);
  const retry = await submitPublicLeadForm(db, formId, { full_name: "A User", email: "a@example.com" }, options);
  assert.deepEqual(retry, first);
  assert.equal([...documents.keys()].filter(path => path.includes("/leadFormSubmissions/")).length, 1);
  assert.equal([...documents.keys()].filter(path => path.includes("/crmLeads/")).length, 1);
  assert.equal([...documents.keys()].filter(path => path.includes("/contacts/")).length, 1);
  const lead = [...documents.entries()].find(([path]) => path.includes("/crmLeads/"))[1];
  assert.equal(lead.contactId, "919876543210");
  assert.equal([...documents.entries()].find(([path]) => path.startsWith("publicFormRateLimits/"))[1].count, 1);
});

test("public form submissions require consent and enforce five per IP per minute", async () => {
  const { submitPublicLeadForm } = require("../src/leadForms");
  const form = validForm();
  const formId = "abcdef0123456789abcdef01";
  const { db } = makeFirestoreMock(formId, form);
  const now = new Date("2026-11-25T08:00:00.000Z");
  await assert.rejects(() => submitPublicLeadForm(db, formId, { full_name: "A", email: "a@example.com" }, {
    ip: "203.0.113.11", idempotencyKey: "visitor-session-0001", now
  }), /accept the consent/);
  for (let index = 1; index <= 5; index += 1) {
    await submitPublicLeadForm(db, formId, { full_name: "A", email: "a@example.com" }, {
      consent: true, ip: "203.0.113.11", idempotencyKey: `visitor-session-000${index}`, now
    });
  }
  await assert.rejects(() => submitPublicLeadForm(db, formId, { full_name: "A", email: "a@example.com" }, {
    consent: true, ip: "203.0.113.11", idempotencyKey: "visitor-session-0006", now
  }), { statusCode: 429 });
});
