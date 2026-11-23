"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeInteractiveMessage,
  buildWhatsAppInteractivePayload,
  getInteractivePreview
} = require("../src/tenantInteractive");

test("normalizes WhatsApp reply-button interactive messages", () => {
  const payload = buildWhatsAppInteractivePayload("919876543210", {
    type: "button",
    header: "Order update",
    body: "How can we help?",
    footer: "Joy Inbox",
    buttons: [{ title: "Track order" }, { id: "support", title: "Contact support" }]
  });
  assert.equal(payload.type, "interactive");
  assert.equal(payload.to, "919876543210");
  assert.equal(payload.interactive.type, "button");
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: "option_1", title: "Track order" } },
    { type: "reply", reply: { id: "support", title: "Contact support" } }
  ]);
});

test("normalizes WhatsApp list sections with up to ten total rows", () => {
  const message = normalizeInteractiveMessage({
    type: "list",
    body: "Choose a service",
    buttonTitle: "View options",
    sections: [
      { title: "Services", rows: [{ id: "one", title: "First", description: "First option" }, { id: "two", title: "Second" }] },
      { title: "More", rows: [{ id: "three", title: "Third" }] }
    ]
  });
  assert.equal(message.sections.length, 2);
  assert.equal(message.sections.reduce((n, section) => n + section.rows.length, 0), 3);
  const payload = buildWhatsAppInteractivePayload("919876543210", message);
  assert.equal(payload.interactive.action.button, "View options");
  assert.equal(payload.interactive.action.sections[0].rows[0].id, "one");
});

test("rejects invalid button and list limits and duplicate IDs", () => {
  assert.throws(() => normalizeInteractiveMessage({ type: "button", body: "Choose", buttons: [] }), /one to three/);
  assert.throws(() => normalizeInteractiveMessage({
    type: "button", body: "Choose",
    buttons: [{ id: "same", title: "One" }, { id: "same", title: "Two" }]
  }), /IDs must be unique/);
  assert.throws(() => normalizeInteractiveMessage({
    type: "list", body: "Choose", buttonTitle: "Open",
    sections: [{ title: "Options", rows: Array.from({ length: 11 }, (_, index) => ({ id: String(index), title: "Row " + index })) }]
  }), /up to ten rows/);
});

test("rejects overlong button, list and body text", () => {
  assert.throws(() => normalizeInteractiveMessage({
    type: "button", body: "x".repeat(1025), buttons: [{ title: "One" }]
  }), /Message body/);
  assert.throws(() => normalizeInteractiveMessage({
    type: "button", body: "Choose", buttons: [{ title: "x".repeat(21) }]
  }), /Button title/);
  assert.throws(() => normalizeInteractiveMessage({
    type: "list", body: "Choose", buttonTitle: "Open",
    sections: [{ title: "Options", rows: [{ title: "x".repeat(25) }] }]
  }), /List row title/);
});

test("creates a bounded internal preview for the inbox history", () => {
  const preview = getInteractivePreview({
    type: "button", body: "Pick an option", buttons: [{}, {}]
  });
  assert.equal(preview, "Interactive button message · 2 option(s): Pick an option");
});
