"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDynamoTenancy } = require("../src/aws/dynamoTenancy");

test("resolves tenant membership from DynamoDB and preserves the existing role contract", async () => {
  let received;
  const tenancy = createDynamoTenancy({
    organizationStore: {
      requireActiveOrganization: async (organizationId, uid) => {
        received = { organizationId, uid };
        return { id: organizationId, uid, role: "admin", status: "active" };
      }
    }
  });
  const organization = await tenancy.requireOrganization({ uid: "user_1" }, "org_1");
  assert.deepEqual(received, { organizationId: "org_1", uid: "user_1" });
  assert.equal(organization.role, "admin");
  assert.equal(organization.id, "org_1");
  assert.doesNotThrow(() => tenancy.requirePermission(organization, "members:manage"));
});

test("rejects missing identity, malformed tenant IDs and unknown roles", async () => {
  const tenancy = createDynamoTenancy({
    organizationStore: {
      requireActiveOrganization: async () => ({ role: "superuser" })
    }
  });
  await assert.rejects(() => tenancy.requireOrganization({}, "org_1"), { statusCode: 401 });
  await assert.rejects(() => tenancy.requireOrganization({ uid: "user_1" }, "bad/id"), { statusCode: 400 });
  await assert.rejects(() => tenancy.requireOrganization({ uid: "user_1" }, "org_1"), { statusCode: 403 });
});

test("enforces existing role permissions and rejects privilege escalation", () => {
  const tenancy = createDynamoTenancy({
    organizationStore: { requireActiveOrganization: async () => ({}) }
  });
  assert.throws(() => tenancy.requirePermission({ role: "agent" }, "members:manage"), { statusCode: 403 });
  assert.doesNotThrow(() => tenancy.requirePermission({ role: "agent" }, "chats:read"));
  assert.throws(() => tenancy.requirePermission({ role: "owner" }, "billing:manage"), { statusCode: 403 });
});
