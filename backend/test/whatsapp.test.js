const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCredentials, sendWhatsAppText } = require("../src/whatsapp");

test("uses explicitly supplied tenant credentials instead of global environment", () => {
  process.env.WHATSAPP_ACCESS_TOKEN = "EAA-global-token";
  process.env.PHONE_NUMBER_ID = "999999999999999";
  const resolved = resolveCredentials({
    accessToken: "EAA-tenant-token",
    phoneNumberId: "123456789012345"
  });
  assert.deepEqual(resolved, {
    accessToken: "EAA-tenant-token",
    phoneNumberId: "123456789012345"
  });
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.PHONE_NUMBER_ID;
});

test("retains legacy environment credential fallback for existing owner routes", () => {
  process.env.WHATSAPP_ACCESS_TOKEN = "EAA-legacy-token";
  process.env.PHONE_NUMBER_ID = "123456789012345";
  assert.deepEqual(resolveCredentials(), {
    accessToken: "EAA-legacy-token",
    phoneNumberId: "123456789012345"
  });
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.PHONE_NUMBER_ID;
});

test("tenant credential send uses the supplied phone number ID and bearer token", async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const originalPhone = process.env.PHONE_NUMBER_ID;
  let requestedUrl = "";
  let authorization = "";
  global.fetch = async (url, options) => {
    requestedUrl = String(url);
    authorization = options.headers.Authorization;
    return {
      ok: true,
      async json() { return { messages: [{ id: "wamid.tenant-test" }] }; }
    };
  };
  process.env.WHATSAPP_ACCESS_TOKEN = "EAA-global-token";
  process.env.PHONE_NUMBER_ID = "999999999999999";
  try {
    const result = await sendWhatsAppText(
      "+15551234567",
      "Tenant message",
      undefined,
      { accessToken: "EAA-tenant-token", phoneNumberId: "123456789012345" }
    );
    assert.equal(result.messageId, "wamid.tenant-test");
    assert.match(requestedUrl, /123456789012345\/messages$/);
    assert.equal(authorization, "Bearer EAA-tenant-token");
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
    if (originalPhone === undefined) delete process.env.PHONE_NUMBER_ID;
    else process.env.PHONE_NUMBER_ID = originalPhone;
  }
});
