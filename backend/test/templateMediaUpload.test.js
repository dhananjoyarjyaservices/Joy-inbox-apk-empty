"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { uploadWhatsAppTemplateMedia } = require("../src/media");

function jsonResponse(payload, ok = true) {
  return { ok, json: async () => payload };
}

test("uploads a validated template header through Meta resumable upload", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return jsonResponse({ id: "upload:123456789" });
    return jsonResponse({ h: "2:uploaded-handle" });
  };
  try {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await uploadWhatsAppTemplateMedia(buffer, "image/jpeg", "../header image.jpg",
      { accessToken: "test-access-token" }, "123456789012345");
    assert.equal(result.handle, "2:uploaded-handle");
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.filename, "header_image.jpg");
    assert.equal(calls.length, 2);
    const start = new URL(calls[0].url);
    assert.equal(start.pathname, "/v26.0/123456789012345/uploads");
    assert.equal(start.searchParams.get("file_length"), String(buffer.length));
    assert.equal(start.searchParams.get("file_type"), "image/jpeg");
    assert.equal(start.searchParams.get("access_token"), "test-access-token");
    assert.equal(calls[1].options.headers.Authorization, "OAuth test-access-token");
    assert.equal(calls[1].options.headers.file_offset, "0");
    assert.deepEqual(calls[1].options.body, buffer);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects unsupported, invalid or oversized template media before network calls", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return jsonResponse({}); };
  try {
    await assert.rejects(
      uploadWhatsAppTemplateMedia(Buffer.from("plain text"), "text/plain", "file.txt",
        { accessToken: "token" }, "123456789012345"),
      /content does not match|support JPEG/
    );
    await assert.rejects(
      uploadWhatsAppTemplateMedia(Buffer.alloc(3 * 1024 * 1024 + 1, 0), "image/jpeg", "large.jpg",
        { accessToken: "token" }, "123456789012345"),
      /3 MB/
    );
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects failed Meta upload sessions and missing file handles", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => jsonResponse({ error: { message: "No permission" } }, false);
    await assert.rejects(
      uploadWhatsAppTemplateMedia(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg", "header.jpg",
        { accessToken: "token" }, "123456789012345"),
      /No permission/
    );
    global.fetch = async () => jsonResponse({ id: "upload:123" });
    await assert.rejects(
      uploadWhatsAppTemplateMedia(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg", "header.jpg",
        { accessToken: "token" }, "123456789012345"),
      /finish the template media upload/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
