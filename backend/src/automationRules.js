const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeAutomationRule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError("Automation rule details are required.", 400);
  }
  const allowed = ["name", "keyword", "matchType", "response", "steps", "enabled", "priority"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw httpError("Automation rule contains unsupported fields.", 400);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const keyword = typeof input.keyword === "string" ? input.keyword.trim().slice(0, 80) : "";
  const matchType = ["contains", "exact", "starts_with"].includes(input.matchType) ? input.matchType : "contains";
  const priority = Number.isInteger(input.priority) ? Math.max(0, Math.min(1000, input.priority)) : 100;
  const rawSteps = Array.isArray(input.steps) ? input.steps : [input.response];
  if (rawSteps.length < 1 || rawSteps.length > 5) throw httpError("An automation flow must contain between 1 and 5 reply steps.", 400);
  const steps = rawSteps.map((step) => typeof step === "string" ? step.trim() : "");
  if (steps.some((step) => !step || step.length > 1024)) throw httpError("Each reply step is required and must be 1,024 characters or fewer.", 400);
  if (!name || name.length > 80) throw httpError("Rule name is required (maximum 80 characters).", 400);
  if (!keyword || keyword.length > 80 || [...keyword].some((character) => character.charCodeAt(0) < 32)) throw httpError("Keyword is required (maximum 80 characters).", 400);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw httpError("Enabled must be true or false.", 400);
  return { name, keyword, matchType, response: steps[0], steps, enabled: input.enabled !== false, priority };
}

function matchesAutomationRule(rule, messageText) {
  const message = String(messageText || "").trim().toLowerCase();
  const keyword = String(rule.keyword || "").trim().toLowerCase();
  if (!message || !keyword) return false;
  if (rule.matchType === "exact") return message === keyword;
  if (rule.matchType === "starts_with") return message.startsWith(keyword);
  return message.includes(keyword);
}

module.exports = { ID_PATTERN, normalizeAutomationRule, matchesAutomationRule };
