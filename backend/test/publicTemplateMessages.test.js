"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTemplateConsent, countTemplatePlaceholders, buildPublicTemplateComponents, buildPublicTemplateListUrl } = require("../src/publicTemplateMessages");

const approved = {
  status: "APPROVED",
  components: [
    { type: "HEADER", format: "TEXT", text: "Hello {{1}}" },
    { type: "BODY", text: "Your order {{1}} is ready for {{2}}." },
    { type: "BUTTONS", buttons: [
      { type: "URL", url: "https://example.com/orders/{{1}}", text: "Track" },
      { type: "QUICK_REPLY", text: "Help" }
    ] }
  ]
};

test("counts numbered template placeholders using the highest index", () => {
  assert.equal(countTemplatePlaceholders("{{1}} and {{3}}"), 3);
  assert.equal(countTemplatePlaceholders("No variables"), 0);
});

test("builds approved public template body, header and URL button components", () => {
  const components = buildPublicTemplateComponents(approved, {
    headerVariables: ["Customer"],
    variables: ["A-100", "today"],
    buttonVariables: ["A-100"]
  });
  assert.deepEqual(components, [
    { type: "header", parameters: [{ type: "text", text: "Customer" }] },
    { type: "body", parameters: [{ type: "text", text: "A-100" }, { type: "text", text: "today" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "A-100" }] }
  ]);
});

test("rejects unapproved templates and mismatched variable counts", () => {
  assert.throws(() => buildPublicTemplateComponents({ ...approved, status: "PENDING" }), { statusCode: 400 });
  assert.throws(() => buildPublicTemplateComponents(approved, { variables: ["one"] }), /do not match/);
  assert.throws(() => buildPublicTemplateComponents(approved, { variables: ["one", "two"], headerVariables: ["header"], buttonVariables: ["x", "y"] }), /do not match/);
});

test("rejects media-header templates in the text-template endpoint", () => {
  assert.throws(() => buildPublicTemplateComponents({
    status: "APPROVED",
    components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello" }]
  }), /Media-header/);
});

test("rejects malformed template variable values", () => {
  assert.throws(() => buildPublicTemplateComponents(approved, { variables: [""] }), /non-empty strings/);
  assert.throws(() => buildPublicTemplateComponents(approved, { variables: ["x".repeat(1025), "ok"] }), /non-empty strings/);
});


test("builds authentication OTP body and button parameters for public template sends", () => {
  const authTemplate = {
    status: "APPROVED", category: "AUTHENTICATION",
    components: [
      { type: "BODY", text: "{{1}} is your verification code." },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] }
    ]
  };
  assert.deepEqual(buildPublicTemplateComponents(authTemplate, {
    variables: ["123456"], buttonVariables: ["123456"]
  }), [
    { type: "body", parameters: [{ type: "text", text: "123456" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] }
  ]);
  assert.throws(() => buildPublicTemplateComponents(authTemplate, {
    variables: ["123456"], buttonVariables: ["654321"]
  }), /matching OTP/);
  assert.throws(() => buildPublicTemplateComponents(authTemplate, {
    variables: ["12 34"], buttonVariables: ["12 34"]
  }), /4–15/);
});

test("requires and normalizes explicit past template opt-in evidence", () => {
  const now = Date.parse("2026-11-25T08:00:00.000Z");
  assert.deepEqual(normalizeTemplateConsent({
    optedIn: true, consentAt: "2026-11-24T10:00:00.000Z", consentSource: "Website checkout"
  }, now), {
    optedIn: true, consentAt: "2026-11-24T10:00:00.000Z", consentSource: "Website checkout"
  });
  assert.throws(() => normalizeTemplateConsent({
    optedIn: false, consentAt: "2026-11-24T10:00:00.000Z", consentSource: "Website"
  }, now), { statusCode: 400 });
  assert.throws(() => normalizeTemplateConsent({
    optedIn: true, consentAt: "2026-11-26T10:00:00.000Z", consentSource: "Website"
  }, now), { statusCode: 400 });
  assert.throws(() => normalizeTemplateConsent({
    optedIn: true, consentAt: "not-a-date", consentSource: "Website"
  }, now), { statusCode: 400 });
  assert.throws(() => normalizeTemplateConsent({
    optedIn: true, consentAt: "2026-11-24T10:00:00.000Z", consentSource: "x"
  }, now), { statusCode: 400 });
});


test("builds a Meta template URL with limit and forwards the after cursor", () => {
  const url = buildPublicTemplateListUrl({
    version: "v26.0",
    wabaId: "123456789012345",
    connectedWabaId: "123456789012345",
    limit: 40,
    cursor: "opaque_cursor-123="
  });
  assert.equal(url.pathname, "/v26.0/123456789012345/message_templates");
  assert.equal(url.searchParams.get("limit"), "40");
  assert.equal(url.searchParams.get("after"), "opaque_cursor-123=");
  assert.equal(url.searchParams.get("fields"), "id,name,status,language,category,components");
});

test("rejects a WABA ID that does not belong to the connected phone number", () => {
  assert.throws(() => buildPublicTemplateListUrl({
    version: "v26.0", wabaId: "123456789012345",
    connectedWabaId: "999999999999999", limit: 100
  }), { statusCode: 403 });
});

test("validates public template pagination bounds and cursor controls", () => {
  const base = { version: "v26.0", wabaId: "123456789012345", connectedWabaId: "123456789012345" };
  assert.throws(() => buildPublicTemplateListUrl({ ...base, limit: 0 }), { statusCode: 400 });
  assert.throws(() => buildPublicTemplateListUrl({ ...base, limit: 101 }), { statusCode: 400 });
  assert.throws(() => buildPublicTemplateListUrl({ ...base, limit: 10, cursor: "bad" + String.fromCharCode(10) + "cursor" }), { statusCode: 400 });
  assert.throws(() => buildPublicTemplateListUrl({ ...base, limit: 10, cursor: "x".repeat(2049) }), { statusCode: 400 });
});
