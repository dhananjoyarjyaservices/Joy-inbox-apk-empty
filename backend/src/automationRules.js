const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeAutomationRule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Automation rule details are required.", 400);
  const allowed = ["name", "keyword", "matchType", "response", "steps", "enabled", "priority"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw httpError("Automation rule contains unsupported fields.", 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const keyword = typeof input.keyword === "string" ? input.keyword.trim().slice(0, 80) : "";
  if (input.matchType !== undefined && !["contains", "exact", "starts_with"].includes(input.matchType)) throw httpError("Match type must be contains, exact or starts_with.", 400);
  const matchType = input.matchType || "contains";
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000)) throw httpError("Priority must be an integer from 0 to 1,000.", 400);
  const priority = input.priority === undefined ? 100 : input.priority;
  const rawSteps = Array.isArray(input.steps) ? input.steps : [input.response];
  if (rawSteps.length < 1 || rawSteps.length > 5) throw httpError("An automation flow must contain between 1 and 5 reply steps.", 400);
  const steps = rawSteps.map((step) => {
    if (typeof step === "string") return { message: step.trim(), delaySeconds: 0 };
    if (!step || typeof step !== "object" || Array.isArray(step)) return { message: "", delaySeconds: 0 };
    if (Object.keys(step).some((key) => !["message", "delaySeconds"].includes(key))) throw httpError("Workflow steps may only contain message and delaySeconds.", 400);
    const delaySeconds = step.delaySeconds === undefined ? 0 : step.delaySeconds;
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 86400) throw httpError("Each step delay must be between 0 and 86,400 seconds.", 400);
    return { message: typeof step.message === "string" ? step.message.trim() : "", delaySeconds };
  });
  if (steps.some((step) => !step.message || step.message.length > 1024)) throw httpError("Each reply step is required and must be 1,024 characters or fewer.", 400);
  if (!name || name.length > 80) throw httpError("Rule name is required (maximum 80 characters).", 400);
  if (!keyword || keyword.length > 80 || [...keyword].some((character) => character.charCodeAt(0) < 32)) throw httpError("Keyword is required (maximum 80 characters).", 400);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw httpError("Enabled must be true or false.", 400);
  return { name, keyword, matchType, response: steps[0].message, steps, enabled: input.enabled !== false, priority };
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
