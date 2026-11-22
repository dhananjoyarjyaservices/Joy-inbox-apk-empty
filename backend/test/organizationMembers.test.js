const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addOrganizationMember,
  updateOrganizationMemberRole,
  removeOrganizationMember,
  listOrganizationMembers
} = require("../src/organizationMembers");

function fakeDb() {
  const records = new Map();
  const db = {
    collection(name) { return collection(name); }
  };
  function ref(path) {
    return {
      id: path.split("/").at(-1),
      path,
      firestore: db,
      collection(name) { return collection(path + "/" + name); },
      async get() {
        const data = records.get(path);
        return { exists: Boolean(data), data: () => data };
      },
      async set(data, options) {
        records.set(path, options ? { ...(records.get(path) || {}), ...data } : data);
      }
    };
  }
  function collection(path) {
    return {
      doc(id) { return ref(path + "/" + (id || "generated")); },
      async get() {
        const prefix = path + "/";
        const docs = [...records.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value }));
        return { docs };
      }
    };
  }
  return { db, records };
}

test("owner can add existing Firebase users as agents and list members", async () => {
  const { db, records } = fakeDb();
  const organizationRef = db.collection("organizations").doc("org_a");
  const organization = { id: "org_a", ref: organizationRef, createdBy: "owner_uid" };
  const auth = { async getUserByEmail(email) {
    assert.equal(email, "agent@example.com");
    return { uid: "agent_uid", email, displayName: "Agent" };
  } };
  const member = await addOrganizationMember(db, auth, organization, { uid: "owner_uid", role: "owner" }, { email: "Agent@example.com", role: "agent" });
  assert.equal(member.uid, "agent_uid");
  assert.equal(records.get("organizations/org_a/members/agent_uid").status, "active");
  assert.equal(records.get("users/agent_uid/organizations/org_a").role, "agent");
  assert.equal((await listOrganizationMembers(db, organization)).length, 1);
});

test("admins cannot add or promote other admins", async () => {
  const { db } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a") };
  const auth = { async getUserByEmail(email) { return { uid: "new_uid", email }; } };
  await assert.rejects(
    () => addOrganizationMember(db, auth, organization, { role: "admin" }, { email: "new@example.com", role: "admin" }),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => updateOrganizationMemberRole(organization, { role: "admin" }, { uid: "agent_uid", role: "admin" }),
    { statusCode: 403 }
  );
});

test("owner membership cannot be demoted or removed", async () => {
  const { db } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a"), createdBy: "owner_uid" };
  await organization.ref.collection("members").doc("owner_uid").set({ role: "owner", status: "active" });
  await assert.rejects(
    () => updateOrganizationMemberRole(organization, { role: "owner" }, { uid: "owner_uid", role: "agent" }),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => removeOrganizationMember(organization, { role: "owner" }, { uid: "owner_uid" }),
    { statusCode: 403 }
  );
});

test("member removal revokes active organization index", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a"), createdBy: "owner_uid" };
  await organization.ref.collection("members").doc("agent_uid").set({ role: "agent", status: "active" });
  const result = await removeOrganizationMember(organization, { role: "owner" }, { uid: "agent_uid" });
  assert.equal(result.status, "removed");
  assert.equal(records.get("organizations/org_a/members/agent_uid").status, "removed");
  assert.equal(records.get("users/agent_uid/organizations/org_a").status, "removed");
});
