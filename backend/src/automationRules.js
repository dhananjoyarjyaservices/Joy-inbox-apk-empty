const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeAutomationRule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Automation rule details are required.", 400);
  const allowed = ["name", "keyword", "matchType", "conditions", "conditionMode", "response", "steps", "enabled", "priority"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw httpError("Automation rule contains unsupported fields.", 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const hasConditions = input.conditions !== undefined;
  if (hasConditions && (input.keyword !== undefined || input.matchType !== undefined)) {
    throw httpError("Use either legacy keyword matching or conditions, not both.", 400);
  }
  if (hasConditions && (!Array.isArray(input.conditions) || input.conditions.length < 1 || input.conditions.length > 5)) {
    throw httpError("Provide between 1 and 5 automation conditions.", 400);
  }
  if (!hasConditions && input.conditionMode !== undefined) throw httpError("Condition mode can only be used with conditions.", 400);
  if (input.conditionMode !== undefined && !["all", "any"].includes(input.conditionMode)) {
    throw httpError("Condition mode must be all or any.", 400);
  }
  const conditions = hasConditions ? input.conditions.map((condition) => {
    if (!condition || typeof condition !== "object" || Array.isArray(condition) ||
        Object.keys(condition).some((key) => !["keyword", "matchType"].includes(key))) {
      throw httpError("Each condition may only contain keyword and matchType.", 400);
    }
    const value = typeof condition.keyword === "string" ? condition.keyword.trim() : "";
    const matchType = condition.matchType === undefined ? "contains" : condition.matchType;
    if (!value || value.length > 80 || [...value].some((character) => character.charCodeAt(0) < 32)) {
      throw httpError("Each condition keyword is required (maximum 80 characters).", 400);
    }
    if (!["contains", "exact", "starts_with"].includes(matchType)) {
      throw httpError("Condition match type must be contains, exact or starts_with.", 400);
    }
    return { keyword: value, matchType };
  }) : null;
  const keyword = hasConditions ? conditions[0].keyword :
    (typeof input.keyword === "string" ? input.keyword.trim().slice(0, 80) : "");
  if (!hasConditions && input.matchType !== undefined && !["contains", "exact", "starts_with"].includes(input.matchType)) {
    throw httpError("Match type must be contains, exact or starts_with.", 400);
  }
  const matchType = hasConditions ? conditions[0].matchType : (input.matchType || "contains");
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
  if (!hasConditions && (!keyword || keyword.length > 80 || [...keyword].some((character) => character.charCodeAt(0) < 32))) throw httpError("Keyword is required (maximum 80 characters).", 400);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw httpError("Enabled must be true or false.", 400);
  return {
    name, keyword, matchType, ...(conditions ? { conditions, conditionMode: input.conditionMode || "all" } : {}),
    response: steps[0].message, steps, enabled: input.enabled !== false, priority
  };
}

function sortAutomationRules(rules) {
  return [...rules].sort((a, b) => {
    const priorityA = Number.isInteger(a.priority) ? a.priority : 100;
    const priorityB = Number.isInteger(b.priority) ? b.priority : 100;
    return priorityA - priorityB ||
      String(a.name || "").localeCompare(String(b.name || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""));
  });
}

function normalizeAutomationMatchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("und");
}

function matchesKeyword(message, keyword, matchType) {
  const normalizedKeyword = normalizeAutomationMatchText(keyword);
  if (!message || !normalizedKeyword) return false;
  if (matchType === "exact") return message === normalizedKeyword;
  if (matchType === "starts_with") return message.startsWith(normalizedKeyword);
  return message.includes(normalizedKeyword);
}

function matchesAutomationRule(rule, messageText) {
  const message = normalizeAutomationMatchText(messageText);
  if (!message) return false;
  if (Array.isArray(rule.conditions) && rule.conditions.length) {
    const results = rule.conditions.map(condition =>
      matchesKeyword(message, condition.keyword, condition.matchType)
    );
    return rule.conditionMode === "any" ? results.some(Boolean) : results.every(Boolean);
  }
  return matchesKeyword(message, rule.keyword, rule.matchType);
}

function findMatchingAutomationRule(rules, messageText) {
  return sortAutomationRules(rules).find(rule =>
    rule.enabled === true && matchesAutomationRule(rule, messageText)
  ) || null;
}

module.exports = {
  ID_PATTERN,
  normalizeAutomationRule,
  sortAutomationRules,
  normalizeAutomationMatchText,
  matchesAutomationRule,
  findMatchingAutomationRule
};
