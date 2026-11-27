"use strict";

const { normalizeAuthenticationOtpCode, buildAuthenticationTemplateSendComponents } = require("./templateManagement");

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.definitive = true;
  return error;
}

function normalizeTemplateConsent(input, now = Date.now()) {
  const consentAt = typeof input?.consentAt === "string" ? new Date(input.consentAt) : null;
  const consentSource = typeof input?.consentSource === "string" ? input.consentSource.trim() : "";
  if (!input || input.optedIn !== true || !consentAt || Number.isNaN(consentAt.getTime()) ||
      consentAt.getTime() > now || consentSource.length < 2 || consentSource.length > 120) {
    throw httpError("Template sends require explicit opt-in evidence: optedIn=true, a past ISO consentAt timestamp and a consentSource (2–120 characters).");
  }
  return { optedIn: true, consentAt: consentAt.toISOString(), consentSource };
}

function countTemplatePlaceholders(value) {
  const indexes = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
  return indexes.length ? Math.max(...indexes) : 0;
}

function buildPublicTemplateComponents(approvedTemplate, input = {}) {
  if (!approvedTemplate || approvedTemplate.status !== "APPROVED") {
    throw httpError("This WhatsApp template is not approved.");
  }
  const variables = input.variables === undefined ? [] : input.variables;
  const headerVariables = input.headerVariables === undefined ? [] : input.headerVariables;
  const buttonVariables = input.buttonVariables === undefined ? [] : input.buttonVariables;
  const valid = values => Array.isArray(values) && values.length <= 100 &&
    values.every(value => typeof value === "string" && value.trim() && value.length <= 1024);
  if (!valid(variables) || !valid(headerVariables) || !valid(buttonVariables)) {
    throw httpError("Template variables must be arrays of non-empty strings up to 1,024 characters.");
  }
  const definitions = Array.isArray(approvedTemplate.components) ? approvedTemplate.components : [];
  const bodyCount = countTemplatePlaceholders(definitions.find(item => item.type === "BODY")?.text);
  const header = definitions.find(item => item.type === "HEADER");
  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(header?.format)) {
    throw httpError("Media-header templates must use the media template send flow.");
  }
  const headerCount = header?.format === "TEXT" ? countTemplatePlaceholders(header.text) : 0;
  const allButtons = definitions.flatMap(item =>
    item.type === "BUTTONS" && Array.isArray(item.buttons)
      ? item.buttons.map((button, index) => ({ ...button, index }))
      : []
  );
  const otpButtons = allButtons.filter(button => button.type === "OTP");
  const urlButtons = allButtons.filter(button => button.type === "URL" && String(button.url || "").includes("{{"));
  const isAuthenticationTemplate = String(approvedTemplate.category || "").toUpperCase() === "AUTHENTICATION" || otpButtons.length > 0;
  if (isAuthenticationTemplate) {
    const noButtons = otpButtons.length === 1 && String(otpButtons[0].otp_type || "").toUpperCase() === "NO_BUTTONS";
    if (otpButtons.length !== 1 || header || headerVariables.length || urlButtons.length ||
        bodyCount !== 1 || variables.length !== 1 || buttonVariables.length !== (noButtons ? 0 : 1) ||
        (!noButtons && variables[0] !== buttonVariables[0])) {
      throw httpError("Authentication templates require one matching OTP body and button code and cannot contain headers or URL buttons.");
    }
    return buildAuthenticationTemplateSendComponents(normalizeAuthenticationOtpCode(variables[0]), otpButtons[0].otp_type);
  }
  if (variables.length !== bodyCount || headerVariables.length !== headerCount || buttonVariables.length !== urlButtons.length) {
    throw httpError(`Template variables do not match the approved definition (body ${bodyCount}, header ${headerCount}, URL buttons ${urlButtons.length}).`);
  }
  const components = [];
  if (headerVariables.length) components.push({
    type: "header",
    parameters: headerVariables.map(value => ({ type: "text", text: value.trim() }))
  });
  if (variables.length) components.push({
    type: "body",
    parameters: variables.map(value => ({ type: "text", text: value.trim() }))
  });
  buttonVariables.forEach((value, index) => components.push({
    type: "button",
    sub_type: "url",
    index: String(urlButtons[index].index),
    parameters: [{ type: "text", text: value.trim() }]
  }));
  return components;
}

function buildPublicTemplateListUrl({ version, wabaId, connectedWabaId, limit = 100, cursor = "" }) {
  const requestedWabaId = String(wabaId || "");
  const ownedWabaId = String(connectedWabaId || "");
  const normalizedCursor = typeof cursor === "string" ? cursor.trim() : "";
  if (!/^[0-9]{5,32}$/.test(requestedWabaId) || !/^[0-9]{5,32}$/.test(ownedWabaId) ||
      requestedWabaId !== ownedWabaId) {
    throw httpError("The requested WhatsApp Business Account does not match the connected number.", 403);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      normalizedCursor.length > 2048 || normalizedCursor.split("").some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw httpError("Template limit must be 1–100 and cursor must be a valid Meta paging cursor.");
  }
  const graphVersion = typeof version === "string" && /^v[0-9]+[.][0-9]+$/.test(version) ? version : "v26.0";
  const url = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(requestedWabaId)}/message_templates`);
  url.searchParams.set("fields", "id,name,status,language,category,components");
  url.searchParams.set("limit", String(limit));
  if (normalizedCursor) url.searchParams.set("after", normalizedCursor);
  return url;
}

module.exports = {
  normalizeTemplateConsent,
  countTemplatePlaceholders,
  buildPublicTemplateComponents,
  buildPublicTemplateListUrl
};
