const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getTenantDeviceDocument,
  isValidFcmToken,
  isValidInstallationId
} = require("../src/push");

function createFakeDb() {
  function collection(path) {
    return {
      doc(id) {
        const next = `${path}/${id}`;
        return {
          path: next,
          collection(name) { return collection(`${next}/${name}`); }
        };
      }
    };
  }
  return { collection };
}

test("tenant push devices are stored under the selected organization and member", () => {
  const db = createFakeDb();
  const device = getTenantDeviceDocument(
    db,
    "org_alpha",
    "user_123",
    "123e4567-e89b-42d3-a456-426614174000"
  );
  assert.match(device.path, /^organizations\/org_alpha\/members\/user_123\/devices\/[a-f0-9]{64}$/);
});

test("tenant device IDs are isolated by installation ID", () => {
  const db = createFakeDb();
  const first = getTenantDeviceDocument(db, "org_alpha", "user_123", "123e4567-e89b-42d3-a456-426614174000");
  const second = getTenantDeviceDocument(db, "org_beta", "user_123", "123e4567-e89b-42d3-a456-426614174000");
  const third = getTenantDeviceDocument(db, "org_alpha", "user_123", "123e4567-e89b-42d3-a456-426614174001");
  assert.notEqual(first.path, second.path);
  assert.notEqual(first.path, third.path);
});

test("push token and installation ID validators reject malformed values", () => {
  assert.equal(isValidFcmToken("valid-token-value"), true);
  assert.equal(isValidFcmToken("bad token"), false);
  assert.equal(isValidFcmToken(""), false);
  assert.equal(isValidInstallationId("123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(isValidInstallationId("not-an-installation-id"), false);
});
