const test = require("node:test");
const assert = require("node:assert/strict");
const { handler } = require("../src/index");

async function withLegacyFlag(value, callback) {
  const previous = process.env.LEGACY_OWNER_API_ENABLED;
  if (value === undefined) delete process.env.LEGACY_OWNER_API_ENABLED;
  else process.env.LEGACY_OWNER_API_ENABLED = value;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.LEGACY_OWNER_API_ENABLED;
    else process.env.LEGACY_OWNER_API_ENABLED = previous;
  }
}

function request(method, path) {
  return { httpMethod: method, path, headers: {} };
}

test("every legacy owner API route is disabled by default", async () => {
  const routes = [
    ["POST", "/send"],
    ["POST", "/chat-state"],
    ["POST", "/message-state"],
    ["POST", "/delete-messages"],
    ["POST", "/delete-chats"],
    ["POST", "/send-media"],
    ["GET", "/media"],
    ["GET", "/status"],
    ["GET", "/greeting-settings"],
    ["POST", "/greeting-settings"],
    ["POST", "/fcm-tokens/register"],
    ["POST", "/fcm-tokens/remove"]
  ];

  await withLegacyFlag(undefined, async () => {
    for (const [method, path] of routes) {
      const response = await handler(request(method, path));
      assert.equal(response.statusCode, 410, `${method} ${path} must be disabled`);
      assert.match(response.body, /legacy endpoint is disabled/i);
    }
  });
});

test("every legacy owner API route still requires the verified owner when migration opt-in is enabled", async () => {
  const routes = [
    ["POST", "/send"],
    ["POST", "/chat-state"],
    ["POST", "/message-state"],
    ["POST", "/delete-messages"],
    ["POST", "/delete-chats"],
    ["POST", "/send-media"],
    ["GET", "/media"],
    ["GET", "/status"],
    ["GET", "/greeting-settings"],
    ["POST", "/greeting-settings"],
    ["POST", "/fcm-tokens/register"],
    ["POST", "/fcm-tokens/remove"]
  ];

  await withLegacyFlag("true", async () => {
    for (const [method, path] of routes) {
      const response = await handler(request(method, path));
      assert.equal(response.statusCode, 401, `${method} ${path} must still authenticate the owner`);
      assert.match(response.body, /authentication required/i);
    }
  });
});

test("legacy owner API can only be enabled through the explicit migration flag", async () => {
  await withLegacyFlag("true", async () => {
    const response = await handler(request("POST", "/send"));
    // The route passes the legacy kill switch and then requires a valid owner token.
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /authentication required/i);
  });
});

test("organization-scoped APIs are not blocked by the legacy owner API switch", async () => {
  await withLegacyFlag(undefined, async () => {
    const response = await handler(request("GET", "/organizations/status"));
    // Tenant routes continue to their Firebase authentication and membership checks.
    assert.equal(response.statusCode, 401);
    assert.doesNotMatch(response.body, /legacy endpoint is disabled/i);
  });
});
