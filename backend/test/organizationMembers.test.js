const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addOrganizationMember,
  updateOrganizationMemberRole,
  removeOrganizationMember,
  listOrganizationMembers,
  listOrganizationMemberAudit
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
          return { exists: Boolean(data), id: reference.path.split("/").at(-1), data: () => data };
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
        return { exists: Boolean(data), id: path.split("/").at(-1), data: () => data };
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
      },
      orderBy(field, direction = "asc") {
        let afterId = "";
        let afterValue = null;
        let max = Infinity;
        const query = {
          startAfter(snapshot) { afterId = snapshot.id; afterValue = snapshot.data()?.[field]; return query; },
          limit(value) { max = value; return query; },
          async get() {
            const prefix = path + "/";
            const docs = [...records.entries()]
              .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
              .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value }))
              .sort((a, b) => {
                if (field === "__name__") return a.id.localeCompare(b.id);
                const left = a.data()[field]?.getTime?.() ?? 0;
                const right = b.data()[field]?.getTime?.() ?? 0;
                const byTimestamp = direction === "desc" ? right - left : left - right;
                return byTimestamp || (direction === "desc" ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id));
              })
              .filter(item => {
                if (!afterId) return true;
                if (field === "__name__") return item.id > afterId;
                const value = item.data()[field];
                const comparison = (value?.getTime?.() ?? 0) - (afterValue?.getTime?.() ?? 0);
                if (comparison === 0) return direction === "desc" ? item.id < afterId : item.id > afterId;
                return direction === "desc" ? comparison < 0 : comparison > 0;
              })
              .slice(0, max);
            return { docs };
          }
        };
        return query;
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
  assert.equal((await listOrganizationMembers(db, organization)).members.length, 1);
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
  await organization.ref.collection("members").doc("agent_uid").set({ email: "agent@example.com", role: "agent", status: "active" });
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
  assert.equal(records.get("organizations/org_reactivate/members/returning_uid").removedAt, null);
  assert.equal(records.get("users/returning_uid/organizations/org_reactivate").status, "active");
  assert.equal(records.get("users/returning_uid/organizations/org_reactivate").role, "admin");
  assert.equal(records.get("users/returning_uid/organizations/org_reactivate").removedAt, null);
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

test("Firebase user lookup maps missing, disabled, and transient errors safely", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_lookup", ref: db.collection("organizations").doc("org_lookup") };
  const actor = { role: "owner" };
  for (const [code, statusCode] of [
    ["auth/user-not-found", 404],
    ["auth/user-disabled", 403],
    ["auth/invalid-email", 400],
    ["auth/too-many-requests", 503],
    ["auth/internal-error", 503],
    ["auth/network-request-failed", 503],
    ["auth/unexpected-provider-error", 502]
  ]) {
    const auth = { async getUserByEmail() { throw Object.assign(new Error("private provider detail"), { code }); } };
    await assert.rejects(
      () => addOrganizationMember(db, auth, organization, actor, { email: "person@example.com" }),
      (error) => error.statusCode === statusCode && !error.message.includes("private provider detail")
    );
  }
  assert.equal(records.size, 0);
});

test("malformed Firebase user lookup results are rejected without membership writes", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_bad_result", ref: db.collection("organizations").doc("org_bad_result") };
  for (const result of [null, {}, { uid: "../bad", email: "person@example.com" }, { uid: "valid_uid", email: 123 }]) {
    const auth = { async getUserByEmail() { return result; } };
    await assert.rejects(
      () => addOrganizationMember(db, auth, organization, { role: "owner" }, { email: "person@example.com" }),
      { statusCode: 502 }
    );
  }
  assert.equal(records.size, 0);
});

test("member listing returns bounded pages and a stable next cursor", async () => {
  const { db } = fakeDb();
  const organization = { id: "org_pages", ref: db.collection("organizations").doc("org_pages") };
  for (const uid of ["member_01", "member_02", "member_03", "member_04", "member_05"]) {
    await organization.ref.collection("members").doc(uid).set({ uid, email: uid + "@example.com", role: "agent", status: "active" });
  }
  const first = await listOrganizationMembers(db, organization, { limit: 2 });
  assert.deepEqual(first.members.map(member => member.uid), ["member_01", "member_02"]);
  assert.equal(first.nextCursor, "member_02");
  const second = await listOrganizationMembers(db, organization, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.members.map(member => member.uid), ["member_03", "member_04"]);
  assert.equal(second.nextCursor, "member_04");
  const third = await listOrganizationMembers(db, organization, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.members.map(member => member.uid), ["member_05"]);
  assert.equal(third.nextCursor, null);
});

test("member listing clamps oversized page sizes and rejects invalid cursors", async () => {
  const { db } = fakeDb();
  const organization = { id: "org_limits", ref: db.collection("organizations").doc("org_limits") };
  for (let index = 1; index <= 105; index += 1) {
    const uid = "user_" + String(index).padStart(3, "0");
    await organization.ref.collection("members").doc(uid).set({ role: "agent", status: "active" });
  }
  const page = await listOrganizationMembers(db, organization, { limit: 1000 });
  assert.equal(page.members.length, 100);
  assert.ok(page.nextCursor);
  await assert.rejects(
    () => listOrganizationMembers(db, organization, { cursor: "../invalid" }),
    { statusCode: 400 }
  );
  await assert.rejects(
    () => listOrganizationMembers(db, organization, { cursor: "missing_uid" }),
    { statusCode: 400 }
  );
});


test("member role changes are recorded in a tenant-scoped audit log", async () => {
  const { db, records } = fakeDb();
  const organization = { id: "org_audit", ref: db.collection("organizations").doc("org_audit"), createdBy: "owner_uid" };
  await organization.ref.collection("members").doc("agent_uid").set({ role: "agent", status: "active" });
  await updateOrganizationMemberRole(organization, { uid: "owner_uid", email: "owner@example.com", role: "owner" }, { uid: "agent_uid", role: "admin" });
  const auditEntries = [...records.entries()].filter(([path]) => path.startsWith("organizations/org_audit/auditLogs/"));
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0][1].action, "member.role_changed");
  assert.equal(auditEntries[0][1].actorUid, "owner_uid");
  assert.equal(auditEntries[0][1].actorEmail, "owner@example.com");
  assert.equal(auditEntries[0][1].targetUid, "agent_uid");
  assert.equal(auditEntries[0][1].targetEmail, "agent@example.com");
  assert.equal(auditEntries[0][1].details.role, "admin");
  const page = await listOrganizationMemberAudit(db, organization, { limit: 10 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].action, "member.role_changed");
  assert.equal(page.events[0].actorEmail, "owner@example.com");
  assert.equal(page.events[0].targetEmail, "agent@example.com");
});

test("member audit history returns bounded cursor pages in newest-first order", async () => {
  const { db } = fakeDb();
  const organization = { id: "org_audit_pages", ref: db.collection("organizations").doc("org_audit_pages") };
  const audit = organization.ref.collection("auditLogs");
  for (let index = 1; index <= 4; index += 1) {
    await audit.doc("event_" + index).set({
      action: "member.added",
      targetUid: "member_" + index,
      createdAt: new Date(2026, 0, index)
    });
  }
  const first = await listOrganizationMemberAudit(db, organization, { limit: 2 });
  assert.deepEqual(first.events.map(event => event.id), ["event_4", "event_3"]);
  assert.equal(first.nextCursor, "event_3");
  const second = await listOrganizationMemberAudit(db, organization, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.events.map(event => event.id), ["event_2", "event_1"]);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    () => listOrganizationMemberAudit(db, organization, { cursor: "../invalid" }),
    { statusCode: 400 }
  );
});
