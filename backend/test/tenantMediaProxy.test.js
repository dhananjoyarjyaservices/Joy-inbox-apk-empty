const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchWhatsAppMediaForProxy } = require("../src/media");

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => body,
    arrayBuffer: async () => Buffer.from(body)
  };
}

test("tenant media proxy fetches supported media from an approved Meta host", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const image = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return response({ url: "https://lookaside.fbsbx.com/media/opaque", mime_type: "image/jpeg", file_size: image.length, filename: "photo.jpg" });
    }
    return {
      ok: true,
      headers: { get: () => String(image.length) },
      arrayBuffer: async () => image
    };
  };
  const result = await fetchWhatsAppMediaForProxy("meta-media-123", { accessToken: "secret-token" });
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.filename, "photo.jpg");
  assert.deepEqual(result.buffer, image);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[1].options.redirect, "error");
});

test("tenant media proxy rejects untrusted Meta media URLs before downloading", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return response({ url: "https://attacker.example/file", mime_type: "image/jpeg", file_size: 3 });
  };
  await assert.rejects(
    fetchWhatsAppMediaForProxy("meta-media-123", { accessToken: "secret-token" }),
    /untrusted media URL/
  );
  assert.equal(calls, 1);
});

test("tenant media proxy rejects media larger than its response limit", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => response({
    url: "https://lookaside.fbsbx.com/media/opaque",
    mime_type: "image/jpeg",
    file_size: 5 * 1024 * 1024
  });
  await assert.rejects(
    fetchWhatsAppMediaForProxy("meta-media-123", { accessToken: "secret-token" }),
    (error) => error.statusCode === 413
  );
});
