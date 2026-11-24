"use strict";

const ID_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD_TYPES = new Set(["text", "number", "date", "boolean", "select"]);
const DEFAULT_PIPELINE_STAGES = [
  { id: "new", name: "New", position: 10, isWon: false, isLost: false, isDefault: true },
  { id: "qualified", name: "Qualified", position: 20, isWon: false, isLost: false, isDefault: false },
  { id: "proposal", name: "Proposal", position: 30, isWon: false, isLost: false, isDefault: false },
  { id: "won", name: "Won", position: 40, isWon: true, isLost: false, isDefault: false },
  { id: "lost", name: "Lost", position: 50, isWon: false, isLost: true, isDefault: false }
];

function crmError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeCrmFieldDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw crmError("Custom field details are required.");
  const allowed = ["key", "label", "type", "options", "required", "active"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw crmError("Custom field contains unsupported properties.");
  const key = typeof input.key === "string" ? input.key.trim().toLowerCase().replace(/[ -]+/g, "_") : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const type = String(input.type || "text");
  if (!ID_PATTERN.test(key)) throw crmError("Field key must start with a letter and contain 2–40 lowercase letters, numbers or underscores.");
  if (!label || label.length > 60) throw crmError("Field label is required (maximum 60 characters).");
  if (!FIELD_TYPES.has(type)) throw crmError("Field type must be text, number, date, boolean or select.");
  const options = input.options === undefined ? [] : input.options;
  if (!Array.isArray(options) || options.length > 30 || options.some(value => typeof value !== "string" || !value.trim() || value.trim().length > 60)) {
    throw crmError("Select options must contain up to 30 non-empty labels of 60 characters or fewer.");
  }
  const normalizedOptions = [...new Set(options.map(value => value.trim()))];
  if (type === "select" && normalizedOptions.length < 1) throw crmError("Select fields require at least one option.");
  if (type !== "select" && normalizedOptions.length) throw crmError("Only select fields can have options.");
  if (input.required !== undefined && typeof input.required !== "boolean") throw crmError("Required must be true or false.");
  if (input.active !== undefined && typeof input.active !== "boolean") throw crmError("Active must be true or false.");
  return { key, label, type, options: normalizedOptions, required: input.required === true, active: input.active !== false };
}

function normalizeCrmFieldValues(input, definitions = []) {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw crmError("Custom field values must be an object.");
  const knownDefinitions = new Map(definitions.map(field => [field.key, field]));
  const activeDefinitions = definitions.filter(field => field.active !== false);
  const values = {};
  for (const [key, value] of Object.entries(input)) {
    const definition = knownDefinitions.get(key);
    if (!definition) throw crmError(`Custom field "${key}" is not configured.`);
    if (value === null || value === "") {
      if (definition.required) throw crmError(`${definition.label} is required.`);
      continue;
    }
    if (definition.type === "text") {
      if (typeof value !== "string" || value.length > 500) throw crmError(`${definition.label} must be text up to 500 characters.`);
      values[key] = value.trim();
    } else if (definition.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw crmError(`${definition.label} must be a valid number.`);
      values[key] = value;
    } else if (definition.type === "date") {
      const parsedDate = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T00:00:00.000Z") : null;
      if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value) {
        throw crmError(`${definition.label} must be a valid YYYY-MM-DD date.`);
      }
      values[key] = value;
    } else if (definition.type === "boolean") {
      if (typeof value !== "boolean") throw crmError(`${definition.label} must be true or false.`);
      values[key] = value;
    } else if (definition.type === "select") {
      if (typeof value !== "string" || !definition.options.includes(value)) throw crmError(`Choose a valid option for ${definition.label}.`);
      values[key] = value;
    }
  }
  for (const definition of activeDefinitions) {
    if (definition.required && (values[definition.key] === undefined || values[definition.key] === null || values[definition.key] === "")) {
      throw crmError(`${definition.label} is required.`);
    }
  }
  return values;
}

function normalizePipelineStage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw crmError("Pipeline stage details are required.");
  const allowed = ["id", "name", "position", "isWon", "isLost", "isDefault", "active"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw crmError("Pipeline stage contains unsupported properties.");
  const id = typeof input.id === "string" ? input.id.trim().toLowerCase().replace(/[ -]+/g, "_") : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const position = input.position === undefined ? 100 : input.position;
  const isWon = input.isWon === true;
  const isLost = input.isLost === true;
  if (!ID_PATTERN.test(id)) throw crmError("Stage ID must start with a letter and contain 2–40 lowercase letters, numbers or underscores.");
  if (!name || name.length > 50) throw crmError("Stage name is required (maximum 50 characters).");
  if (!Number.isInteger(position) || position < 0 || position > 10000) throw crmError("Stage position must be an integer from 0 to 10,000.");
  if (isWon && isLost) throw crmError("A stage cannot be both won and lost.");
  if (input.isDefault !== undefined && typeof input.isDefault !== "boolean") throw crmError("Default must be true or false.");
  if (input.active !== undefined && typeof input.active !== "boolean") throw crmError("Active must be true or false.");
  return { id, name, position, isWon, isLost, isDefault: input.isDefault === true, active: input.active !== false };
}

function canAccessCrmLead(role, actorUid, lead) {
  return role !== "agent" || Boolean(actorUid && lead?.ownerUid === actorUid);
}

function normalizeCrmLead(input, fieldDefinitions = []) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw crmError("Lead details are required.");
  const allowed = ["title", "contactId", "stageId", "ownerUid", "source", "value", "currency", "nextFollowUpAt", "notes", "customFields"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw crmError("Lead contains unsupported properties.");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const contactId = input.contactId === undefined || input.contactId === null ? "" : String(input.contactId);
  const stageId = typeof input.stageId === "string" ? input.stageId.trim() : "new";
  const ownerUid = input.ownerUid === undefined || input.ownerUid === null ? "" : String(input.ownerUid);
  const source = typeof input.source === "string" ? input.source.trim().slice(0, 80) : "";
  const value = input.value === undefined || input.value === null || input.value === "" ? null : input.value;
  const currency = String(input.currency || "INR").toUpperCase();
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const nextFollowUpAt = input.nextFollowUpAt === undefined || input.nextFollowUpAt === null || input.nextFollowUpAt === "" ? null : input.nextFollowUpAt;
  if (!title || title.length > 120) throw crmError("Lead title is required (maximum 120 characters).");
  if (contactId && !DOC_ID_PATTERN.test(contactId)) throw crmError("A valid contact ID is required.");
  if (!DOC_ID_PATTERN.test(stageId)) throw crmError("A valid pipeline stage is required.");
  if (ownerUid && !/^[A-Za-z0-9:_-]{1,128}$/.test(ownerUid)) throw crmError("A valid lead owner is required.");
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000)) {
    throw crmError("Lead value must be a non-negative number.");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw crmError("Currency must be a three-letter ISO code.");
  if (notes.length > 2000) throw crmError("Lead notes must be 2,000 characters or fewer.");
  let followUp = null;
  if (nextFollowUpAt !== null) {
    followUp = new Date(nextFollowUpAt);
    if (Number.isNaN(followUp.getTime())) throw crmError("Enter a valid follow-up date and time.");
  }
  return {
    title, contactId, stageId, ownerUid, source, value, currency, notes,
    nextFollowUpAt: followUp,
    customFields: normalizeCrmFieldValues(input.customFields, fieldDefinitions)
  };
}

module.exports = {
  ID_PATTERN,
  DEFAULT_PIPELINE_STAGES,
  normalizeCrmFieldDefinition,
  normalizeCrmFieldValues,
  normalizePipelineStage,
  canAccessCrmLead,
  normalizeCrmLead
};
