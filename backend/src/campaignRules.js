const MAX_CAMPAIGN_RECIPIENTS = 5000;
const MAX_TEMPLATE_VARIABLES = 20;
const CAMPAIGN_CATEGORIES = new Set(["MARKETING", "UTILITY", "AUTHENTICATION"]);
const CAMPAIGN_STATUSES = new Set(["draft", "scheduled", "queued", "sending", "paused", "completed", "failed", "cancelled"]);

function campaignError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeCampaignDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw campaignError("Campaign details are required.");
  }
  const name = String(input.name || "").trim();
  const templateName = String(input.templateName || "").trim();
  const language = String(input.language || "").trim();
  const category = String(input.category || "").trim().toUpperCase();
  const phoneNumberId = String(input.phoneNumberId || "").trim();
  const wabaId = String(input.wabaId || "").trim();
  if (!name || name.length > 100) throw campaignError("Campaign name must contain 1–100 characters.");
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) throw campaignError("A valid approved WhatsApp template name is required.");
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) throw campaignError("A valid template language code is required.");
  if (!CAMPAIGN_CATEGORIES.has(category)) throw campaignError("Campaign category must be MARKETING, UTILITY or AUTHENTICATION.");
  if (!/^[0-9]{5,32}$/.test(phoneNumberId) || !/^[0-9]{5,32}$/.test(wabaId)) {
    throw campaignError("A valid connected phone number and WhatsApp Business Account ID are required.");
  }
  const defaultVariables = input.variables === undefined ? [] : input.variables;
  if (!Array.isArray(defaultVariables) || defaultVariables.length > MAX_TEMPLATE_VARIABLES ||
      !defaultVariables.every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 1024)) {
    throw campaignError("Campaign template variables are invalid.");
  }
  return {
    name,
    templateName,
    language,
    category,
    phoneNumberId,
    wabaId,
    variables: defaultVariables.map(value => value.trim())
  };
}

function normalizeCampaignRecipients(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_CAMPAIGN_RECIPIENTS) {
    throw campaignError(`Campaigns must contain 1–${MAX_CAMPAIGN_RECIPIENTS} recipients.`);
  }
  const recipients = [];
  const seen = new Set();
  let skipped = 0;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skipped += 1;
      continue;
    }
    const phone = String(item.phone || item.to || "").replace(/\\D/g, "");
    const consentAt = item.consentAt;
    const consentSource = String(item.consentSource || "").trim().slice(0, 120);
    const validConsentDate = typeof consentAt === "string" && !Number.isNaN(Date.parse(consentAt));
    if (item.optedIn !== true || !/^[1-9][0-9]{7,14}$/.test(phone) ||
        !validConsentDate || !consentSource) {
      skipped += 1;
      continue;
    }
    if (seen.has(phone)) {
      skipped += 1;
      continue;
    }
    const variables = item.variables === undefined ? [] : item.variables;
    if (!Array.isArray(variables) || variables.length > MAX_TEMPLATE_VARIABLES ||
        !variables.every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 1024)) {
      throw campaignError(`Template variables are invalid for recipient ending ${phone.slice(-4)}.`);
    }
    seen.add(phone);
    recipients.push({
      phone,
      optedIn: true,
      consentAt: new Date(consentAt).toISOString(),
      consentSource,
      variables: variables.map(value => value.trim())
    });
  }
  if (!recipients.length) throw campaignError("No eligible recipients found. Each recipient needs a valid number and recorded WhatsApp opt-in.");
  return { recipients, skipped };
}

function canTransitionCampaign(from, to) {
  if (!CAMPAIGN_STATUSES.has(from) || !CAMPAIGN_STATUSES.has(to)) return false;
  const transitions = {
    draft: ["scheduled", "queued", "cancelled"],
    scheduled: ["queued", "paused", "cancelled"],
    queued: ["sending", "paused", "cancelled"],
    sending: ["paused", "completed", "failed"],
    paused: ["queued", "cancelled"],
    completed: [],
    failed: [],
    cancelled: []
  };
  return transitions[from].includes(to);
}

module.exports = {
  MAX_CAMPAIGN_RECIPIENTS,
  MAX_TEMPLATE_VARIABLES,
  normalizeCampaignDefinition,
  normalizeCampaignRecipients,
  canTransitionCampaign
};
