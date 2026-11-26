"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTemplateComponents,
  normalizeTemplateDefinition,
  normalizeAuthenticationTemplateDefinition,
  normalizeAuthenticationOtpCode,
  buildAuthenticationTemplateSendComponents,
  normalizeTemplateMutationIdentity
} = require("../src/templateManagement");

test("normalizes a supported text template and safe buttons", () => {
  const value = normalizeTemplateDefinition({
    name: "order_update",
    language: "en_US",
    category: "utility",
    components: [
      { type: "HEADER", format: "TEXT", text: "Order update" },
      { type: "BODY", text: "Hi {{1}}, your order {{2}} is ready.", example: { body_text: [["Asha", "A-100"]] } },
      { type: "FOOTER", text: "Thank you" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "Track order", url: "https://example.com/orders" },
        { type: "PHONE_NUMBER", text: "Call us", phone_number: "+14155552671" }
      ] }
    ],
    allowCategoryChange: true
  });
  assert.equal(value.category, "UTILITY");
  assert.equal(value.name, "order_update");
  assert.equal(value.allow_category_change, true);
  assert.deepEqual(value.components[3].buttons.map(button => button.type), ["URL", "PHONE_NUMBER"]);
});

test("accepts media header handles and rejects missing or malformed handles", () => {
  const components = normalizeTemplateComponents([
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["2:uploaded-media-handle+/="] } },
    { type: "BODY", text: "Your receipt is attached." }
  ]);
  assert.deepEqual(components[0], {
    type: "HEADER", format: "IMAGE", example: { header_handle: ["2:uploaded-media-handle+/="] }
  });
  assert.throws(() => normalizeTemplateComponents([
    { type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Hello" }
  ]), /uploaded Meta header_handle/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["bad\nhandle"] } },
    { type: "BODY", text: "Hello" }
  ]), /invalid characters/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "Hello" }
  ]), /Header format/);
});

test("requires a body and rejects duplicate or unsupported components", () => {
  assert.throws(() => normalizeTemplateComponents([{ type: "FOOTER", text: "Footer" }]), /BODY component/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello" }, { type: "BODY", text: "Again" }
  ]), /duplicate/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello" }, { type: "CAROUSEL", cards: [] }
  ]), /unsupported/);
});

test("rejects unsupported media headers and unsafe button URLs", () => {
  assert.throws(() => normalizeTemplateComponents([
    { type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello" }
  ]), /uploaded Meta header_handle/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "http://example.com" }] }
  ]), /HTTPS/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello {{1}}" }
  ]), /example rows/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello {{1}} and {{2}}", example: { body_text: [["only one"]] } }
  ]), /one sample per placeholder/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://example.com/{{1}}" }] }
  ]), /Dynamic URL/);
});

test("rejects invalid WhatsApp CTA and quick-reply button combinations", () => {
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello" },
    { type: "BUTTONS", buttons: [
      { type: "QUICK_REPLY", text: "Help" },
      { type: "URL", text: "Visit", url: "https://example.com" }
    ] }
  ]), /cannot be mixed/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello" },
    { type: "BUTTONS", buttons: [
      { type: "URL", text: "Visit", url: "https://example.com" },
      { type: "URL", text: "More", url: "https://example.org" }
    ] }
  ]), /one URL and one phone/);
});

test("builds a Meta authentication template with copy-code OTP and optional security settings", () => {
  const value = normalizeAuthenticationTemplateDefinition({
    name: "login_otp", language: "en_US", otpType: "COPY_CODE",
    addSecurityRecommendation: true, codeExpirationMinutes: 10, messageSendTtlSeconds: 300
  });
  assert.deepEqual(value, {
    name: "login_otp", language: "en_US", category: "AUTHENTICATION",
    message_send_ttl_seconds: 300,
    components: [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 10 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] }
    ]
  });
});

test("builds one-tap OTP templates only with valid supported Android app identities", () => {
  const value = normalizeAuthenticationTemplateDefinition({
    name: "login_otp_android", language: "en_US", otpType: "ONE_TAP",
    supportedApps: [
      { packageName: "com.example.joyinbox", signatureHash: "K8a/AINcGX7" },
      { packageName: "com.example.joyinbox.beta", signatureHash: "Abcdef123+/ " .trim() }
    ]
  });
  assert.deepEqual(value.components[1], {
    type: "BUTTONS", buttons: [{
      type: "OTP", otp_type: "ONE_TAP",
      supported_apps: [
        { package_name: "com.example.joyinbox", signature_hash: "K8a/AINcGX7" },
        { package_name: "com.example.joyinbox.beta", signature_hash: "Abcdef123+/" }
      ]
    }]
  });
});

test("rejects invalid OTP modes, expiration, TTL and Android app metadata", () => {
  const base = { name: "login_otp", language: "en_US" };
  assert.throws(() => normalizeAuthenticationTemplateDefinition({ ...base, otpType: "ZERO_TAP" }), /COPY_CODE or ONE_TAP/);
  assert.throws(() => normalizeAuthenticationTemplateDefinition({ ...base, codeExpirationMinutes: 0 }), /1 and 90/);
  assert.throws(() => normalizeAuthenticationTemplateDefinition({ ...base, codeExpirationMinutes: 91 }), /1 and 90/);
  assert.throws(() => normalizeAuthenticationTemplateDefinition({ ...base, messageSendTtlSeconds: 30 }), /60 and 600/);
  assert.throws(() => normalizeAuthenticationTemplateDefinition({ ...base, otpType: "ONE_TAP" }), /1–5 supported Android apps/);
  assert.throws(() => normalizeAuthenticationTemplateDefinition({
    ...base, otpType: "ONE_TAP", supportedApps: [{ packageName: "not a package", signatureHash: "K8a/AINcGX7" }]
  }), /package name/);
  assert.throws(() => normalizeAuthenticationTemplateDefinition({
    ...base, otpType: "ONE_TAP", supportedApps: [{ packageName: "com.example.app", signatureHash: "short" }]
  }), /exactly 11/);
  assert.throws(() => normalizeAuthenticationTemplateDefinition({
    ...base, otpType: "ONE_TAP", supportedApps: [
      { packageName: "com.example.app", signatureHash: "K8a/AINcGX7" },
      { packageName: "com.example.app", signatureHash: "Abcdef123+/" }
    ]
  }), /must be unique/);
});

test("validates OTP codes and builds Meta authentication send components", () => {
  assert.equal(normalizeAuthenticationOtpCode("A1b2C3"), "A1b2C3");
  assert.equal(normalizeAuthenticationOtpCode("7"), "7");
  assert.throws(() => normalizeAuthenticationOtpCode("1234567890123456"), /1–15/);
  assert.throws(() => normalizeAuthenticationOtpCode("12 34"), /1–15/);
  assert.deepEqual(buildAuthenticationTemplateSendComponents("123456"), [
    { type: "body", parameters: [{ type: "text", text: "123456" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] }
  ]);
});

test("validates categories, names, locales, and template mutation identity", () => {
  assert.throws(() => normalizeTemplateDefinition({
    name: "Uppercase_Name", language: "en_US", category: "UTILITY",
    components: [{ type: "BODY", text: "Hello" }]
  }), /lowercase/);
  assert.throws(() => normalizeTemplateDefinition({
    name: "hello", language: "english", category: "UTILITY",
    components: [{ type: "BODY", text: "Hello" }]
  }), /language/);
  assert.throws(() => normalizeTemplateDefinition({
    name: "hello", language: "en_US", category: "UNKNOWN",
    components: [{ type: "BODY", text: "Hello" }]
  }), /category/);
  assert.throws(() => normalizeTemplateDefinition({
    name: "hello", language: "en_US", category: "AUTHENTICATION",
    components: [{ type: "BODY", text: "Hello" }]
  }), /category/);
  assert.deepEqual(normalizeTemplateMutationIdentity({
    templateId: "123456789012345", templateName: "order_update"
  }), { templateId: "123456789012345", templateName: "order_update" });
  assert.throws(() => normalizeTemplateMutationIdentity({
    templateId: "not-an-id", templateName: "order_update"
  }), /templateId/);
});
