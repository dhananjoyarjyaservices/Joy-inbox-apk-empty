"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTemplateComponents,
  normalizeTemplateDefinition,
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
        { type: "URL", text: "Track order", url: "https://example.com/orders/{{1}}" },
        { type: "QUICK_REPLY", text: "Need help" }
      ] }
    ],
    allowCategoryChange: true
  });
  assert.equal(value.category, "UTILITY");
  assert.equal(value.name, "order_update");
  assert.equal(value.allow_category_change, true);
  assert.deepEqual(value.components[3].buttons.map(button => button.type), ["URL", "QUICK_REPLY"]);
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
  ]), /Only text headers/);
  assert.throws(() => normalizeTemplateComponents([
    { type: "BODY", text: "Hello" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "http://example.com" }] }
  ]), /HTTPS/);
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
  assert.deepEqual(normalizeTemplateMutationIdentity({
    templateId: "123456789012345", templateName: "order_update"
  }), { templateId: "123456789012345", templateName: "order_update" });
  assert.throws(() => normalizeTemplateMutationIdentity({
    templateId: "not-an-id", templateName: "order_update"
  }), /templateId/);
});
