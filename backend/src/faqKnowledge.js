const FAQ_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeFaqEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("FAQ entry is required.");
  const allowed = ["question", "answer", "keywords", "matchMode", "enabled", "priority"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw httpError("Unsupported FAQ entry field.");
  const question = typeof input.question === "string" ? input.question.trim() : "";
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (!question || question.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(question)) {
    throw httpError("FAQ question must be 1–200 characters.");
  }
  if (!answer || answer.length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(answer)) {
    throw httpError("FAQ answer must be 1–1024 characters.");
  }
  if (!Array.isArray(input.keywords) || input.keywords.length < 1 || input.keywords.length > 8 ||
      input.keywords.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 60)) {
    throw httpError("Add between 1 and 8 FAQ keywords, each up to 60 characters.");
  }
  const keywords = input.keywords.map((item) => item.trim()).filter((item, index, all) =>
    all.findIndex((other) => other.toLocaleLowerCase() === item.toLocaleLowerCase()) === index);
  if (!keywords.length) throw httpError("At least one FAQ keyword is required.");
  if (input.matchMode !== undefined && !["all", "any"].includes(input.matchMode)) throw httpError("FAQ match mode must be all or any.");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw httpError("FAQ enabled must be a boolean.");
  const priority = input.priority === undefined ? 100 : input.priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw httpError("FAQ priority must be an integer from 0 to 1000.");
  return { question, answer, keywords, matchMode: input.matchMode || "any", enabled: input.enabled !== false, priority };
}

function normalizeFaqText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function matchesFaqEntry(entry, messageText) {
  if (!entry || entry.enabled === false) return false;
  const message = normalizeFaqText(messageText);
  if (!message || !Array.isArray(entry.keywords) || !entry.keywords.length) return false;
  const matches = entry.keywords.map((keyword) => {
    const normalized = normalizeFaqText(keyword);
    return normalized.length >= 2 && (` ${message} `).includes(` ${normalized} `);
  });
  return entry.matchMode === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

function findMatchingFaqEntry(entries, messageText) {
  if (!Array.isArray(entries)) return null;
  return entries
    .filter((entry) => matchesFaqEntry(entry, messageText))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) ||
      String(a.id || "").localeCompare(String(b.id || "")))[0] || null;
}

module.exports = { FAQ_ID_PATTERN, normalizeFaqEntry, normalizeFaqText, matchesFaqEntry, findMatchingFaqEntry };
