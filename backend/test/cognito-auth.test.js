"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyCognitoAccessToken, clearJwksCacheForTests } = require("../src/aws/cognitoAuth");

const region = "ap-south-1";
const userPoolId = `${region}_examplePool`;
const clientId = "exampleAppClient";
const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
const config = { region, userPoolId, clientId, issuer, jwksUrl: `${issuer}/.well-known/jwks.json` };
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", kty: "RSA", use: "sig", alg: "RS256" };

function base64url(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function token(overrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: "test-key", ...headerOverrides };
  const claims = {
    iss: issuer,
    sub: "cognito-user-123",
    client_id: clientId,
    token_use: "access",
    scope: "openid",
    iat: now,
    exp: now + 300,
    username: "customer",
    ...overrides
  };
  const input = `${base64url(header)}.${base64url(claims)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}
function fetchJwks() {
  return async (url) => {
    assert.equal(url, config.jwksUrl);
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
}

test("verifies Cognito RS256 access tokens and maps sub to uid", async () => {
  clearJwksCacheForTests();
  const result = await verifyCognitoAccessToken(token({ email: "user@example.com" }), { config, fetch: fetchJwks() });
  assert.equal(result.uid, "cognito-user-123");
  assert.equal(result.sub, "cognito-user-123");
  assert.equal(result.email, "user@example.com");
  assert.equal(result.authProvider, "cognito");
});

test("rejects an invalid signature", async () => {
  clearJwksCacheForTests();
  const valid = token();
  const parts = valid.split(".");
  const bad = `${parts[0]}.${parts[1]}.${Buffer.from("not-a-signature").toString("base64url")}`;
  await assert.rejects(() => verifyCognitoAccessToken(bad, { config, fetch: fetchJwks() }), { statusCode: 401 });
});

test("rejects wrong issuer, client ID, token use and expired tokens", async () => {
  clearJwksCacheForTests();
  for (const claims of [
    { iss: "https://attacker.example" },
    { client_id: "another-client" },
    { token_use: "id" },
    { exp: Math.floor(Date.now() / 1000) - 1 }
  ]) {
    await assert.rejects(() => verifyCognitoAccessToken(token(claims), { config, fetch: fetchJwks() }), { statusCode: 401 });
  }
});

test("rejects unknown signing key IDs and malformed tokens", async () => {
  clearJwksCacheForTests();
  await assert.rejects(() => verifyCognitoAccessToken(token({}, { kid: "unknown" }), { config, fetch: fetchJwks() }), { statusCode: 401 });
  await assert.rejects(() => verifyCognitoAccessToken("not.a.jwt.extra", { config, fetch: fetchJwks() }), { statusCode: 401 });
});

test("requires explicit Cognito pool and app client configuration", async () => {
  await assert.rejects(() => verifyCognitoAccessToken("a.b.c", { env: {} }), /must be configured/);
});
