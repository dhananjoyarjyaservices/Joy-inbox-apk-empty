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

test("legacy owner API is disabled by default with a clear migration response", async () => {
  await withLegacyFlag(undefined, async () => {
    const response = await handler(request("POST", "/send"));
    assert.equal(response.statusCode, 410);
    assert.match(response.body, /legacy endpoint is disabled/i);
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
