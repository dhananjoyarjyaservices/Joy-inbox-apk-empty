"use strict";

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanText(value, field, maxLength, required = true) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw httpError(`${field} is required.`);
  if (text.length > maxLength) throw httpError(`${field} must be ${maxLength} characters or fewer.`);
  return text;
}

function normalizeInteractiveMessage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError("Interactive message details are required.");
  }
  const type = input.type;
  if (!["button", "list", "cta_url", "carousel"].includes(type)) throw httpError("Interactive message type must be button, list, cta_url or carousel.");
  const body = cleanText(input.body, "Message body", 1024);
  const header = cleanText(input.header, "Header", 60, false);
  const footer = cleanText(input.footer, "Footer", 60, false);
  const normalized = { type, body, ...(header ? { header } : {}), ...(footer ? { footer } : {}) };

  if (type === "carousel") {
    if (header || footer) throw httpError("Carousel messages use card media and do not support a message header or footer.");
    if (!Array.isArray(input.cards) || input.cards.length < 2 || input.cards.length > 10) {
      throw httpError("Carousel messages require two to ten cards.");
    }
    normalized.cards = input.cards.map((card, index) => {
      const imageUrl = cleanText(card?.imageUrl, `Card ${index + 1} image URL`, 2000);
      let parsedImage;
      try { parsedImage = new URL(imageUrl); } catch { throw httpError(`Card ${index + 1} requires a valid HTTPS image URL.`); }
      if (parsedImage.protocol !== "https:" || parsedImage.username || parsedImage.password) {
        throw httpError(`Card ${index + 1} image URL must use HTTPS and cannot contain credentials.`);
      }
      const cardBody = cleanText(card?.body, `Card ${index + 1} text`, 160);
      const displayText = cleanText(card?.displayText, `Card ${index + 1} button text`, 20);
      const url = cleanText(card?.url, `Card ${index + 1} button URL`, 2000);
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch { throw httpError(`Card ${index + 1} requires a valid HTTPS button URL.`); }
      if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
        throw httpError(`Card ${index + 1} button URL must use HTTPS and cannot contain credentials.`);
      }
      return { imageUrl: parsedImage.toString(), body: cardBody, displayText, url: parsedUrl.toString() };
    });
    return normalized;
  }

  if (type === "cta_url") {
    normalized.displayText = cleanText(input.displayText, "Link button text", 20);
    const url = cleanText(input.url, "HTTPS link", 2000);
    let parsed;
    try { parsed = new URL(url); } catch { throw httpError("A valid HTTPS link is required."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw httpError("Interactive payment/catalog links must use HTTPS and cannot contain credentials.");
    }
    normalized.url = parsed.toString();
    return normalized;
  }

  if (type === "button") {
    if (!Array.isArray(input.buttons) || input.buttons.length < 1 || input.buttons.length > 3) {
      throw httpError("Button messages require one to three reply buttons.");
    }
    const ids = new Set();
    normalized.buttons = input.buttons.map((button, index) => {
      const id = cleanText(button?.id || `option_${index + 1}`, "Button ID", 256);
      const title = cleanText(button?.title, "Button title", 20);
      if (ids.has(id)) throw httpError("Interactive button IDs must be unique.");
      ids.add(id);
      return { id, title };
    });
    return normalized;
  }

  normalized.buttonTitle = cleanText(input.buttonTitle, "List action button", 20);
  if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 10) {
    throw httpError("List messages require one to ten sections.");
  }
  const ids = new Set();
  let rowCount = 0;
  normalized.sections = input.sections.map((section, sectionIndex) => {
    const title = cleanText(section?.title || `Options ${sectionIndex + 1}`, "Section title", 24);
    if (!Array.isArray(section.rows) || section.rows.length < 1) {
      throw httpError("Every list section must contain at least one row.");
    }
    const rows = section.rows.map((row, rowIndex) => {
      rowCount += 1;
      if (rowCount > 10) throw httpError("WhatsApp list messages support up to ten rows in total.");
      const id = cleanText(row?.id || `option_${rowCount}`, "List row ID", 200);
      const rowTitle = cleanText(row?.title, "List row title", 24);
      const description = cleanText(row?.description, "List row description", 72, false);
      if (ids.has(id)) throw httpError("List row IDs must be unique.");
      ids.add(id);
      return { id, title: rowTitle, ...(description ? { description } : {}) };
    });
    return { title, rows };
  });
  return normalized;
}

function buildWhatsAppInteractivePayload(to, input) {
  const message = normalizeInteractiveMessage(input);
  const interactive = {
    type: message.type,
    body: { text: message.body }
  };
  if (message.header) interactive.header = { type: "text", text: message.header };
  if (message.footer) interactive.footer = { text: message.footer };
  if (message.type === "carousel") {
    interactive.action = {
      cards: message.cards.map((card, cardIndex) => ({
        card_index: cardIndex,
        type: "cta_url",
        header: { type: "image", image: { link: card.imageUrl } },
        body: { text: card.body },
        action: { name: "cta_url", parameters: { display_text: card.displayText, url: card.url } }
      }))
    };
  } else if (message.type === "cta_url") {
    interactive.action = {
      name: "cta_url",
      parameters: { display_text: message.displayText, url: message.url }
    };
  } else if (message.type === "button") {
    interactive.action = {
      buttons: message.buttons.map(button => ({
        type: "reply",
        reply: { id: button.id, title: button.title }
      }))
    };
  } else {
    interactive.action = {
      button: message.buttonTitle,
      sections: message.sections
    };
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive
  };
}

function getInteractivePreview(message) {
  const count = message.type === "carousel" ? message.cards.length : message.type === "cta_url" ? 1 : message.type === "button"
    ? message.buttons.length
    : message.sections.reduce((total, section) => total + section.rows.length, 0);
  return `Interactive ${message.type} message · ${count} option(s): ${message.body}`.slice(0, 1024);
}

module.exports = {
  normalizeInteractiveMessage,
  buildWhatsAppInteractivePayload,
  getInteractivePreview
};
