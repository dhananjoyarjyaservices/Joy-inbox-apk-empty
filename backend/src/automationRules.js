const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeAutomationRule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Automation rule details are required.", 400);
  const allowed = ["name", "keyword", "matchType", "conditions", "conditionMode", "response", "steps", "enabled", "priority", "schedule", "branches", "outOfOfficeMessage", "outOfOfficeEnabled"];
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
    if (!["contains", "exact", "starts_with", "ends_with", "not_contains", "not_exact"].includes(matchType)) {
      throw httpError("Condition match type must be contains, exact or starts_with.", 400);
    }
    return { keyword: value, matchType };
  }) : null;
  const keyword = hasConditions ? conditions[0].keyword :
    (typeof input.keyword === "string" ? input.keyword.trim().slice(0, 80) : "");
  if (!hasConditions && input.matchType !== undefined && !["contains", "exact", "starts_with", "ends_with", "not_contains", "not_exact"].includes(input.matchType)) {
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
  let schedule;
  if (input.schedule !== undefined && input.schedule !== null) {
    const value = input.schedule;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !["timezone", "days", "startTime", "endTime"].includes(key))) {
      throw httpError("Schedule may only contain timezone, days, startTime and endTime.", 400);
    }
    const timezone = typeof value.timezone === "string" ? value.timezone.trim() : "";
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
    catch { throw httpError("Schedule timezone must be a valid IANA timezone.", 400); }
    const days = value.days;
    if (!Array.isArray(days) || days.length < 1 || days.length > 7 ||
        days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
        new Set(days).size !== days.length) {
      throw httpError("Schedule days must be unique weekday numbers from 0 (Sunday) to 6 (Saturday).", 400);
    }
    const validTime = (time) => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
    if (!validTime(value.startTime) || !validTime(value.endTime) || value.startTime >= value.endTime) {
      throw httpError("Schedule startTime and endTime must be valid 24-hour times, with startTime before endTime.", 400);
    }
    schedule = { timezone, days: [...days].sort((a, b) => a - b), startTime: value.startTime, endTime: value.endTime };
  }
  let branches;
  if (input.branches !== undefined) {
    if (!Array.isArray(input.branches) || input.branches.length < 1 || input.branches.length > 5) {
      throw httpError("Provide between 1 and 5 conditional branches.", 400);
    }
    const branchNames = new Set();
    branches = input.branches.map((branch) => {
      if (!branch || typeof branch !== "object" || Array.isArray(branch) ||
          Object.keys(branch).some((key) => !["name", "conditions", "conditionMode", "steps"].includes(key))) {
        throw httpError("Each branch may only contain name, conditions, conditionMode and steps.", 400);
      }
      const branchName = typeof branch.name === "string" ? branch.name.trim() : "";
      if (!branchName || branchName.length > 50 || branchNames.has(branchName.toLocaleLowerCase("und"))) {
        throw httpError("Each branch needs a unique name (maximum 50 characters).", 400);
      }
      branchNames.add(branchName.toLocaleLowerCase("und"));
      if (!Array.isArray(branch.conditions) || branch.conditions.length < 1 || branch.conditions.length > 5 ||
          (branch.conditionMode !== undefined && !["all", "any"].includes(branch.conditionMode))) {
        throw httpError("Each branch needs 1–5 conditions and an all/any condition mode.", 400);
      }
      const branchConditions = branch.conditions.map((condition) => {
        if (!condition || typeof condition !== "object" || Array.isArray(condition) ||
            Object.keys(condition).some((key) => !["keyword", "matchType"].includes(key))) {
          throw httpError("Branch conditions may only contain keyword and matchType.", 400);
        }
        const value = typeof condition.keyword === "string" ? condition.keyword.trim() : "";
        const matchType = condition.matchType === undefined ? "contains" : condition.matchType;
        if (!value || value.length > 80 || [...value].some((character) => character.charCodeAt(0) < 32) ||
            !["contains", "exact", "starts_with", "ends_with", "not_contains", "not_exact"].includes(matchType)) {
          throw httpError("Branch condition keywords and match types are invalid.", 400);
        }
        return { keyword: value, matchType };
      });
      if (!Array.isArray(branch.steps) || branch.steps.length < 1 || branch.steps.length > 5) {
        throw httpError("Each branch must contain between 1 and 5 reply steps.", 400);
      }
      const branchSteps = branch.steps.map((step) => {
        if (typeof step === "string") return { message: step.trim(), delaySeconds: 0 };
        if (!step || typeof step !== "object" || Array.isArray(step) ||
            Object.keys(step).some((key) => !["message", "delaySeconds"].includes(key))) {
          throw httpError("Branch steps may only contain message and delaySeconds.", 400);
        }
        const delaySeconds = step.delaySeconds === undefined ? 0 : step.delaySeconds;
        if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 86400) {
          throw httpError("Branch step delays must be between 0 and 86,400 seconds.", 400);
        }
        return { message: typeof step.message === "string" ? step.message.trim() : "", delaySeconds };
      });
      if (branchSteps.some((step) => !step.message || step.message.length > 1024)) {
        throw httpError("Each branch reply is required and must be 1,024 characters or fewer.", 400);
      }
      return { name: branchName, conditions: branchConditions, conditionMode: branch.conditionMode || "all", steps: branchSteps };
    });
  }
  const outOfOfficeMessage = input.outOfOfficeMessage === undefined ? "" : (typeof input.outOfOfficeMessage === "string" ? input.outOfOfficeMessage.trim() : null);
  if (outOfOfficeMessage === null || outOfOfficeMessage.length > 1024 || [...outOfOfficeMessage].some((character) => character.charCodeAt(0) < 32 && character !== "\n" && character !== "\t")) {
    throw httpError("Out-of-office reply must be text of 1,024 characters or fewer.", 400);
  }
  if (outOfOfficeMessage && !schedule) throw httpError("An out-of-office reply requires a business-hours schedule.", 400);
  if (input.outOfOfficeEnabled !== undefined && typeof input.outOfOfficeEnabled !== "boolean") throw httpError("Out-of-office enabled must be true or false.", 400);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw httpError("Enabled must be true or false.", 400);
  return {
    name, keyword, matchType, ...(conditions ? { conditions, conditionMode: input.conditionMode || "all" } : {}),
    response: steps[0].message, steps, enabled: input.enabled !== false, priority, ...(schedule ? { schedule } : {}), ...(branches ? { branches } : {}), ...(outOfOfficeMessage ? { outOfOfficeMessage, outOfOfficeEnabled: input.outOfOfficeEnabled !== false } : {})
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
  if (matchType === "ends_with") return message.endsWith(normalizedKeyword);
  if (matchType === "not_contains") return !message.includes(normalizedKeyword);
  if (matchType === "not_exact") return message !== normalizedKeyword;
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

function selectAutomationBranch(rule, messageText) {
  const message = normalizeAutomationMatchText(messageText);
  if (message && Array.isArray(rule?.branches)) {
    const branchIndex = rule.branches.findIndex((item) => {
      const results = item.conditions.map((condition) => matchesKeyword(message, condition.keyword, condition.matchType));
      return item.conditionMode === "any" ? results.some(Boolean) : results.every(Boolean);
    });
    if (branchIndex >= 0) {
      const branch = rule.branches[branchIndex];
      return { branchName: String(branch.name || ""), branchIndex, steps: Array.isArray(branch.steps) ? branch.steps : [] };
    }
  }
  return { branchName: null, branchIndex: null, steps: Array.isArray(rule?.steps) ? rule.steps : [] };
}

function selectAutomationSteps(rule, messageText) {
  return selectAutomationBranch(rule, messageText).steps;
}

function isWithinAutomationSchedule(rule, instant = new Date()) {
  if (!rule?.schedule) return true;
  const schedule = rule.schedule;
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = weekdays[values.weekday];
    const current = values.hour + ":" + values.minute;
    return Array.isArray(schedule.days) && schedule.days.includes(day) &&
      current >= schedule.startTime && current < schedule.endTime;
  } catch {
    return false;
  }
}

function findMatchingAutomationRule(rules, messageText, instant = new Date()) {
  return sortAutomationRules(rules).find(rule =>
    rule.enabled === true && matchesAutomationRule(rule, messageText) &&
    isWithinAutomationSchedule(rule, instant)
  ) || null;
}

function normalizeOutOfOfficeSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["enabled", "message", "schedule"].includes(key))) {
    throw httpError("Out-of-office settings contain unsupported fields.", 400);
  }
  if (typeof input.enabled !== "boolean") throw httpError("Out-of-office enabled state is required.", 400);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message.length > 1024 || (input.enabled && !message)) {
    throw httpError("Enabled out-of-office replies require a message of at most 1,024 characters.", 400);
  }
  const value = input.schedule;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["timezone", "days", "startTime", "endTime"].includes(key))) {
    throw httpError("A valid out-of-office working-hours schedule is required.", 400);
  }
  const timezone = typeof value.timezone === "string" ? value.timezone.trim() : "";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { throw httpError("Out-of-office timezone must be a valid IANA timezone.", 400); }
  if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 7 ||
      value.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(value.days).size !== value.days.length) {
    throw httpError("Choose unique working days from Sunday to Saturday.", 400);
  }
  const validTime = (time) => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!validTime(value.startTime) || !validTime(value.endTime) || value.startTime >= value.endTime) {
    throw httpError("Working hours must use valid 24-hour times, with start before end.", 400);
  }
  return {
    enabled: input.enabled, message,
    schedule: { timezone, days: [...value.days].sort((a, b) => a - b), startTime: value.startTime, endTime: value.endTime }
  };
}

function getOutOfOfficeSkipReason(chat = {}, instant = new Date()) {
  const now = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(now)) return "invalid_instant";
  const toTimestamp = (value) => {
    const date = value?.toDate ? value.toDate() : value instanceof Date ? value : new Date(value || 0);
    return date.getTime();
  };
  const lastSentAt = toTimestamp(chat.outOfOfficeSentAt);
  if (Number.isFinite(lastSentAt) && now - lastSentAt >= 0 && now - lastSentAt < 24 * 60 * 60 * 1000) {
    return "out_of_office_cooldown";
  }
  const claimedAt = toTimestamp(chat.outOfOfficeClaimedAt);
  if (chat.outOfOfficeClaimedFor && Number.isFinite(claimedAt) &&
      now - claimedAt >= 0 && now - claimedAt < 2 * 60 * 1000) {
    return "out_of_office_send_in_progress";
  }
  return null;
}

function selectWorkspaceOutOfOfficeRule(settings, instant = new Date()) {
  if (!settings || settings.enabled !== true || typeof settings.message !== "string" ||
      !settings.message.trim() || !settings.schedule ||
      isWithinAutomationSchedule({ schedule: settings.schedule }, instant)) return null;
  return {
    id: "workspace_out_of_office",
    name: "Workspace out-of-office",
    outOfOfficeMessage: settings.message.trim(),
    enabled: true
  };
}

function findMatchingOutOfOfficeRule(rules, messageText, instant = new Date()) {
  return sortAutomationRules(rules).find(rule =>
    rule.enabled === true && rule.outOfOfficeEnabled !== false && typeof rule.outOfOfficeMessage === "string" && rule.outOfOfficeMessage.trim() &&
    rule.schedule && matchesAutomationRule(rule, messageText) &&
    !isWithinAutomationSchedule(rule, instant)
  ) || null;
}

module.exports = {
  ID_PATTERN,
  normalizeAutomationRule,
  sortAutomationRules,
  normalizeAutomationMatchText,
  matchesAutomationRule,
  findMatchingAutomationRule,
  findMatchingOutOfOfficeRule,
  getOutOfOfficeSkipReason,
  normalizeOutOfOfficeSettings,
  selectWorkspaceOutOfOfficeRule,
  isWithinAutomationSchedule,
  selectAutomationSteps,
  selectAutomationBranch
};
