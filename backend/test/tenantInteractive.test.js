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

test("builds secure CTA URL messages for payment and catalog links", () => {
  const payload = buildWhatsAppInteractivePayload("919876543210", {
    type: "cta_url",
    body: "Complete your payment securely.",
    displayText: "Pay now",
    url: "https://payments.example.com/order/123"
  });
  assert.equal(payload.interactive.type, "cta_url");
  assert.deepEqual(payload.interactive.action, {
    name: "cta_url",
    parameters: {
      display_text: "Pay now",
      url: "https://payments.example.com/order/123"
    }
  });
  assert.match(getInteractivePreview({
    type: "cta_url", body: "Complete your payment", displayText: "Pay", url: "https://payments.example.com"
  }), /1 option/);
});

test("CTA URL messages reject insecure URLs and invalid button labels", () => {
  assert.throws(() => normalizeInteractiveMessage({
    type: "cta_url", body: "Pay", displayText: "Pay now", url: "http://payments.example.com"
  }), /HTTPS/);
  assert.throws(() => normalizeInteractiveMessage({
    type: "cta_url", body: "Pay", displayText: "x".repeat(21), url: "https://payments.example.com"
  }), /Link button text/);
});

test("builds media carousel messages with two to ten HTTPS image cards and URL actions", () => {
  const message = {
    type: "carousel",
    body: "Explore our latest offers",
    cards: [
      { imageUrl: "https://cdn.example.com/one.jpg", body: "First offer", displayText: "View offer", url: "https://shop.example.com/one" },
      { imageUrl: "https://cdn.example.com/two.jpg", body: "Second offer", displayText: "Shop now", url: "https://shop.example.com/two" }
    ]
  };
  const normalized = normalizeInteractiveMessage(message);
  const payload = buildWhatsAppInteractivePayload("919876543210", normalized);
  assert.equal(payload.interactive.type, "carousel");
  assert.equal(payload.interactive.action.cards.length, 2);
  assert.deepEqual(payload.interactive.action.cards[0], {
    card_index: 0,
    type: "cta_url",
    header: { type: "image", image: { link: "https://cdn.example.com/one.jpg" } },
    body: { text: "First offer" },
    action: { name: "cta_url", parameters: { display_text: "View offer", url: "https://shop.example.com/one" } }
  });
  assert.match(getInteractivePreview(normalized), /2 option/);
});

test("rejects carousel counts, unsupported headers and unsafe card URLs", () => {
  const card = { imageUrl: "https://cdn.example.com/one.jpg", body: "Offer", displayText: "View", url: "https://shop.example.com" };
  assert.throws(() => normalizeInteractiveMessage({ type: "carousel", body: "Offers", cards: [card] }), /two to ten/);
  assert.throws(() => normalizeInteractiveMessage({ type: "carousel", body: "Offers", header: "Header", cards: [card, card] }), /do not support/);
  assert.throws(() => normalizeInteractiveMessage({ type: "carousel", body: "Offers", cards: [{ ...card, imageUrl: "http://cdn.example.com/one.jpg" }, card] }), /image URL must use HTTPS/);
  assert.throws(() => normalizeInteractiveMessage({ type: "carousel", body: "Offers", cards: [{ ...card, url: "javascript:alert(1)" }, card] }), /button URL must use HTTPS/);
  assert.throws(() => normalizeInteractiveMessage({ type: "carousel", body: "Offers", cards: [{ ...card, body: "x".repeat(161) }, card] }), /160 characters/);
});
