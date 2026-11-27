import assert from "node:assert/strict";
import { test } from "node:test";
import { getWhatsAppContactUrl } from "../src/utils/whatsapp.ts";

test("builds a WhatsApp contact URL from an international phone number", () => {
  assert.equal(getWhatsAppContactUrl("+91 98765-43210"), "https://wa.me/919876543210");
});

test("rejects values that are not valid international-length phone numbers", () => {
  assert.equal(getWhatsAppContactUrl("12345"), null);
  assert.equal(getWhatsAppContactUrl("customer-abc"), null);
  assert.equal(getWhatsAppContactUrl(""), null);
});
