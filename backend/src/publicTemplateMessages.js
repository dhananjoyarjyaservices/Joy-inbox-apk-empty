"use strict";

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.definitive = true;
  return error;
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
  const urlButtons = definitions.flatMap(item =>
    item.type === "BUTTONS" && Array.isArray(item.buttons)
      ? item.buttons.map((button, index) => ({ ...button, index }))
      : []
  ).filter(button => button.type === "URL" && String(button.url || "").includes("{{"));
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

module.exports = { countTemplatePlaceholders, buildPublicTemplateComponents };
