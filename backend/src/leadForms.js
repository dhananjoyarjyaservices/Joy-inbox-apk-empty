"use strict";

const crypto = require("crypto");

const FORM_ID_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;
const FIELD_TYPES = new Set(["text", "email", "phone", "textarea", "select"]);
const MAX_FIELDS = 10;
const MAX_SUBMISSIONS_PER_MINUTE = 5;

function formError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeLeadForm(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw formError("Form details are required.");
  const allowed = ["name", "description", "fields", "submitButton", "successMessage", "consentRequired", "consentText", "createLead", "enabled"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw formError("Form contains unsupported properties.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const submitButton = typeof input.submitButton === "string" ? input.submitButton.trim() : "Submit";
  const successMessage = typeof input.successMessage === "string" ? input.successMessage.trim() : "Thank you. Your response has been received.";
  const consentText = typeof input.consentText === "string" ? input.consentText.trim() : "I agree to be contacted about my enquiry.";
  if (!name || name.length > 80) throw formError("Form name is required (maximum 80 characters).");
  if (description.length > 300 || !submitButton || submitButton.length > 30 || !successMessage || successMessage.length > 300) throw formError("Form description, button or success message is invalid.");
  if (input.consentRequired !== undefined && typeof input.consentRequired !== "boolean") throw formError("Consent required must be true or false.");
  if (input.createLead !== undefined && typeof input.createLead !== "boolean") throw formError("CRM lead creation must be true or false.");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw formError("Enabled must be true or false.");
  if (consentText.length > 240) throw formError("Consent text must be 240 characters or fewer.");
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > MAX_FIELDS) throw formError("Add between 1 and 10 form fields.");
  const seen = new Set();
  const fields = input.fields.map((field, index) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) throw formError(`Form field ${index + 1} is invalid.`);
    if (Object.keys(field).some(key => !["key", "label", "type", "required", "options"].includes(key))) throw formError("Form field contains unsupported properties.");
    const key = typeof field.key === "string" ? field.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_") : "";
    const label = typeof field.label === "string" ? field.label.trim() : "";
    const type = String(field.type || "text");
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key) || seen.has(key)) throw formError("Field keys must be unique and use 2–40 lowercase letters, numbers or underscores.");
    if (!label || label.length > 80 || !FIELD_TYPES.has(type)) throw formError("Each field needs a label (max 80 characters) and a supported type.");
    if (field.required !== undefined && typeof field.required !== "boolean") throw formError("Field required must be true or false.");
    const options = field.options === undefined ? [] : field.options;
    if (!Array.isArray(options) || options.length > 20 || options.some(value => typeof value !== "string" || !value.trim() || value.trim().length > 80)) throw formError("Select options are invalid.");
    const normalizedOptions = [...new Set(options.map(value => value.trim()))];
    if (type === "select" && !normalizedOptions.length) throw formError("Select fields require at least one option.");
    if (type !== "select" && normalizedOptions.length) throw formError("Only select fields can have options.");
    seen.add(key);
    return { key, label, type, required: field.required === true, options: normalizedOptions };
  });
  return { name, description, fields, submitButton, successMessage, consentRequired: input.consentRequired !== false, consentText, createLead: input.createLead !== false, enabled: input.enabled !== false };
}

function normalizeSubmission(form, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw formError("Submission values are required.");
  const allowed = new Set(form.fields.map(field => field.key));
  if (Object.keys(input).some(key => !allowed.has(key))) throw formError("Submission contains an unknown field.");
  const values = {};
  for (const field of form.fields) {
    const raw = input[field.key];
    const value = raw === undefined || raw === null ? "" : String(raw).trim();
    if (field.required && !value) throw formError(`${field.label} is required.`);
    if (value.length > (field.type === "textarea" ? 2000 : 500)) throw formError(`${field.label} is too long.`);
    if (field.type === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw formError(`${field.label} must be a valid email address.`);
    if (field.type === "phone" && value && !/^\+[1-9][0-9]{7,14}$/.test(value)) throw formError(`${field.label} must be an international phone number starting with +.`);
    if (field.type === "select" && value && !field.options.includes(value)) throw formError(`Choose a valid option for ${field.label}.`);
    if (value) values[field.key] = value;
  }
  return values;
}

function safePublicForm(formId, form) {
  return {
    id: formId, name: form.name, description: form.description, fields: form.fields,
    submitButton: form.submitButton, successMessage: form.successMessage,
    consentRequired: form.consentRequired, consentText: form.consentText
  };
}

async function listLeadForms(organization) {
  const snapshot = await organization.ref.collection("leadForms").orderBy("updatedAt", "desc").limit(100).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function saveLeadForm(db, organization, actorUid, input, formId = "") {
  const form = normalizeLeadForm(input);
  if (formId && !FORM_ID_PATTERN.test(formId)) throw formError("A valid form ID is required.");
  const collection = organization.ref.collection("leadForms");
  const ref = formId ? collection.doc(formId) : collection.doc(crypto.randomBytes(12).toString("hex"));
  const existing = formId ? await ref.get() : null;
  if (formId && !existing.exists) throw formError("Lead form was not found.", 404);
  const now = new Date();
  const item = { ...form, createdAt: existing?.data()?.createdAt || now, updatedAt: now, createdBy: existing?.data()?.createdBy || actorUid, updatedBy: actorUid };
  await ref.set(item);
  await db.collection("publicLeadForms").doc(ref.id).set({ organizationId: organization.id, enabled: item.enabled, updatedAt: now });
  return { id: ref.id, ...item };
}

async function deleteLeadForm(db, organization, formId) {
  if (!FORM_ID_PATTERN.test(formId || "")) throw formError("A valid form ID is required.");
  const ref = organization.ref.collection("leadForms").doc(formId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw formError("Lead form was not found.", 404);
  const now = new Date();
  await ref.set({ enabled: false, deletedAt: now, updatedAt: now }, { merge: true });
  await db.collection("publicLeadForms").doc(formId).set({ organizationId: organization.id, enabled: false, updatedAt: now }, { merge: true });
  return { id: formId, enabled: false };
}

async function listLeadFormSubmissions(organization, formId, rawLimit = 50) {
  if (!FORM_ID_PATTERN.test(formId || "")) throw formError("A valid form ID is required.");
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw formError("Submission limit must be between 1 and 100.");
  const form = await organization.ref.collection("leadForms").doc(formId).get();
  if (!form.exists) throw formError("Lead form was not found.", 404);
  const snapshot = await organization.ref.collection("leadFormSubmissions").where("formId", "==", formId).orderBy("submittedAt", "desc").limit(limit).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getPublicLeadForm(db, formId) {
  if (!FORM_ID_PATTERN.test(formId || "")) throw formError("A valid form ID is required.");
  const index = await db.collection("publicLeadForms").doc(formId).get();
  if (!index.exists || index.data()?.enabled === false) throw formError("This form is unavailable.", 404);
  const organizationId = String(index.data()?.organizationId || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) throw formError("This form is unavailable.", 404);
  const organizationRef = db.collection("organizations").doc(organizationId);
  const snapshot = await organizationRef.collection("leadForms").doc(formId).get();
  if (!snapshot.exists || snapshot.data()?.enabled === false || snapshot.data()?.deletedAt) throw formError("This form is unavailable.", 404);
  return { organizationId, organizationRef, form: safePublicForm(formId, snapshot.data()) };
}

async function submitPublicLeadForm(db, formId, input, options = {}) {
  const { organizationId, organizationRef, form } = await getPublicLeadForm(db, formId);
  if (typeof options.honeypot === "string" && options.honeypot.trim()) return { accepted: true, successMessage: form.successMessage, spam: true };
  const values = normalizeSubmission(form, input);
  if (form.consentRequired && options.consent !== true) throw formError("Please accept the consent statement before submitting.", 400);
  const idempotencyKey = String(options.idempotencyKey || "");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw formError("A valid Idempotency-Key header is required.", 400);
  const now = options.now instanceof Date ? options.now : new Date();
  const ip = String(options.ip || "unknown").slice(0, 128);
  const rateKey = crypto.createHash("sha256").update(`${formId}:${ip}`).digest("hex");
  const idempotencyHash = crypto.createHash("sha256").update(`${formId}:${idempotencyKey}`).digest("hex");
  const bucket = Math.floor(now.getTime() / 60000);
  const rateRef = db.collection("publicFormRateLimits").doc(`${rateKey}_${bucket}`);
  const idempotencyRef = db.collection("publicFormIdempotency").doc(idempotencyHash);
  const submissionRef = organizationRef.collection("leadFormSubmissions").doc();
  const shouldCreateLead = form.createLead;
  const nameField = form.fields.find(field => /name/i.test(field.key));
  const emailField = form.fields.find(field => field.type === "email");
  const title = String(values[nameField?.key] || values[emailField?.key] || form.name).slice(0, 120);
  const stageRef = organizationRef.collection("crmStages").doc("new");
  const leadRef = shouldCreateLead ? organizationRef.collection("crmLeads").doc() : null;
  const response = {
    accepted: true, successMessage: form.successMessage, submissionId: submissionRef.id,
    leadId: leadRef?.id || null
  };
  return db.runTransaction(async transaction => {
    const [rateSnapshot, idempotencySnapshot, stageSnapshot] = await Promise.all([
      transaction.get(rateRef), transaction.get(idempotencyRef),
      shouldCreateLead ? transaction.get(stageRef) : Promise.resolve(null)
    ]);
    if (idempotencySnapshot.exists) {
      const prior = idempotencySnapshot.data()?.response;
      if (prior) return prior;
      throw formError("This submission is already being processed. Please wait before retrying.", 409);
    }
    const count = Number(rateSnapshot.data()?.count || 0);
    if (count >= MAX_SUBMISSIONS_PER_MINUTE) throw formError("Too many submissions. Please try again in a minute.", 429);
    const consentAt = form.consentRequired ? now : null;
    transaction.set(rateRef, { formId, count: count + 1, updatedAt: now, expiresAt: new Date(now.getTime() + 2 * 60000) }, { merge: true });
    transaction.create(submissionRef, {
      formId, values, consentAccepted: form.consentRequired ? true : options.consent === true,
      consentText: form.consentRequired ? form.consentText : "",
      consentAt, submittedAt: now, ipHash: rateKey, status: shouldCreateLead ? "converted" : "new",
      ...(leadRef ? { leadId: leadRef.id } : {})
    });
    if (leadRef) {
      const stageName = stageSnapshot?.exists ? String(stageSnapshot.data()?.name || "New") : "New";
      transaction.create(leadRef, {
        title: `${form.name}: ${title}`.slice(0, 120), contactId: "", stageId: "new", stageName,
        ownerUid: "", source: `lead_form:${formId}`, value: null, currency: "INR",
        notes: Object.entries(values).map(([key, value]) => `${key}: ${value}`).join("\\n").slice(0, 2000),
        customFields: {}, organizationId, createdAt: now, updatedAt: now,
        createdBy: "lead_form", updatedBy: "lead_form", formSubmissionId: submissionRef.id
      });
    }
    transaction.create(idempotencyRef, {
      formId, response, createdAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
    });
    return response;
  });
}

module.exports = {
  FORM_ID_PATTERN, normalizeLeadForm, normalizeSubmission, safePublicForm,
  listLeadForms, saveLeadForm, deleteLeadForm, listLeadFormSubmissions, getPublicLeadForm, submitPublicLeadForm,
  MAX_SUBMISSIONS_PER_MINUTE
};
