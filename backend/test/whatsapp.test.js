const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCredentials, sendWhatsAppText, sendWhatsAppInteractive, isDefinitiveWhatsAppSendRejection } = require("../src/whatsapp");

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


test("Meta 5xx send response is uncertain and must not be automatically retried", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    async json() { return { error: { message: "Service temporarily unavailable" } }; }
  });
  try {
    await assert.rejects(
      sendWhatsAppText("15551234567", "Hello", undefined, {
        accessToken: "EAA-test-token",
        phoneNumberId: "123456789012345"
      }),
      (error) => error.definitive === false && error.retryable === false
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("Meta 4xx send response is a definitive rejection", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    async json() { return { error: { message: "Invalid recipient" } }; }
  });
  try {
    await assert.rejects(
      sendWhatsAppText("15551234567", "Hello", undefined, {
        accessToken: "EAA-test-token",
        phoneNumberId: "123456789012345"
      }),
      (error) => error.definitive === true && error.retryable === false
    );
  } finally {
    global.fetch = originalFetch;
  }
});


test("Meta request timeout response is uncertain and must not be automatically retried", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 408,
    async json() { return { error: { message: "Request timed out" } }; }
  });
  try {
    await assert.rejects(
      sendWhatsAppText("15551234567", "Hello", undefined, {
        accessToken: "EAA-test-token",
        phoneNumberId: "123456789012345"
      }),
      (error) => error.definitive === false && error.retryable === false
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("Meta rate-limit response is a definitive rejection", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    async json() { return { error: { message: "Rate limit reached" } }; }
  });
  try {
    await assert.rejects(
      sendWhatsAppText("15551234567", "Hello", undefined, {
        accessToken: "EAA-test-token",
        phoneNumberId: "123456789012345"
      }),
      (error) => error.definitive === true && error.retryable === true
    );
  } finally {
    global.fetch = originalFetch;
  }
});


test("Meta send rejection classification treats timeouts and server errors as ambiguous", () => {
  for (const status of [408, 500, 502, 503, 504, 599]) {
    assert.equal(isDefinitiveWhatsAppSendRejection(status), false, String(status));
  }
});

test("Meta send rejection classification treats explicit 4xx errors as definitive", () => {
  for (const status of [400, 401, 403, 404, 429]) {
    assert.equal(isDefinitiveWhatsAppSendRejection(status), true, String(status));
  }
  assert.equal(isDefinitiveWhatsAppSendRejection(200), false);
  assert.equal(isDefinitiveWhatsAppSendRejection("400"), false);
});


test("interactive sends use workspace credentials and return Meta message IDs", async () => {
  const originalFetch = global.fetch;
  let requestUrl = "";
  let requestBody;
  let authorization = "";
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    authorization = options.headers.Authorization;
    return { ok: true, async json() { return { messages: [{ id: "wamid.interactive-test" }] }; } };
  };
  try {
    const payload = {
      messaging_product: "whatsapp", recipient_type: "individual",
      to: "15551234567", type: "interactive",
      interactive: { type: "button", body: { text: "Choose" }, action: { buttons: [{ type: "reply", reply: { id: "yes", title: "Yes" } }] } }
    };
    const result = await sendWhatsAppInteractive(payload, {
      accessToken: "EAA-tenant-token", phoneNumberId: "123456789012345"
    });
    assert.equal(result.messageId, "wamid.interactive-test");
    assert.match(requestUrl, /123456789012345\\/messages$/);
    assert.equal(authorization, "Bearer EAA-tenant-token");
    assert.deepEqual(requestBody, payload);
  } finally { global.fetch = originalFetch; }
});

test("interactive send treats Meta 5xx as ambiguous", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false, status: 503,
    async json() { return { error: { message: "Temporary failure" } }; }
  });
  try {
    await assert.rejects(
      sendWhatsAppInteractive({ to: "15551234567", type: "interactive" }, {
        accessToken: "EAA-test-token", phoneNumberId: "123456789012345"
      }),
      error => error.definitive === false && error.retryable === false
    );
  } finally { global.fetch = originalFetch; }
});
