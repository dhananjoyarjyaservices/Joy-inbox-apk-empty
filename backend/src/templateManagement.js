"use strict";

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.definitive = true;
  return error;
}

const NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
const TEMPLATE_ID_PATTERN = /^[0-9]{5,32}$/;
const CATEGORIES = new Set(["UTILITY", "MARKETING"]);

function countPlaceholders(value) {
  const indexes = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
  return indexes.length ? Math.max(...indexes) : 0;
}

function cleanText(value, field, maxLength, required = true) {
  if (typeof value !== "string") throw httpError(field + " must be text.");
  const text = value.trim();
  if ((required && !text) || text.length > maxLength) {
    throw httpError(field + " must contain " + (required ? "1–" : "0–") + maxLength + " characters.");
  }
  return text;
}

function normalizeTemplateComponents(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 4) {
    throw httpError("Template components must contain 1–4 supported components.");
  }
  const seen = new Set();
  const result = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(item.type) || seen.has(item.type)) {
      throw httpError("Template components contain an unsupported or duplicate component.");
    }
    seen.add(item.type);
    if (item.type === "HEADER") {
      if (item.format === "TEXT") {
        const component = { type: "HEADER", format: "TEXT", text: cleanText(item.text, "Header text", 60) };
        const headerVariables = countPlaceholders(component.text);
        if (headerVariables > 1) throw httpError("Text headers support at most one variable.");
        if (item.example !== undefined || headerVariables > 0) {
          if (!item.example || !Array.isArray(item.example.header_text) ||
              item.example.header_text.length !== 1 || typeof item.example.header_text[0] !== "string") {
            throw httpError("A variable text header requires one header_text example.");
          }
          component.example = { header_text: [cleanText(item.example.header_text[0], "Header example", 60)] };
        }
        result.push(component);
      } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(item.format)) {
        const handles = item.example?.header_handle;
        if (!Array.isArray(handles) || handles.length !== 1 || typeof handles[0] !== "string") {
          throw httpError("A media header requires one uploaded Meta header_handle.");
        }
        const handle = cleanText(handles[0], "Header media handle", 4096);
        if (/[\x00-\x1f\x7f]/.test(handle)) throw httpError("Header media handle contains invalid characters.");
        result.push({ type: "HEADER", format: item.format, example: { header_handle: [handle] } });
      } else {
        throw httpError("Header format must be TEXT, IMAGE, VIDEO or DOCUMENT.");
      }
    } else if (item.type === "BODY") {
      const component = { type: "BODY", text: cleanText(item.text, "Body text", 1024) };
      const bodyVariables = countPlaceholders(component.text);
      if (item.example !== undefined || bodyVariables > 0) {
        const samples = item.example?.body_text;
        if (!Array.isArray(samples) || samples.length < 1 || samples.length > 5 ||
            samples.some(row => !Array.isArray(row) || row.length !== bodyVariables ||
              row.some(value => typeof value !== "string" || !value.trim() || value.length > 1024))) {
          throw httpError("A variable body requires 1–5 example rows with one sample per placeholder.");
        }
        component.example = { body_text: samples.map(row => row.map(value => value.trim())) };
      }
      result.push(component);
    } else if (item.type === "FOOTER") {
      result.push({ type: "FOOTER", text: cleanText(item.text, "Footer text", 60) });
    } else {
      if (!Array.isArray(item.buttons) || item.buttons.length < 1 || item.buttons.length > 3) {
        throw httpError("Templates support 1–3 buttons.");
      }
      const quickReplyCount = item.buttons.filter(button => button?.type === "QUICK_REPLY").length;
      const ctaTypes = item.buttons.filter(button => button?.type === "URL" || button?.type === "PHONE_NUMBER").map(button => button.type);
      if (quickReplyCount && ctaTypes.length) throw httpError("Quick reply buttons cannot be mixed with call-to-action buttons.");
      if (ctaTypes.length > 2 || new Set(ctaTypes).size !== ctaTypes.length) {
        throw httpError("Call-to-action templates support one URL and one phone button at most.");
      }
      const buttons = item.buttons.map(button => {
        if (!button || typeof button !== "object" || Array.isArray(button)) throw httpError("Template button is invalid.");
        const type = button.type;
        const text = cleanText(button.text, "Button text", 25);
        if (type === "QUICK_REPLY") return { type, text };
        if (type === "URL") {
          const url = cleanText(button.url, "Button URL", 2000);
          let parsed;
          try { parsed = new URL(url); } catch { throw httpError("Button URL must be a valid HTTPS URL."); }
          if (parsed.protocol !== "https:") throw httpError("Button URL must use HTTPS.");
          if (url.includes("{{")) throw httpError("Dynamic URL buttons are not yet supported by the template manager.");
          return { type, text, url };
        }
        if (type === "PHONE_NUMBER") {
          const phoneNumber = cleanText(button.phone_number, "Button phone number", 20);
          if (/^\+[1-9][0-9]{7,14}$/.test(phoneNumber) === false) throw httpError("Button phone number must be in international format.");
          return { type, text, phone_number: phoneNumber };
        }
        throw httpError("Only QUICK_REPLY, URL and PHONE_NUMBER template buttons are currently supported.");
      });
      result.push({ type: "BUTTONS", buttons });
    }
  }
  if (!seen.has("BODY")) throw httpError("A BODY component is required.");
  return result;
}

function normalizeTemplateDefinition(input, { allowPartial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Template details are required.");
  const result = {};
  if (!allowPartial || input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!NAME_PATTERN.test(name)) throw httpError("Template name must use lowercase letters, numbers and underscores.");
    result.name = name;
  }
  if (!allowPartial || input.language !== undefined) {
    const language = typeof input.language === "string" ? input.language.trim() : "";
    if (!LANGUAGE_PATTERN.test(language)) throw httpError("Template language code is invalid.");
    result.language = language;
  }
  if (!allowPartial || input.category !== undefined) {
    const category = typeof input.category === "string" ? input.category.trim().toUpperCase() : "";
    if (!CATEGORIES.has(category)) throw httpError("Template category must be UTILITY or MARKETING.");
    result.category = category;
  }
  if (!allowPartial || input.components !== undefined) result.components = normalizeTemplateComponents(input.components);
  if (input.allowCategoryChange !== undefined) {
    if (typeof input.allowCategoryChange !== "boolean") throw httpError("allowCategoryChange must be boolean.");
    result.allow_category_change = input.allowCategoryChange;
  }
  return result;
}

function normalizeAuthenticationTemplateDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Authentication template details are required.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const language = typeof input.language === "string" ? input.language.trim() : "";
  if (!NAME_PATTERN.test(name)) throw httpError("Template name must use lowercase letters, numbers and underscores.");
  if (!LANGUAGE_PATTERN.test(language)) throw httpError("Template language code is invalid.");
  const otpType = String(input.otpType || "COPY_CODE").trim().toUpperCase();
  if (!["COPY_CODE", "ONE_TAP"].includes(otpType)) throw httpError("OTP button type must be COPY_CODE or ONE_TAP.");
  const addSecurityRecommendation = input.addSecurityRecommendation === undefined ? true : input.addSecurityRecommendation;
  if (typeof addSecurityRecommendation !== "boolean") throw httpError("addSecurityRecommendation must be boolean.");
  const components = [{ type: "BODY", add_security_recommendation: addSecurityRecommendation }];
  if (input.codeExpirationMinutes !== undefined && input.codeExpirationMinutes !== null && input.codeExpirationMinutes !== "") {
    const minutes = Number(input.codeExpirationMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 90) {
      throw httpError("Code expiration must be a whole number between 1 and 90 minutes.");
    }
    components.push({ type: "FOOTER", code_expiration_minutes: minutes });
  }
  const button = { type: "OTP", otp_type: otpType };
  if (otpType === "ONE_TAP") {
    if (!Array.isArray(input.supportedApps) || input.supportedApps.length < 1 || input.supportedApps.length > 5) {
      throw httpError("One-tap autofill requires 1–5 supported Android apps.");
    }
    button.supported_apps = input.supportedApps.map((app, index) => {
      if (!app || typeof app !== "object" || Array.isArray(app)) throw httpError("Supported Android app " + (index + 1) + " is invalid.");
      const packageName = typeof app.packageName === "string" ? app.packageName.trim() : "";
      const signatureHash = typeof app.signatureHash === "string" ? app.signatureHash.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
        throw httpError("Supported Android app package name is invalid.");
      }
      if (!/^[A-Za-z0-9+/]{11}$/.test(signatureHash)) {
        throw httpError("Android signing key hash must contain exactly 11 base64 characters.");
      }
      return { package_name: packageName, signature_hash: signatureHash };
    });
    if (new Set(button.supported_apps.map(app => app.package_name)).size !== button.supported_apps.length) {
      throw httpError("Supported Android app package names must be unique.");
    }
  } else if (input.supportedApps !== undefined && input.supportedApps !== null) {
    if (!Array.isArray(input.supportedApps) || input.supportedApps.length > 0) {
      throw httpError("Supported Android apps are only used with one-tap autofill.");
    }
  }
  components.push({ type: "BUTTONS", buttons: [button] });
  const result = { name, language, category: "AUTHENTICATION", components };
  if (input.messageSendTtlSeconds !== undefined && input.messageSendTtlSeconds !== null && input.messageSendTtlSeconds !== "") {
    const ttl = Number(input.messageSendTtlSeconds);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 600) {
      throw httpError("Authentication message TTL must be a whole number between 60 and 600 seconds.");
    }
    result.message_send_ttl_seconds = ttl;
  }
  return result;
}

function normalizeTemplateMutationIdentity(input) {
  const templateId = typeof input?.templateId === "string" ? input.templateId.trim() : "";
  const templateName = typeof input?.templateName === "string" ? input.templateName.trim() : "";
  if (!TEMPLATE_ID_PATTERN.test(templateId) || !NAME_PATTERN.test(templateName)) {
    throw httpError("A valid templateId and templateName are required.");
  }
  return { templateId, templateName };
}

module.exports = {
  normalizeTemplateComponents,
  normalizeTemplateDefinition,
  normalizeAuthenticationTemplateDefinition,
  normalizeTemplateMutationIdentity,
  TEMPLATE_ID_PATTERN,
  NAME_PATTERN
};
