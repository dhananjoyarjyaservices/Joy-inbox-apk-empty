const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ROLES,
  ROLE_PERMISSIONS,
  requireOrganization,
  requirePermission
} = require("../src/tenancy");

function httpError(statusCode) {
  return (error) => error.statusCode === statusCode;
}

function fakeDb({ organization = { status: "active", name: "Workspace" }, member = { status: "active", role: "owner" } } = {}) {
  const organizationRef = {
    collection(name) {
      assert.equal(name, "members");
      return {
        doc(uid) {
          return {
            async get() {
              return member && uid === "user_1"
                ? { exists: true, data: () => member }
                : { exists: false, data: () => undefined };
            }
          };
        }
      };
    }
  };
  return {
    collection(name) {
      assert.equal(name, "organizations");
      return {
        doc(id) {
          return {
            ref: organizationRef,
            async get() {
              return id === "org_1" && organization
                ? { exists: true, data: () => organization, ref: organizationRef }
                : { exists: false, data: () => undefined };
            }
          };
        }
      };
    }
  };
}

test("only the three explicitly supported workspace roles are recognized", () => {
  assert.deepEqual([...ROLES].sort(), ["admin", "agent", "owner"]);
  assert.equal(ROLE_PERMISSIONS.owner.has("members:manage"), true);
  assert.equal(ROLE_PERMISSIONS.admin.has("members:manage"), true);
  assert.equal(ROLE_PERMISSIONS.agent.has("members:manage"), false);
});

test("owner and admin have management permissions while agents do not", () => {
  const managementPermissions = [
    "members:manage",
    "settings:manage",
    "whatsapp:manage"
  ];
  for (const role of ["owner", "admin"]) {
    for (const permission of managementPermissions) {
      assert.doesNotThrow(() => requirePermission({ role }, permission), `${role} should have ${permission}`);
    }
  }
  for (const permission of managementPermissions) {
    assert.throws(() => requirePermission({ role: "agent" }, permission), httpError(403));
  }
});

test("all active workspace roles can use permitted inbox capabilities", () => {
  const inboxPermissions = [
    "chats:read",
    "chats:manage",
    "messages:send",
    "contacts:manage",
    "quickReplies:manage"
  ];
  for (const role of ["owner", "admin", "agent"]) {
    for (const permission of inboxPermissions) {
      assert.doesNotThrow(() => requirePermission({ role }, permission), `${role} should have ${permission}`);
    }
  }
});

test("unknown roles and unknown permissions fail closed", () => {
  for (const role of ["", "superadmin", "member", null, undefined]) {
    assert.throws(() => requirePermission({ role }, "chats:read"), httpError(403));
  }
  for (const permission of ["", "billing:manage", "organizations:delete", "__proto__"]) {
    assert.throws(() => requirePermission({ role: "owner" }, permission), httpError(403));
  }
  assert.throws(() => requirePermission(null, "chats:read"), httpError(403));
});

test("organization access requires a verified uid and a valid organization ID", async () => {
  const db = fakeDb();
  await assert.rejects(() => requireOrganization(db, null, "org_1"), httpError(401));
  await assert.rejects(() => requireOrganization(db, {}, "org_1"), httpError(401));
  for (const id of ["", "../org_1", "org/1", "x".repeat(129), null]) {
    await assert.rejects(() => requireOrganization(db, { uid: "user_1" }, id), httpError(400));
  }
});

test("only active members of active organizations can enter a workspace", async () => {
  const scenarios = [
    { organization: null, member: { status: "active", role: "owner" } },
    { organization: { status: "suspended" }, member: { status: "active", role: "owner" } },
    { organization: { status: "active" }, member: null },
    { organization: { status: "active" }, member: { status: "removed", role: "owner" } },
    { organization: { status: "active" }, member: { status: "active", role: "unknown" } }
  ];
  for (const scenario of scenarios) {
    await assert.rejects(
      () => requireOrganization(fakeDb(scenario), { uid: "user_1" }, "org_1"),
      httpError(403)
    );
  }
});

test("workspace context derives role from the stored membership, not the token", async () => {
  const organization = await requireOrganization(
    fakeDb({ member: { status: "active", role: "agent" } }),
    { uid: "user_1", role: "owner", admin: true },
    "org_1"
  );
  assert.equal(organization.id, "org_1");
  assert.equal(organization.uid, "user_1");
  assert.equal(organization.role, "agent");
  assert.throws(() => requirePermission(organization, "members:manage"), httpError(403));
});

test("a user cannot borrow another user's membership or a different workspace ID", async () => {
  await assert.rejects(
    () => requireOrganization(fakeDb(), { uid: "user_2", role: "owner" }, "org_1"),
    httpError(403)
  );
  await assert.rejects(
    () => requireOrganization(fakeDb(), { uid: "user_1" }, "org_2"),
    httpError(403)
  );
});
