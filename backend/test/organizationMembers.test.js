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
    collection(name) { return collection(name); },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(reference) {
          const data = records.get(reference.path);
          return { exists: Boolean(data), data: () => data };
        },
        set(reference, data, options) {
          writes.push([reference.path, options ? { ...(records.get(reference.path) || {}), ...data } : data]);
        }
      };
      await callback(transaction);
      for (const [path, data] of writes) records.set(path, data);
    }
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

test("agents cannot add, change, or remove organization members", async () => {
  const { db } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a"), createdBy: "owner_uid" };
  const auth = { async getUserByEmail() { throw new Error("must not look up users"); } };
  const agent = { uid: "agent_uid", role: "agent" };
  await assert.rejects(
    () => addOrganizationMember(db, auth, organization, agent, { email: "new@example.com" }),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => updateOrganizationMemberRole(organization, agent, { uid: "other_uid", role: "agent" }),
    { statusCode: 403 }
  );
  await assert.rejects(
    () => removeOrganizationMember(organization, agent, { uid: "other_uid" }),
    { statusCode: 403 }
  );
});

test("admins may add agents but cannot assign the owner role", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a") };
  const auth = { async getUserByEmail(email) { return { uid: "agent_uid", email }; } };
  const admin = { uid: "admin_uid", role: "admin" };
  const added = await addOrganizationMember(db, auth, organization, admin, { email: "agent@example.com", role: "agent" });
  assert.equal(added.role, "agent");
  assert.equal(records.get("organizations/org_a/members/agent_uid").status, "active");
  await assert.rejects(
    () => addOrganizationMember(db, auth, organization, { role: "owner" }, { email: "owner2@example.com", role: "owner" }),
    { statusCode: 403 }
  );
});

test("duplicate active members cannot be added twice", async () => {
  const { db } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a") };
  await organization.ref.collection("members").doc("existing_uid").set({ status: "active", role: "agent" });
  const auth = { async getUserByEmail(email) { return { uid: "existing_uid", email }; } };
  await assert.rejects(
    () => addOrganizationMember(db, auth, organization, { role: "owner" }, { email: "existing@example.com" }),
    { statusCode: 409 }
  );
});

test("invalid member IDs and roles are rejected before writes", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a") };
  await assert.rejects(
    () => updateOrganizationMemberRole(organization, { role: "owner" }, { uid: "../other", role: "agent" }),
    { statusCode: 400 }
  );
  await assert.rejects(
    () => updateOrganizationMemberRole(organization, { role: "owner" }, { uid: "agent_uid", role: "owner" }),
    { statusCode: 400 }
  );
  await assert.rejects(
    () => removeOrganizationMember(organization, { role: "owner" }, { uid: "../other" }),
    { statusCode: 400 }
  );
  assert.equal(records.size, 0);
});

test("role changes update the tenant member and user organization index together", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a"), createdBy: "owner_uid" };
  await organization.ref.collection("members").doc("agent_uid").set({ role: "agent", status: "active" });
  await db.collection("users").doc("agent_uid").collection("organizations").doc("org_a").set({ role: "agent", status: "active" });
  await updateOrganizationMemberRole(organization, { role: "owner" }, { uid: "agent_uid", role: "admin" });
  assert.equal(records.get("organizations/org_a/members/agent_uid").role, "admin");
  assert.equal(records.get("users/agent_uid/organizations/org_a").role, "admin");
});

test("removal updates the tenant member and user organization index together", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_a", ref: db.collection("organizations").doc("org_a"), createdBy: "owner_uid" };
  await organization.ref.collection("members").doc("agent_uid").set({ role: "agent", status: "active" });
  await db.collection("users").doc("agent_uid").collection("organizations").doc("org_a").set({ role: "agent", status: "active" });
  await removeOrganizationMember(organization, { role: "owner" }, { uid: "agent_uid" });
  assert.equal(records.get("organizations/org_a/members/agent_uid").status, "removed");
  assert.equal(records.get("users/agent_uid/organizations/org_a").status, "removed");
});

test("removed member can be reactivated with both organization records restored", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_reactivate", name: "Workspace", ref: db.collection("organizations").doc("org_reactivate") };
  await organization.ref.collection("members").doc("returning_uid").set({
    uid: "returning_uid", email: "old@example.com", role: "agent", status: "removed"
  });
  await db.collection("users").doc("returning_uid").collection("organizations").doc("org_reactivate").set({
    organizationId: "org_reactivate", role: "agent", status: "removed"
  });
  const auth = { async getUserByEmail(email) {
    assert.equal(email, "returning@example.com");
    return { uid: "returning_uid", email, displayName: "Returning User" };
  } };
  const result = await addOrganizationMember(db, auth, organization, { role: "owner" }, {
    email: "Returning@example.com", role: "admin"
  });
  assert.equal(result.status, "active");
  assert.equal(result.role, "admin");
  assert.equal(records.get("organizations/org_reactivate/members/returning_uid").status, "active");
  assert.equal(records.get("organizations/org_reactivate/members/returning_uid").role, "admin");
  assert.equal(records.get("users/returning_uid/organizations/org_reactivate").status, "active");
  assert.equal(records.get("users/returning_uid/organizations/org_reactivate").role, "admin");
});

test("failed duplicate-member transaction does not write either membership record", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_duplicate", ref: db.collection("organizations").doc("org_duplicate") };
  await organization.ref.collection("members").doc("active_uid").set({
    uid: "active_uid", role: "agent", status: "active"
  });
  await db.collection("users").doc("active_uid").collection("organizations").doc("org_duplicate").set({
    organizationId: "org_duplicate", role: "agent", status: "active"
  });
  const beforeMember = { ...records.get("organizations/org_duplicate/members/active_uid") };
  const beforeIndex = { ...records.get("users/active_uid/organizations/org_duplicate") };
  const auth = { async getUserByEmail(email) { return { uid: "active_uid", email }; } };
  await assert.rejects(
    () => addOrganizationMember(db, auth, organization, { role: "owner" }, { email: "active@example.com" }),
    { statusCode: 409 }
  );
  assert.deepEqual(records.get("organizations/org_duplicate/members/active_uid"), beforeMember);
  assert.deepEqual(records.get("users/active_uid/organizations/org_duplicate"), beforeIndex);
});
