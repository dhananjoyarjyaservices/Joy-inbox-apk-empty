const test = require("node:test");
const assert = require("node:assert/strict");
const { getCorsHeaders } = require("../src/security");

test("CORS allows the methods used by authenticated tenant resource APIs", () => {
  process.env.CORS_ORIGINS = "https://app.example.com";
  const headers = getCorsHeaders({ headers: { Origin: "https://app.example.com" } });
  assert.equal(headers["Access-Control-Allow-Origin"], "https://app.example.com");
  assert.match(headers["Access-Control-Allow-Methods"], /PUT/);
  assert.match(headers["Access-Control-Allow-Methods"], /DELETE/);
  assert.match(headers["Access-Control-Allow-Headers"], /Authorization/);
  delete process.env.CORS_ORIGINS;
});

test("CORS does not reflect an unapproved origin", () => {
  process.env.CORS_ORIGINS = "https://app.example.com";
  const headers = getCorsHeaders({ headers: { origin: "https://attacker.example" } });
  assert.equal(headers["Access-Control-Allow-Origin"], undefined);
  delete process.env.CORS_ORIGINS;
});
