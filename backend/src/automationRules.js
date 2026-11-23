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
  const allowed = ["name", "keyword", "matchType", "response", "enabled", "priority"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw httpError("Automation rule contains unsupported fields.", 400);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const keyword = typeof input.keyword === "string" ? input.keyword.trim().slice(0, 80) : "";
  const response = typeof input.response === "string" ? input.response.trim() : "";
  const matchType = ["contains", "exact", "starts_with"].includes(input.matchType) ? input.matchType : "contains";
  const priority = Number.isInteger(input.priority) ? Math.max(0, Math.min(1000, input.priority)) : 100;
  if (!name || name.length > 80) throw httpError("Rule name is required (maximum 80 characters).", 400);
  if (!keyword || keyword.length > 80 || /[\u0000-\u001f]/.test(keyword)) throw httpError("Keyword is required (maximum 80 characters).", 400);
  if (!response || response.length > 1024) throw httpError("Reply is required (maximum 1024 characters).", 400);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw httpError("Enabled must be true or false.", 400);
  return { name, keyword, matchType, response, enabled: input.enabled !== false, priority };
}

function matchesAutomationRule(rule, messageText) {
  const message = String(messageText || "").trim().toLocaleLowerCase();
  const keyword = String(rule.keyword || "").trim().toLocaleLowerCase();
  if (!message || !keyword) return false;
  if (rule.matchType === "exact") return message === keyword;
  if (rule.matchType === "starts_with") return message.startsWith(keyword);
  return message.includes(keyword);
}

module.exports = { ID_PATTERN, normalizeAutomationRule, matchesAutomationRule };
