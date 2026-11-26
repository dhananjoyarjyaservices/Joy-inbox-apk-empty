"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dynamodb = require("../src/dynamodb");
const media = require("../src/s3Media");
const workspaces = require("../src/dynamodbWorkspaces");
const records = require("../src/dynamodbRecords");
const members = require("../src/dynamodbMembers");
const invitations = require("../src/dynamodbInvitations");
const billing = require("../src/dynamodbBilling");
const whatsapp = require("../src/dynamodbWhatsApp");
const crypto = require("node:crypto");


test("DynamoDB workspace service validates names and verified Firebase identities", () => {
  assert.equal(workspaces.normalizeWorkspaceName("  My   Business  "), "My Business");
  assert.throws(() => workspaces.normalizeWorkspaceName("x"), { statusCode: 400 });
  return assert.rejects(workspaces.createWorkspace({}, { name: "My Business" }), { statusCode: 401 });
});

test("DynamoDB key builders create workspace-scoped PK/SK values", () => {
  assert.deepEqual(dynamodb.workspaceKey("workspace_1"), { PK: "ORG#workspace_1", SK: "WORKSPACE" });
  assert.deepEqual(dynamodb.membershipKey("workspace_1", "user_1"), { PK: "ORG#workspace_1", SK: "MEMBER#user_1" });
  assert.deepEqual(dynamodb.customerKey("workspace_1", "customer_1"), { PK: "ORG#workspace_1", SK: "CUSTOMER#customer_1" });
  assert.deepEqual(dynamodb.messageKey("workspace_1", "conversation_1", 1760000000000, "message_1"), {
    PK: "ORG#workspace_1#CONVERSATION#conversation_1",
    SK: "MESSAGE#0001760000000000#message_1"
  });
});

test("DynamoDB key builders support user workspace pointers and conversation summaries", () => {
  assert.equal(dynamodb.userWorkspacePartition("user_1"), "USER#user_1");
  assert.deepEqual(dynamodb.userWorkspacePointerKey("user_1", "workspace_1"), {
    PK: "USER#user_1",
    SK: "ORG#workspace_1"
  });
  assert.deepEqual(dynamodb.conversationSummaryKey("workspace_1", "conversation_1"), {
    PK: "ORG#workspace_1",
    SK: "CONVERSATION#conversation_1"
  });
});

test("DynamoDB user and conversation key builders reject malformed IDs", () => {
  assert.throws(() => dynamodb.userWorkspacePartition("../user"), { statusCode: 400 });
  assert.throws(() => dynamodb.userWorkspacePointerKey("user_1", "../workspace"), { statusCode: 400 });
  assert.throws(() => dynamodb.conversationSummaryKey("workspace_1", "bad/conversation"), { statusCode: 400 });
});

test("DynamoDB tenant partition guard rejects cross-tenant and unscoped partitions", () => {
  assert.doesNotThrow(() => dynamodb.assertTenantPartition("org_a", "ORG#org_a"));
  assert.doesNotThrow(() => dynamodb.assertTenantPartition("org_a", "ORG#org_a#CONVERSATION#c1"));
  assert.throws(() => dynamodb.assertTenantPartition("org_a", "ORG#org_b"));
  assert.throws(() => dynamodb.assertTenantPartition("org_a", "USER#user_a"));
});

test("DynamoDB key builders reject malformed IDs and timestamps", () => {
  assert.throws(() => dynamodb.workspaceKey("../other"), { statusCode: 400 });
  assert.throws(() => dynamodb.customerKey("org_a", "bad/customer"), { statusCode: 400 });
  assert.throws(() => dynamodb.messageKey("org_a", "conv_a", "not-a-time", "msg_a"), { statusCode: 400 });
});


test("DynamoDB workspace creation writes workspace, owner and reverse pointer atomically", async () => {
  const previous = {
    region: process.env.AWS_REGION,
    workspaces: process.env.DYNAMODB_WORKSPACES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return {};
    }
  });
  try {
    const created = await workspaces.createWorkspace(
      { uid: "firebase_user_1" },
      { name: "Example Shop" },
      { organizationId: "workspace_1" }
    );
    assert.deepEqual(created, {
      id: "workspace_1",
      name: "Example Shop",
      role: "owner",
      status: "active"
    });
    assert.equal(captured.TransactItems.length, 3);
    const items = captured.TransactItems.map(entry => entry.Put.Item);
    assert.deepEqual(items.map(item => [item.PK, item.SK]), [
      ["ORG#workspace_1", "WORKSPACE"],
      ["ORG#workspace_1", "MEMBER#firebase_user_1"],
      ["USER#firebase_user_1", "ORG#workspace_1"]
    ]);
    assert.equal(items[0].subscriptionStatus, "inactive");
    assert.equal(items[0].seatLimit, 1);
    assert.equal(items[0].activeSeatCount, 1);
    assert.equal(items[0].trialUsed, false);
    assert.ok(captured.TransactItems.every(entry =>
      entry.Put.ConditionExpression.includes("attribute_not_exists")
    ));
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (previous.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous.region;
    if (previous.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE;
    else process.env.DYNAMODB_WORKSPACES_TABLE = previous.workspaces;
  }
});

test("DynamoDB partition queries support safe sort-key prefix filtering", async () => {
  const previous = {
    region: process.env.AWS_REGION,
    workspaces: process.env.DYNAMODB_WORKSPACES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return { Items: [] };
    }
  });
  try {
    await dynamodb.queryPartition("workspaces", "workspace_1", "ORG#workspace_1", {
      sortKeyBeginsWith: "MEMBER#"
    });
    assert.equal(captured.KeyConditionExpression, "PK = :pk AND begins_with(SK, :skPrefix)");
    assert.equal(captured.ExpressionAttributeValues[":skPrefix"], "MEMBER#");
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (previous.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous.region;
    if (previous.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE;
    else process.env.DYNAMODB_WORKSPACES_TABLE = previous.workspaces;
  }
});


test("DynamoDB customer and conversation repositories enforce tenant keys", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  const writes = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      writes.push(command.input);
      return {};
    }
  });
  try {
    const customer = await records.saveCustomer("workspace_1", "customer_1", {
      name: "Customer One",
      organizationId: "attacker_workspace"
    });
    assert.equal(customer.PK, "ORG#workspace_1");
    assert.equal(customer.organizationId, "workspace_1");
    assert.equal(customer.SK, "CUSTOMER#customer_1");
    const conversation = await records.saveConversationSummary("workspace_1", "conversation_1", {
      status: "open",
      PK: "ORG#attacker"
    });
    assert.equal(conversation.PK, "ORG#workspace_1");
    assert.equal(conversation.SK, "CONVERSATION#conversation_1");
    assert.equal(writes.length, 2);
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE;
    else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
  }
});

test("DynamoDB message repository writes idempotently with validated tenant partition", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    messages: process.env.DYNAMODB_MESSAGES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_MESSAGES_TABLE = "JoyInboxMessages";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return {};
    }
  });
  try {
    const message = await records.saveMessage("workspace_1", "conversation_1", {
      id: "provider_message_1",
      timestamp: 1760000000000,
      text: "Hello",
      organizationId: "spoofed_workspace",
      PK: "ORG#spoofed"
    });
    assert.equal(message.PK, "ORG#workspace_1#CONVERSATION#conversation_1");
    assert.equal(message.organizationId, "workspace_1");
    assert.equal(message.messageId, "provider_message_1");
    assert.match(captured.ConditionExpression, /attribute_not_exists/);
    await assert.rejects(
      records.saveMessage("workspace_1", "conversation_1", { id: "bad", timestamp: -1 }),
      { statusCode: 400 }
    );
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prior.region;
    if (prior.messages === undefined) delete process.env.DYNAMODB_MESSAGES_TABLE;
    else process.env.DYNAMODB_MESSAGES_TABLE = prior.messages;
  }
});

test("DynamoDB table names must be configured explicitly", () => {
  const prior = process.env.DYNAMODB_CUSTOMERS_TABLE;
  delete process.env.DYNAMODB_CUSTOMERS_TABLE;
  assert.throws(() => dynamodb.getTableName("customers"), /DYNAMODB_CUSTOMERS_TABLE/);
  if (prior !== undefined) process.env.DYNAMODB_CUSTOMERS_TABLE = prior;
});

test("S3 object keys are generated under tenant prefixes and never use display filenames", () => {
  const key = media.buildMessageMediaKey({
    organizationId: "org_a",
    customerId: "customer_a",
    messageId: "message_a",
    objectId: "object_a"
  });
  assert.equal(key, "tenants/org_a/customers/customer_a/messages/message_a/object_a");
  assert.equal(media.buildQuickReplyImageKey({
    organizationId: "org_a",
    quickReplyId: "reply_a",
    objectId: "image_a"
  }), "tenants/org_a/quick-replies/reply_a/image_a");
  assert.throws(() => media.buildMessageMediaKey({
    organizationId: "../other",
    customerId: "customer_a",
    messageId: "message_a"
  }), { statusCode: 400 });
});


test("DynamoDB workspace context requires active workspace membership", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  dynamodb.setDocumentClientForTests({
    async send(command) {
      if (command.input.Key.SK === "WORKSPACE") {
        return { Item: { PK: "ORG#workspace_1", SK: "WORKSPACE", organizationId: "workspace_1", status: "active", createdBy: "owner_1" } };
      }
      return { Item: { PK: "ORG#workspace_1", SK: "MEMBER#user_1", uid: "user_1", role: "agent", status: "active" } };
    }
  });
  try {
    const context = await members.getWorkspaceContext({ uid: "user_1" }, "workspace_1");
    assert.equal(context.id, "workspace_1");
    assert.equal(context.role, "agent");
    await assert.rejects(members.getWorkspaceContext({}, "workspace_1"), { statusCode: 401 });
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});

test("DynamoDB member role changes atomically update membership and reverse pointer", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  const commands = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetCommand") {
        return { Item: { uid: "agent_1", role: "agent", status: "active" } };
      }
      return {};
    }
  });
  try {
    const result = await members.updateWorkspaceMemberRole(
      { id: "workspace_1", createdBy: "owner_1" },
      { uid: "owner_1", role: "owner" },
      { uid: "agent_1", role: "admin" }
    );
    assert.deepEqual(result, { uid: "agent_1", role: "admin" });
    const transaction = commands.find(command => command.constructor.name === "TransactWriteCommand");
    assert.equal(transaction.input.TransactItems.length, 3);
    assert.deepEqual(transaction.input.TransactItems.slice(0, 2).map(item => item.Update.Key), [
      { PK: "ORG#workspace_1", SK: "MEMBER#agent_1" },
      { PK: "USER#agent_1", SK: "ORG#workspace_1" }
    ]);
    assert.equal(transaction.input.TransactItems[2].Put.Item.action, "member.role_changed");
    assert.equal(transaction.input.TransactItems[2].Put.Item.targetUid, "agent_1");
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});


test("DynamoDB member audit history is tenant-scoped, newest-first and cursor-paginated", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return { Items: [{ id: "event_1", action: "member.removed", targetUid: "agent_1", createdAt: "2026-11-26T10:00:00.000Z" }], LastEvaluatedKey: { PK: "ORG#workspace_1", SK: "AUDIT#2026-11-26T10:00:00.000Z#event_1" } };
    }
  });
  try {
    const page = await members.listWorkspaceMemberAudit("workspace_1", { limit: 10 });
    assert.equal(page.events[0].action, "member.removed");
    assert.ok(page.nextCursor);
    assert.equal(captured.ScanIndexForward, false);
    assert.equal(captured.ExpressionAttributeValues[":skPrefix"], "AUDIT#");
    await assert.rejects(
      members.listWorkspaceMemberAudit("workspace_1", { cursor: Buffer.from(JSON.stringify({ PK: "ORG#other", SK: "AUDIT#bad" })).toString("base64url") }),
      { statusCode: 400 }
    );
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});


test("DynamoDB workspace invitation creation stores only a token hash and enforces role permissions", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE, frontend: process.env.FRONTEND_BASE_URL };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  process.env.FRONTEND_BASE_URL = "https://joy.example.com";
  const commands = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetCommand") return {};
      return {};
    }
  });
  try {
    const invitation = await invitations.createWorkspaceInvitation(
      { id: "workspace_1" },
      { uid: "owner_1", role: "owner" },
      { email: "TeSt@example.com", role: "agent" },
      { now: () => new Date("2026-11-26T10:00:00.000Z") }
    );
    assert.equal(invitation.email, "test@example.com");
    assert.equal(invitation.status, "pending");
    assert.equal(invitation.token.length, 43);
    const put = commands.find(command => command.constructor.name === "PutCommand").input;
    assert.equal(put.Item.PK, "ORG#workspace_1");
    assert.match(put.Item.SK, /^INVITATION#/);
    assert.equal(put.Item.tokenHash, crypto.createHash("sha256").update(invitation.token).digest("hex"));
    assert.equal(put.Item.token, undefined);
    assert.match(put.ConditionExpression, /expiresAt <= :now/);
    await assert.rejects(
      invitations.createWorkspaceInvitation({ id: "workspace_1" }, { uid: "admin_1", role: "admin" }, { email: "new@example.com", role: "admin" }),
      { statusCode: 403 }
    );
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
    if (prior.frontend === undefined) delete process.env.FRONTEND_BASE_URL; else process.env.FRONTEND_BASE_URL = prior.frontend;
  }
});

test("DynamoDB invitation acceptance atomically consumes invite, adds member and enforces seat capacity", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const commands = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name !== "GetCommand") return {};
      const sk = command.input.Key.SK;
      if (sk === "WORKSPACE") return { Item: { PK: "ORG#workspace_1", SK: "WORKSPACE", name: "Example", status: "active", subscriptionStatus: "trialing", seatLimit: 3, activeSeatCount: 1 } };
      if (sk.startsWith("INVITATION#")) return { Item: { PK: "ORG#workspace_1", SK: sk, email: "agent@example.com", role: "agent", status: "pending", tokenHash, expiresAt: "2026-11-30T00:00:00.000Z", invitedBy: "owner_1" } };
      return {};
    }
  });
  try {
    const result = await invitations.acceptWorkspaceInvitation("workspace_1", token, {
      uid: "agent_1", email: "agent@example.com", email_verified: true
    }, { now: () => new Date("2026-11-26T10:00:00.000Z") });
    assert.deepEqual(result, { organizationId: "workspace_1", role: "agent", status: "active" });
    const transaction = commands.find(command => command.constructor.name === "TransactWriteCommand").input;
    assert.equal(transaction.TransactItems.length, 4);
    assert.match(transaction.TransactItems[0].Update.ConditionExpression, /activeSeatCount < seatLimit/);
    assert.equal(transaction.TransactItems[1].Put.Item.SK, "MEMBER#agent_1");
    assert.equal(transaction.TransactItems[2].Put.Item.SK, "ORG#workspace_1");
    assert.match(transaction.TransactItems[3].Update.UpdateExpression, /REMOVE tokenHash/);
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});


test("DynamoDB billing validates Stripe event IDs and workspace IDs", async () => {
  assert.deepEqual(billing.eventKey("evt_12345678"), {
    PK: "BILLING#STRIPE",
    SK: "EVENT#evt_12345678"
  });
  assert.throws(() => billing.eventKey("bad_event"), { statusCode: 400 });
  await assert.rejects(billing.writeWorkspaceSubscription("../other", {}), { statusCode: 400 });
});

test("DynamoDB billing subscription write enforces customer ownership and maps seat limits", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  const commands = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetCommand") {
        return { Item: {
          PK: "ORG#workspace_1", SK: "WORKSPACE", organizationId: "workspace_1",
          status: "active", stripeCustomerId: "cus_existing", trialUsed: false
        } };
      }
      return { Attributes: {} };
    }
  });
  try {
    await assert.rejects(billing.writeWorkspaceSubscription("workspace_1", {
      id: "sub_12345678", customer: "cus_other", status: "active",
      items: { data: [{ price: { id: "price_growth" } }] }
    }, { plans: [{ key: "growth", priceId: "price_growth", annualPriceId: "" }] }), { statusCode: 409 });
    assert.equal(commands.filter(command => command.constructor.name === "UpdateCommand").length, 0);

    const result = await billing.writeWorkspaceSubscription("workspace_1", {
      id: "sub_12345678", customer: "cus_existing", status: "active",
      current_period_start: 1790000000, current_period_end: 1792592000,
      trial_end: 1790600000,
      items: { data: [{ price: { id: "price_growth" } }] }
    }, { plans: [{ key: "growth", priceId: "price_growth", annualPriceId: "" }] });
    assert.equal(result.seatLimit, 5);
    const update = commands.find(command => command.constructor.name === "UpdateCommand").input;
    assert.match(update.UpdateExpression, /seatLimit = :seatLimit/);
    assert.equal(update.ExpressionAttributeValues[":status"], "active");
    assert.equal(update.ExpressionAttributeValues[":true"], true);
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});


test("DynamoDB Stripe webhook persists subscription and marks event processed", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  const commands = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetCommand") {
        return { Item: {
          PK: "ORG#workspace_1", SK: "WORKSPACE", organizationId: "workspace_1",
          status: "active", stripeCustomerId: "cus_1", trialUsed: false
        } };
      }
      return {};
    }
  });
  try {
    const result = await billing.processStripeWebhookEvent({
      id: "evt_12345678",
      type: "customer.subscription.updated",
      data: { object: {
        id: "sub_12345678", customer: "cus_1", status: "active",
        metadata: { organizationId: "workspace_1" },
        items: { data: [{ price: { id: "price_lite" } }] }
      } }
    }, {
      plans: [{ key: "lite", priceId: "price_lite", annualPriceId: "" }],
      now: () => new Date("2026-11-26T10:00:00.000Z")
    });
    assert.equal(result.processed, true);
    assert.equal(result.eventId, "evt_12345678");
    assert.ok(commands.some(command => command.constructor.name === "PutCommand" && command.input.Item.entityType === "STRIPE_EVENT"));
    const updates = commands.filter(command => command.constructor.name === "UpdateCommand");
    assert.equal(updates.length, 2);
    assert.ok(updates.some(command => command.input.UpdateExpression.includes("stripeSubscriptionId")));
    assert.ok(updates.some(command => command.input.UpdateExpression.includes("processedAt")));
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});


test("DynamoDB billing plan seat count follows configured catalog agent limits", () => {
  assert.equal(billing.PLAN_SEATS.growth, 5);
  assert.equal(billing.PLAN_SEATS.pro, 10);
});


test("DynamoDB billing exports the handlers wired by the API router", () => {
  assert.equal(typeof billing.processStripeWebhookEvent, "function");
  assert.equal(typeof billing.createCheckoutSession, "function");
  assert.equal(typeof billing.createPortalSession, "function");
  assert.equal(typeof billing.writeWorkspaceSubscription, "function");
});


test("DynamoDB WhatsApp connection keys isolate tenant credentials from global phone ownership", () => {
  assert.deepEqual(whatsapp.connectionKey("workspace_1", "123456789"), {
    PK: "ORG#workspace_1", SK: "WHATSAPP#PHONE#123456789"
  });
  assert.deepEqual(whatsapp.phoneOwnerKey("123456789"), {
    PK: "PHONE#123456789", SK: "CONNECTION"
  });
  assert.equal(typeof whatsapp.saveWhatsAppConnection, "function");
  assert.equal(typeof whatsapp.getWhatsAppCredentials, "function");
  assert.equal(typeof whatsapp.disconnectWhatsAppConnection, "function");
  assert.equal(typeof whatsapp.listWhatsAppConnections, "function");
});


test("DynamoDB WhatsApp phone ownership resolver verifies both global owner and tenant connection", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  const reads = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      reads.push(command.input.Key);
      if (command.constructor.name !== "GetCommand") return {};
      if (command.input.Key.PK === "PHONE#123456789") {
        return { Item: { PK: "PHONE#123456789", SK: "CONNECTION", organizationId: "workspace_1", status: "active" } };
      }
      return { Item: { PK: "ORG#workspace_1", SK: "WHATSAPP#PHONE#123456789", organizationId: "workspace_1", phoneNumberId: "123456789", connected: true } };
    }
  });
  try {
    assert.deepEqual(await whatsapp.resolvePhoneNumberOrganization("123456789"), { id: "workspace_1" });
    assert.deepEqual(reads, [
      { PK: "PHONE#123456789", SK: "CONNECTION" },
      { PK: "ORG#workspace_1", SK: "WHATSAPP#PHONE#123456789" }
    ]);
    await assert.rejects(whatsapp.resolvePhoneNumberOrganization("bad"), { statusCode: 400 });
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
  }
});

test("DynamoDB WhatsApp connection save uses one transaction and prevents cross-tenant phone takeover", async () => {
  const prior = { region: process.env.AWS_REGION, workspaces: process.env.DYNAMODB_WORKSPACES_TABLE, encryptionKey: process.env.TENANT_SECRET_ENCRYPTION_KEY };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_WORKSPACES_TABLE = "JoyInboxWorkspaces";
  process.env.TENANT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  let transaction;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      if (command.constructor.name === "TransactWriteCommand") transaction = command.input;
      return {};
    }
  });
  try {
    const saved = await whatsapp.saveWhatsAppConnection("workspace_1", {
      phoneNumberId: "123456789", accessToken: "EAA123456789abcdef", wabaId: "987654321",
      registrationPin: "123456"
    });
    assert.equal(saved.connected, true);
    assert.equal(transaction.TransactItems.length, 2);
    assert.equal(transaction.TransactItems[0].Put.Item.entityType, "WHATSAPP_CONNECTION");
    assert.match(transaction.TransactItems[1].Put.ConditionExpression, /organizationId = :org/);
    assert.match(transaction.TransactItems[1].Put.ConditionExpression, /#status = :disconnected/);
    assert.notEqual(transaction.TransactItems[0].Put.Item.accessToken, "EAA123456789abcdef");
    assert.notEqual(transaction.TransactItems[0].Put.Item.registrationPin, "123456");
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.workspaces === undefined) delete process.env.DYNAMODB_WORKSPACES_TABLE; else process.env.DYNAMODB_WORKSPACES_TABLE = prior.workspaces;
    if (prior.encryptionKey === undefined) delete process.env.TENANT_SECRET_ENCRYPTION_KEY; else process.env.TENANT_SECRET_ENCRYPTION_KEY = prior.encryptionKey;
  }
});


test("DynamoDB inbound WhatsApp writer atomically stores customer, conversation and provider message", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE,
    messages: process.env.DYNAMODB_MESSAGES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  process.env.DYNAMODB_MESSAGES_TABLE = "JoyInboxMessages";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return {};
    }
  });
  try {
    const timestamp = 1760000000000;
    const saved = await records.saveIncomingWhatsAppMessage("workspace_1", {
      conversationId: "919999999999",
      customerId: "919999999999",
      customerName: "Customer One",
      messageId: "wamid.HBgMOTE5OTk5OTk5OTk5FQIAEhgUM0VC",
      timestamp,
      phoneNumberId: "123456789012",
      type: "text",
      text: "Hello Joy Inbox"
    });
    assert.equal(saved, true);
    assert.equal(captured.TransactItems.length, 4);
    const [customer, conversation, message, pointer] = captured.TransactItems;
    assert.equal(customer.Update.Key.PK, "ORG#workspace_1");
    assert.equal(customer.Update.Key.SK, "CUSTOMER#919999999999");
    assert.match(customer.Update.UpdateExpression, /^SET /);
    assert.equal(customer.Update.ExpressionAttributeValues[":name"], "Customer One");
    assert.equal(conversation.Update.Key.PK, "ORG#workspace_1");
    assert.equal(conversation.Update.Key.SK, "CONVERSATION#919999999999");
    assert.match(conversation.Update.UpdateExpression, /lastMessage/);
    assert.equal(conversation.Update.ExpressionAttributeValues[":lastMessage"], "Hello Joy Inbox");
    assert.equal(message.Put.Item.PK, "ORG#workspace_1#CONVERSATION#919999999999");
    assert.equal(message.Put.Item.messageId, "wamid.HBgMOTE5OTk5OTk5OTk5FQIAEhgUM0VC");
    assert.equal(message.Put.Item.timestamp, timestamp);
    assert.equal(message.Put.Item.text, "Hello Joy Inbox");
    assert.match(message.Put.ConditionExpression, /attribute_not_exists/);
    assert.equal(pointer.Put.TableName, "JoyInboxCustomers");
    assert.equal(pointer.Put.Item.PK, "ORG#workspace_1");
    assert.equal(pointer.Put.Item.SK, "WHATSAPP_MESSAGE#wamid.HBgMOTE5OTk5OTk5OTk5FQIAEhgUM0VC");
    assert.equal(pointer.Put.Item.conversationId, "919999999999");
    assert.equal(pointer.Put.Item.timestamp, timestamp);
    assert.match(pointer.Put.ConditionExpression, /attribute_not_exists/);
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE;
    else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
    if (prior.messages === undefined) delete process.env.DYNAMODB_MESSAGES_TABLE;
    else process.env.DYNAMODB_MESSAGES_TABLE = prior.messages;
  }
});

test("DynamoDB inbound WhatsApp writer rejects malformed tenant, message ID and timestamp", async () => {
  await assert.rejects(
    records.saveIncomingWhatsAppMessage("../other", {
      conversationId: "919999999999", messageId: "wamid.abc", timestamp: 1760000000000
    }),
    { statusCode: 400 }
  );
  await assert.rejects(
    records.saveIncomingWhatsAppMessage("workspace_1", {
      conversationId: "919999999999", messageId: "bad/message", timestamp: 1760000000000
    }),
    { statusCode: 400 }
  );
  await assert.rejects(
    records.saveIncomingWhatsAppMessage("workspace_1", {
      conversationId: "919999999999", messageId: "wamid.abc", timestamp: -1
    }),
    { statusCode: 400 }
  );
});


test("DynamoDB inbound WhatsApp writer treats an existing provider message as an idempotent retry", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE,
    messages: process.env.DYNAMODB_MESSAGES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  process.env.DYNAMODB_MESSAGES_TABLE = "JoyInboxMessages";
  const calls = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "TransactWriteCommand") {
        const error = new Error("Conditional write already exists");
        error.name = "TransactionCanceledException";
        throw error;
      }
      if (command.constructor.name === "GetCommand") {
        assert.equal(command.input.ConsistentRead, true);
        return { Item: { entityType: "MESSAGE", messageId: "wamid.retry" } };
      }
      throw new Error("Unexpected DynamoDB command.");
    }
  });
  try {
    const saved = await records.saveIncomingWhatsAppMessage("workspace_1", {
      conversationId: "919999999999",
      customerId: "919999999999",
      messageId: "wamid.retry",
      timestamp: 1760000000000,
      type: "text",
      text: "Retry"
    });
    assert.equal(saved, false);
    assert.deepEqual(calls.map(command => command.constructor.name), [
      "TransactWriteCommand", "GetCommand"
    ]);
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE;
    else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
    if (prior.messages === undefined) delete process.env.DYNAMODB_MESSAGES_TABLE;
    else process.env.DYNAMODB_MESSAGES_TABLE = prior.messages;
  }
});


test("DynamoDB WhatsApp message pointer lookup is tenant-scoped and strongly consistent", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return { Item: { entityType: "WHATSAPP_MESSAGE_POINTER", organizationId: "workspace_1" } };
    }
  });
  try {
    const pointer = await records.getWhatsAppMessagePointer("workspace_1", "wamid.status:1");
    assert.equal(pointer.organizationId, "workspace_1");
    assert.equal(captured.TableName, "JoyInboxCustomers");
    assert.deepEqual(captured.Key, {
      PK: "ORG#workspace_1",
      SK: "WHATSAPP_MESSAGE#wamid.status:1"
    });
    assert.equal(captured.ConsistentRead, true);
    await assert.rejects(
      records.getWhatsAppMessagePointer("workspace_1", "../invalid"),
      { statusCode: 400 }
    );
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE;
    else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
  }
});


test("DynamoDB WhatsApp delivery status updates the indexed message without status regression", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE,
    messages: process.env.DYNAMODB_MESSAGES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  process.env.DYNAMODB_MESSAGES_TABLE = "JoyInboxMessages";
  const calls = [];
  dynamodb.setDocumentClientForTests({
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "GetCommand") {
        return { Item: {
          entityType: "WHATSAPP_MESSAGE_POINTER",
          organizationId: "workspace_1",
          conversationId: "919999999999",
          timestamp: 1760000000000
        } };
      }
      if (command.constructor.name === "UpdateCommand") return { Attributes: { status: "delivered" } };
      throw new Error("Unexpected DynamoDB command.");
    }
  });
  try {
    const updated = await records.updateWhatsAppMessageStatus(
      "workspace_1", "wamid.status:1", "delivered", 1760000005000
    );
    assert.equal(updated, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].input.Key, {
      PK: "ORG#workspace_1",
      SK: "WHATSAPP_MESSAGE#wamid.status:1"
    });
    assert.equal(calls[1].input.TableName, "JoyInboxMessages");
    assert.deepEqual(calls[1].input.Key, {
      PK: "ORG#workspace_1#CONVERSATION#919999999999",
      SK: "MESSAGE#0001760000000000#wamid.status:1"
    });
    assert.equal(calls[1].input.ExpressionAttributeValues[":status"], "delivered");
    assert.equal(calls[1].input.ExpressionAttributeValues[":rank"], 2);
    assert.match(calls[1].input.ConditionExpression, /statusRank < :rank/);
    assert.match(calls[1].input.ConditionExpression, /#status = :status AND statusRank = :rank/);
    assert.equal(calls[1].input.ExpressionAttributeValues[":statusUpdatedAt"], 1760000005000);
    await assert.rejects(
      records.updateWhatsAppMessageStatus("workspace_1", "wamid.status:1", "queued"),
      { statusCode: 400 }
    );
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE; else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
    if (prior.messages === undefined) delete process.env.DYNAMODB_MESSAGES_TABLE; else process.env.DYNAMODB_MESSAGES_TABLE = prior.messages;
  }
});


test("DynamoDB outgoing WhatsApp writer atomically stores message and delivery pointer", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE,
    messages: process.env.DYNAMODB_MESSAGES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  process.env.DYNAMODB_MESSAGES_TABLE = "JoyInboxMessages";
  let captured;
  dynamodb.setDocumentClientForTests({
    async send(command) {
      captured = command.input;
      return {};
    }
  });
  try {
    const saved = await records.saveOutgoingWhatsAppMessage("workspace_1", "919999999999", {
      messageId: "wamid.outgoing.1",
      timestamp: 1760000001000,
      text: "Reply from Joy Inbox",
      phoneNumberId: "123456789012"
    });
    assert.equal(saved.status, "sent");
    assert.equal(saved.direction, "outgoing");
    assert.equal(captured.TransactItems.length, 2);
    const [message, pointer] = captured.TransactItems;
    assert.equal(message.Put.TableName, "JoyInboxMessages");
    assert.equal(message.Put.Item.messageId, "wamid.outgoing.1");
    assert.equal(message.Put.Item.statusRank, 1);
    assert.equal(pointer.Put.TableName, "JoyInboxCustomers");
    assert.equal(pointer.Put.Item.SK, "WHATSAPP_MESSAGE#wamid.outgoing.1");
    assert.equal(pointer.Put.Item.conversationId, "919999999999");
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE; else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
    if (prior.messages === undefined) delete process.env.DYNAMODB_MESSAGES_TABLE; else process.env.DYNAMODB_MESSAGES_TABLE = prior.messages;
  }
});


test("DynamoDB outgoing WhatsApp writer returns the existing message on a duplicate retry", async () => {
  const prior = {
    region: process.env.AWS_REGION,
    customers: process.env.DYNAMODB_CUSTOMERS_TABLE,
    messages: process.env.DYNAMODB_MESSAGES_TABLE
  };
  process.env.AWS_REGION = "ap-south-1";
  process.env.DYNAMODB_CUSTOMERS_TABLE = "JoyInboxCustomers";
  process.env.DYNAMODB_MESSAGES_TABLE = "JoyInboxMessages";
  const existing = {
    PK: "ORG#workspace_1#CONVERSATION#919999999999",
    SK: "MESSAGE#0001760000001000#wamid.outgoing.duplicate",
    organizationId: "workspace_1",
    messageId: "wamid.outgoing.duplicate",
    status: "sent"
  };
  dynamodb.setDocumentClientForTests({
    async send(command) {
      if (command.constructor.name === "TransactWriteCommand") {
        const error = new Error("Conditional transaction conflict");
        error.name = "TransactionCanceledException";
        throw error;
      }
      if (command.constructor.name === "GetCommand") return { Item: existing };
      throw new Error("Unexpected DynamoDB command.");
    }
  });
  try {
    const saved = await records.saveOutgoingWhatsAppMessage("workspace_1", "919999999999", {
      messageId: "wamid.outgoing.duplicate",
      timestamp: 1760000001000,
      text: "same send retry"
    });
    assert.equal(saved, existing);
    assert.equal(saved.status, "sent");
  } finally {
    dynamodb.setDocumentClientForTests(null);
    if (prior.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prior.region;
    if (prior.customers === undefined) delete process.env.DYNAMODB_CUSTOMERS_TABLE; else process.env.DYNAMODB_CUSTOMERS_TABLE = prior.customers;
    if (prior.messages === undefined) delete process.env.DYNAMODB_MESSAGES_TABLE; else process.env.DYNAMODB_MESSAGES_TABLE = prior.messages;
  }
});
