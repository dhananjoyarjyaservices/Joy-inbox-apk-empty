const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, collection, getDocs } = require("firebase/firestore");

const projectId = "demo-joy-inbox";
const rules = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
let testEnv;

test("Firestore emulator enforces Joy Inbox tenant boundaries", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST
}, async (t) => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules }
  });

  t.after(async () => {
    await testEnv.cleanup();
  });

  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "organizations/org_a"), { status: "active", name: "Workspace A" });
    await setDoc(doc(db, "organizations/org_b"), { status: "active", name: "Workspace B" });
    await setDoc(doc(db, "organizations/org_inactive"), { status: "suspended", name: "Suspended Workspace" });
    await setDoc(doc(db, "organizations/org_a/members/owner_a"), { status: "active", role: "owner" });
    await setDoc(doc(db, "organizations/org_a/invitations/secret_invite"), { status: "pending", tokenHash: "server-only-hash" });
    await setDoc(doc(db, "users/owner_a/organizations/org_a"), { organizationId: "org_a" });
    await setDoc(doc(db, "users/owner_a/organizations/org_b"), { organizationId: "org_b" });
    await setDoc(doc(db, "users/owner_b/organizations/org_a"), { organizationId: "org_a" });
    await setDoc(doc(db, "organizations/org_a/members/agent_a"), { status: "active", role: "agent" });
    await setDoc(doc(db, "organizations/org_a/members/disabled_a"), { status: "disabled", role: "agent" });
    await setDoc(doc(db, "organizations/org_a/members/unknown_a"), { status: "active", role: "superadmin" });
    await setDoc(doc(db, "organizations/org_b/members/owner_b"), { status: "active", role: "owner" });
    await setDoc(doc(db, "organizations/org_inactive/members/owner_inactive"), { status: "active", role: "owner" });
    await setDoc(doc(db, "organizations/org_inactive/chats/chat_inactive"), { customerPhone: "+15557654321" });
    await setDoc(doc(db, "organizations/org_a/chats/chat_a"), { customerPhone: "+15551234567" });
    await setDoc(doc(db, "organizations/org_a/chats/chat_a/messages/message_a"), { text: "Tenant A private message" });
    await setDoc(doc(db, "organizations/org_a/contacts/contact_a"), { name: "Private Contact A" });
    await setDoc(doc(db, "organizations/org_a/quickReplies/reply_a"), { title: "Private Reply A" });
    await setDoc(doc(db, "organizations/org_a/settings/whatsapp"), { accessToken: "server-only" });
    await setDoc(doc(db, "organizations/org_a/campaigns/campaign_a"), { name: "Private campaign", status: "draft" });
    await setDoc(doc(db, "organizations/org_a/campaigns/campaign_a/recipients/recipient_a"), { phone: "15551234567" });
    await setDoc(doc(db, "organizations/org_a/campaignSuppressions/suppression_a"), { status: "opted_out" });
    await setDoc(doc(db, "organizations/org_a/billing/subscription"), { status: "active", stripeCustomerId: "cus_private" });
    await setDoc(doc(db, "organizations/org_a/chats/chat_a/internalNotes/note_a"), { text: "Private team note", visibility: "internal" });
    await setDoc(doc(db, "stripeWebhookEvents/evt_123456789"), { status: "processed" });
    await setDoc(doc(db, "chats/legacy_chat"), { customerPhone: "+15550001111" });
    await setDoc(doc(db, "deletedChats/legacy_chat"), { deletedAt: new Date() });
    await setDoc(doc(db, "whatsappPhoneNumbers/legacy_number"), { phoneNumberId: "123456789012345" });
    await setDoc(doc(db, "users/agent_a/privateProfiles/profile_a"), { email: "private@example.test" });
  });

  const ownerDb = testEnv.authenticatedContext("owner_a").firestore();
  const legacyOwnerDb = testEnv.authenticatedContext("Vy49nGnw74gR5SFHmjN0DOQ2QFE3").firestore();
  const agentDb = testEnv.authenticatedContext("agent_a").firestore();
  const otherTenantDb = testEnv.authenticatedContext("owner_b").firestore();
  const disabledDb = testEnv.authenticatedContext("disabled_a").firestore();
  const unknownRoleDb = testEnv.authenticatedContext("unknown_a").firestore();
  const suspendedOrgDb = testEnv.authenticatedContext("owner_inactive").firestore();
  const anonymousDb = testEnv.unauthenticatedContext().firestore();

  await assertSucceeds(getDoc(doc(ownerDb, "organizations/org_a")));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/invitations/secret_invite")));
  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/invitations/client_invite"), { tokenHash: "client-write" }));
  await assertSucceeds(getDoc(doc(ownerDb, "users/owner_a/organizations/org_a")));
  await assertFails(getDoc(doc(ownerDb, "users/owner_a/organizations/org_b")));
  await assertFails(getDoc(doc(otherTenantDb, "users/owner_b/organizations/org_a")));
  await assertSucceeds(getDoc(doc(ownerDb, "organizations/org_a/chats/chat_a")));
  await assertSucceeds(getDoc(doc(agentDb, "organizations/org_a/chats/chat_a/messages/message_a")));
  await assertSucceeds(getDoc(doc(agentDb, "organizations/org_a/contacts/contact_a")));
  await assertSucceeds(getDoc(doc(agentDb, "organizations/org_a/quickReplies/reply_a")));
  await assertSucceeds(getDoc(doc(agentDb, "organizations/org_a/members/agent_a")));

  await assertFails(getDoc(doc(otherTenantDb, "organizations/org_a")));
  await assertFails(getDoc(doc(otherTenantDb, "organizations/org_a/chats/chat_a")));
  await assertFails(getDoc(doc(otherTenantDb, "organizations/org_a/chats/chat_a/messages/message_a")));
  await assertFails(getDoc(doc(otherTenantDb, "organizations/org_a/contacts/contact_a")));
  await assertFails(getDoc(doc(otherTenantDb, "organizations/org_a/quickReplies/reply_a")));
  await assertFails(getDoc(doc(agentDb, "organizations/org_a/members/owner_a")));
  await assertFails(getDoc(doc(disabledDb, "organizations/org_a/chats/chat_a")));
  await assertFails(getDoc(doc(unknownRoleDb, "organizations/org_a/chats/chat_a")));
  await assertFails(getDoc(doc(suspendedOrgDb, "organizations/org_inactive/chats/chat_inactive")));
  await assertFails(getDoc(doc(anonymousDb, "organizations/org_a/chats/chat_a")));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/settings/whatsapp")));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/campaigns/campaign_a")));
  await assertFails(getDoc(doc(agentDb, "organizations/org_a/campaigns/campaign_a/recipients/recipient_a")));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/campaignSuppressions/suppression_a")));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/billing/subscription")));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/chats/chat_a/internalNotes/note_a")));
  await assertFails(getDoc(doc(agentDb, "organizations/org_a/chats/chat_a/internalNotes/note_a")));
  await assertFails(getDoc(doc(ownerDb, "stripeWebhookEvents/evt_123456789")));
  // Legacy root collections remain owner-only and read-only during migration.
  await assertSucceeds(getDoc(doc(legacyOwnerDb, "chats/legacy_chat")));
  await assertSucceeds(getDoc(doc(legacyOwnerDb, "deletedChats/legacy_chat")));
  await assertSucceeds(getDoc(doc(legacyOwnerDb, "whatsappPhoneNumbers/legacy_number")));
  await assertFails(getDoc(doc(agentDb, "chats/legacy_chat")));
  await assertFails(getDoc(doc(agentDb, "deletedChats/legacy_chat")));
  await assertFails(getDoc(doc(agentDb, "whatsappPhoneNumbers/legacy_number")));
  await assertFails(getDoc(doc(agentDb, "users/agent_a/privateProfile")));
  await assertFails(setDoc(doc(legacyOwnerDb, "chats/legacy_chat"), { customerPhone: "+15559999999" }));

  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/chats/new_chat"), { text: "client write" }));
  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/contacts/new_contact"), { name: "client write" }));
  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/quickReplies/new_reply"), { title: "client write" }));
  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/members/new_member"), { role: "admin" }));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/chats/chat_a/sendRequests/request_a")));
  await assertFails(getDocs(collection(otherTenantDb, "organizations/org_a/chats")));
});
