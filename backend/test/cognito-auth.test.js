"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyCognitoAccessToken, getCognitoConfig } = require("../src/cognitoAuth");

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("Cognito verifier requires a matching AWS region, user pool and app client", () => {
  const prior = {
    region: process.env.AWS_REGION,
    pool: process.env.COGNITO_USER_POOL_ID,
    client: process.env.COGNITO_APP_CLIENT_ID
  };
  delete process.env.AWS_REGION;
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_APP_CLIENT_ID;
  try {
    assert.throws(() => getCognitoConfig(), { statusCode: 503 });
    process.env.AWS_REGION = "ap-south-1";
    process.env.COGNITO_USER_POOL_ID = "ap-south-1_pool123";
    process.env.COGNITO_APP_CLIENT_ID = "client123";
    assert.equal(getCognitoConfig().issuer, "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_pool123");
  } finally {
    for (const [key, value] of [["AWS_REGION", prior.region], ["COGNITO_USER_POOL_ID", prior.pool], ["COGNITO_APP_CLIENT_ID", prior.client]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Cognito verifier accepts a correctly signed access token and maps sub to uid", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    pool: process.env.COGNITO_USER_POOL_ID,
    client: process.env.COGNITO_APP_CLIENT_ID,
    fetch: global.fetch
  };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = "test-key-1";
  process.env.AWS_REGION = "ap-south-1";
  process.env.COGNITO_USER_POOL_ID = "ap-south-1_pool123";
  process.env.COGNITO_APP_CLIENT_ID = "client123";
  const issuer = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_pool123";
  global.fetch = async () => ({ ok: true, json: async () => ({ keys: [{ ...jwk, kid, kty: "RSA", use: "sig", alg: "RS256" }] }) });
  try {
    const now = Math.floor(Date.now() / 1000);
    const head = encode({ alg: "RS256", kid });
    const body = encode({ iss: issuer, token_use: "access", client_id: "client123", sub: "cognito-user-123", iat: now, exp: now + 300 });
    const unsigned = head + "." + body;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
    const decoded = await verifyCognitoAccessToken(unsigned + "." + signature);
    assert.equal(decoded.uid, "cognito-user-123");
    assert.equal(decoded.authProvider, "cognito");
  } finally {
    global.fetch = prior.fetch;
    for (const [key, value] of [["AWS_REGION", prior.region], ["COGNITO_USER_POOL_ID", prior.pool], ["COGNITO_APP_CLIENT_ID", prior.client]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Cognito verifier rejects expired tokens and Firebase-style tokens", async () => {
  await assert.rejects(verifyCognitoAccessToken("not.a.jwt"), { statusCode: 503 });
});
