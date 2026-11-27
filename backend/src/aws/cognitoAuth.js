"use strict";

const crypto = require("node:crypto");

const JWKS_CACHE = new Map();
const MAX_CLOCK_SKEW_SECONDS = 60;

function unauthorized() {
  const error = new Error("Cognito access token is invalid or expired.");
  error.statusCode = 401;
  return error;
}

function decodeSegment(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) throw unauthorized();
  try {
    const value = Buffer.from(segment, "base64url").toString("utf8");
    return JSON.parse(value);
  } catch {
    throw unauthorized();
  }
}

function getConfig(env = process.env) {
  const region = env.COGNITO_REGION || env.AWS_REGION;
  const userPoolId = env.COGNITO_USER_POOL_ID;
  const clientId = env.COGNITO_CLIENT_ID;
  if (!region || !userPoolId || !clientId ||
      !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) ||
      !userPoolId.startsWith(`${region}_`)) {
    throw new Error("Cognito region, user pool ID and app client ID must be configured.");
  }
  return {
    region,
    userPoolId,
    clientId,
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    jwksUrl: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`
  };
}

async function loadJwks(config, fetchImpl = globalThis.fetch, now = Date.now()) {
  const cached = JWKS_CACHE.get(config.issuer);
  if (cached && cached.expiresAt > now) return cached.keys;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required to verify Cognito tokens.");
  const response = await fetchImpl(config.jwksUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw unauthorized();
  const body = await response.json();
  if (!Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > 20) throw unauthorized();
  JWKS_CACHE.set(config.issuer, { keys: body.keys, expiresAt: now + 60 * 60 * 1000 });
  return body.keys;
}

async function verifyCognitoAccessToken(token, options = {}) {
  const config = options.config || getConfig(options.env || process.env);
  const now = Math.floor((options.now === undefined ? Date.now() : options.now) / 1000);
  if (typeof token !== "string" || token.length > 16384) throw unauthorized();
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized();
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" ||
      claims.iss !== config.issuer || claims.token_use !== "access" ||
      claims.client_id !== config.clientId || typeof claims.sub !== "string" ||
      !/^[A-Za-z0-9-]{1,128}$/.test(claims.sub) ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now + MAX_CLOCK_SKEW_SECONDS ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + MAX_CLOCK_SKEW_SECONDS))) {
    throw unauthorized();
  }
  const keys = await loadJwks(config, options.fetch || globalThis.fetch, options.now === undefined ? Date.now() : options.now);
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig" && key.alg === "RS256");
  if (!jwk) throw unauthorized();
  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" }); }
  catch { throw unauthorized(); }
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], "base64url")
  );
  if (!valid) throw unauthorized();
  return {
    uid: claims.sub,
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    username: typeof claims.username === "string" ? claims.username : "",
    token_use: claims.token_use,
    scope: typeof claims.scope === "string" ? claims.scope : "",
    authProvider: "cognito"
  };
}

function clearJwksCacheForTests() {
  JWKS_CACHE.clear();
}

module.exports = { verifyCognitoAccessToken, clearJwksCacheForTests, getConfig };
