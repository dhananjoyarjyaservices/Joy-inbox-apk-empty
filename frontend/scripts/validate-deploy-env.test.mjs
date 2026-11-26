import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "validate-deploy-env.mjs");
const required = {
  VITE_FIREBASE_API_KEY: "public-key",
  VITE_FIREBASE_AUTH_DOMAIN: "joy-inbox.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "joy-inbox",
  VITE_FIREBASE_STORAGE_BUCKET: "joy-inbox.firebasestorage.app",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "123456",
  VITE_FIREBASE_APP_ID: "1:123456:web:abcdef",
  VITE_API_BASE_URL: "https://api.example.com",
};

function run(overrides = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ...required, ...overrides },
  });
}

test("accepts complete Firebase and HTTPS API configuration", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test("rejects missing and placeholder configuration", () => {
  assert.notEqual(run({ VITE_FIREBASE_PROJECT_ID: "" }).status, 0);
  assert.notEqual(run({ VITE_FIREBASE_PROJECT_ID: "YOUR_PROJECT_ID" }).status, 0);
});

test("rejects non-HTTPS and malformed API base URLs", () => {
  assert.notEqual(run({ VITE_API_BASE_URL: "http://api.example.com" }).status, 0);
  assert.notEqual(run({ VITE_API_BASE_URL: "not-a-url" }).status, 0);
});

test("rejects API URLs containing credentials or query strings", () => {
  assert.notEqual(run({ VITE_API_BASE_URL: "https://user:pass@api.example.com" }).status, 0);
  assert.notEqual(run({ VITE_API_BASE_URL: "https://api.example.com?token=secret" }).status, 0);
});
