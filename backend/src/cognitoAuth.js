"use strict";

const crypto = require("node:crypto");

const jwksCache = new Map();

function authError(message = "Cognito access token is invalid or expired.") {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function decodeSegment(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw authError();
  }
}

function getCognitoConfig() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_APP_CLIENT_ID;
  if (!region || !userPoolId || !clientId || !userPoolId.startsWith(region + "_")) {
    const error = new Error("Cognito authentication requires AWS_REGION, COGNITO_USER_POOL_ID and COGNITO_APP_CLIENT_ID.");
    error.statusCode = 503;
    throw error;
  }
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  return { issuer, clientId, jwksUrl: issuer + "/.well-known/jwks.json" };
}

async function getSigningKey(kid, jwksUrl) {
  let cached = jwksCache.get(jwksUrl);
  if (!cached || cached.expiresAt <= Date.now()) {
    const response = await fetch(jwksUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Unable to load Cognito signing keys.");
    const body = await response.json();
    if (!Array.isArray(body.keys)) throw new Error("Cognito signing keys response is invalid.");
    cached = { keys: body.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
    jwksCache.set(jwksUrl, cached);
  }
  const jwk = cached.keys.find((key) => key.kid === kid && key.kty === "RSA" && key.use === "sig" && key.alg === "RS256");
  if (!jwk) {
    jwksCache.delete(jwksUrl);
    throw authError();
  }
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

async function verifyCognitoAccessToken(token) {
  if (typeof token !== "string" || token.length > 16384) throw authError();
  const config = getCognitoConfig();
  const parts = token.split(".");
  if (parts.length !== 3) throw authError();
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw authError();
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.issuer || claims.token_use !== "access" ||
      claims.client_id !== config.clientId || typeof claims.sub !== "string" ||
      !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) ||
      (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now + 60))) {
    throw authError();
  }
  const key = await getSigningKey(header.kid, config.jwksUrl);
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(parts[0] + "." + parts[1]),
    key,
    Buffer.from(parts[2], "base64url")
  );
  if (!valid) throw authError();
  return { ...claims, uid: claims.sub, authProvider: "cognito" };
}

module.exports = { verifyCognitoAccessToken, getCognitoConfig };
