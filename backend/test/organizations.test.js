const test = require("node:test");
const assert = require("node:assert/strict");
const { createOrganization, normalizeOrganizationName } = require("../src/organizations");

function fakeDb() {
  const records = new Map();
  let nextId = 0;
  function ref(path) {
    return {
      id: path.split("/").at(-1),
      path,
      collection(name) { return collection(path + "/" + name); }
    };
  }
  function collection(path) {
    return {
      doc(id) {
        const actualId = id || "org_" + (++nextId);
        return ref(path + "/" + actualId);
      }
    };
  }
  const db = {
    collection,
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        create(reference, value) { writes.push([reference.path, value]); },
        set(reference, value) { writes.push([reference.path, value]); }
      };
      await callback(tx);
      for (const [path, value] of writes) {
        if (records.has(path)) throw new Error("already exists");
        records.set(path, value);
      }
    }
  };
  return { db, records };
}

test("normalizes business names and rejects invalid input", () => {
  assert.equal(normalizeOrganizationName("  Joy   Inbox  "), "Joy Inbox");
  assert.throws(() => normalizeOrganizationName("x"), { statusCode: 400 });
  assert.throws(() => normalizeOrganizationName("<script>"), { statusCode: 400 });
});

test("creates organization, owner membership and user index atomically", async () => {
  const { db, records } = fakeDb();
  const result = await createOrganization(db, { uid: "firebase-user-1" }, { name: "Joy Inbox" });
  assert.equal(result.name, "Joy Inbox");
  assert.equal(result.role, "owner");
  assert.equal(records.get("organizations/org_1").createdBy, "firebase-user-1");
  assert.equal(records.get("organizations/org_1/members/firebase-user-1").role, "owner");
  assert.equal(records.get("users/firebase-user-1/organizations/org_1").organizationId, "org_1");
});

test("requires a verified user identity", async () => {
  const { db } = fakeDb();
  await assert.rejects(() => createOrganization(db, null, { name: "Joy Inbox" }), { statusCode: 401 });
});
