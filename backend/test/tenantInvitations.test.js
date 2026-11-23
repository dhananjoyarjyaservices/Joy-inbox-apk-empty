"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeInvitationEmail,
  createInvitationUrl,
  createTenantInvitation,
  listTenantInvitations,
  revokeTenantInvitation,
  acceptTenantInvitation
} = require("../src/tenantInvitations");

function createInvitationDb(seed = {}) {
  const values = new Map(Object.entries(seed));
  const ref = path => ({
    path,
    id: path.split("/").pop(),
    collection(name) { return collection(path + "/" + name); },
    async get() {
      const value = values.get(path);
      return { exists: Boolean(value), data: () => value, get: key => value?.[key] };
    },
    async set(value, options) {
      values.set(path, options?.merge ? { ...(values.get(path) || {}), ...value } : value);
    },
    async update(value) { values.set(path, { ...(values.get(path) || {}), ...value }); }
  });
  const collection = path => ({
    doc(id) { return ref(path + "/" + id); },
    orderBy() { return this; },
    limit() { return this; },
    async get() {
      const prefix = path + "/";
      const docs = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map(([key, value]) => ({ id: key.split("/").pop(), data: () => value }));
      return { docs };
    }
  });
  const db = {
    collection(name) { return collection(name); },
    async runTransaction(callback) {
      return callback({
        async get(documentRef) {
          const value = values.get(documentRef.path);
          return { exists: Boolean(value), data: () => value, get: key => value?.[key] };
        },
        set(documentRef, value, options) {
          values.set(documentRef.path, options?.merge ? { ...(values.get(documentRef.path) || {}), ...value } : value);
        },
        update(documentRef, value) {
          values.set(documentRef.path, { ...(values.get(documentRef.path) || {}), ...value });
        }
      });
    }
  };
  return { db, values };
}

test("normalizes invitation emails and builds trusted setup URLs", () => {
  assert.equal(normalizeInvitationEmail("  Agent@Example.com "), "agent@example.com");
  assert.throws(() => normalizeInvitationEmail("not-an-email"), /valid invitation email/);
  assert.match(createInvitationUrl("https://app.example.com", "org_1", "a".repeat(43)), /\/setup\?/);
  assert.throws(() => createInvitationUrl("http://app.example.com", "org_1", "a".repeat(43)), /HTTPS/);
});

test("creates a one-time invitation with only a token hash stored", async () => {
  const { db, values } = createInvitationDb({
    "organizations/org_1": { status: "active", name: "Joy Inbox" }
  });
  const invitation = await createTenantInvitation(db, "org_1", { uid: "owner_1" }, {
    email: "Agent@Example.com", role: "agent"
  }, {
    now: () => new Date("2026-11-23T12:00:00.000Z"),
    frontendBaseUrl: "https://app.example.com"
  });
  assert.equal(invitation.email, "agent@example.com");
  assert.equal(invitation.role, "agent");
  assert.match(invitation.token, /^[A-Za-z0-9_-]{40,64}$/);
  assert.match(invitation.inviteUrl, /organizationId=org_1/);
  const stored = [...values.entries()].find(([path]) => path.startsWith("organizations/org_1/invitations/"))?.[1];
  assert.ok(stored.tokenHash);
  assert.notEqual(stored.tokenHash, invitation.token);
  assert.equal(stored.status, "pending");
  await assert.rejects(createTenantInvitation(db, "org_1", { uid: "owner_1" }, {
    email: "agent@example.com", role: "admin"
  }), error => error.statusCode === 409);
});

test("accepts an invitation once and creates member plus workspace index", async () => {
  const { db, values } = createInvitationDb({
    "organizations/org_1": { status: "active", name: "Joy Inbox" }
  });
  const invitation = await createTenantInvitation(db, "org_1", { uid: "owner_1" }, {
    email: "agent@example.com", role: "admin"
  }, { now: () => new Date("2026-11-23T12:00:00.000Z") });
  const accepted = await acceptTenantInvitation(db, "org_1", invitation.token, {
    uid: "agent_1", email: "agent@example.com", email_verified: true
  }, { now: () => new Date("2026-11-23T13:00:00.000Z") });
  assert.deepEqual(accepted, { organizationId: "org_1", role: "admin", status: "active" });
  const member = values.get("organizations/org_1/members/agent_1");
  assert.equal(member.role, "admin");
  assert.equal(member.status, "active");
  const index = values.get("users/agent_1/organizations/org_1");
  assert.equal(index.name, "Joy Inbox");
  assert.equal(index.role, "admin");
  const storedInvitation = [...values.entries()].find(([path]) => path.startsWith("organizations/org_1/invitations/"))?.[1];
  assert.equal(storedInvitation.status, "accepted");
  assert.equal(storedInvitation.tokenHash, null);
  await assert.rejects(acceptTenantInvitation(db, "org_1", invitation.token, {
    uid: "agent_1", email: "agent@example.com", email_verified: true
  }), error => error.statusCode === 409);
});

test("requires verified matching email and rejects expired invitations", async () => {
  const { db } = createInvitationDb({ "organizations/org_1": { status: "active", name: "Joy Inbox" } });
  const invitation = await createTenantInvitation(db, "org_1", { uid: "owner_1" }, {
    email: "agent@example.com", role: "agent"
  }, { now: () => new Date("2026-11-23T12:00:00.000Z") });
  await assert.rejects(acceptTenantInvitation(db, "org_1", invitation.token, {
    uid: "agent_1", email: "agent@example.com", email_verified: false
  }), /verified email/);
  await assert.rejects(acceptTenantInvitation(db, "org_1", invitation.token, {
    uid: "agent_1", email: "other@example.com", email_verified: true
  }), error => error.statusCode === 404 || error.statusCode === 403);
  await assert.rejects(acceptTenantInvitation(db, "org_1", invitation.token, {
    uid: "agent_1", email: "agent@example.com", email_verified: true
  }, { now: () => new Date("2026-12-01T12:00:00.000Z") }), error => error.statusCode === 410);
});

test("lists and revokes pending invitations", async () => {
  const { db, values } = createInvitationDb({ "organizations/org_1": { status: "active" } });
  await createTenantInvitation(db, "org_1", { uid: "owner_1" }, { email: "agent@example.com", role: "agent" });
  const listed = await listTenantInvitations(db, "org_1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].email, "agent@example.com");
  const revoked = await revokeTenantInvitation(db, "org_1", "agent@example.com", "owner_1");
  assert.equal(revoked.status, "revoked");
  const stored = [...values.entries()].find(([path]) => path.startsWith("organizations/org_1/invitations/"))?.[1];
  assert.equal(stored.status, "revoked");
});
