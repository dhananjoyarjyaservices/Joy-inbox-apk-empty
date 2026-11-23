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
  });

  const ownerDb = testEnv.authenticatedContext("owner_a").firestore();
  const agentDb = testEnv.authenticatedContext("agent_a").firestore();
  const otherTenantDb = testEnv.authenticatedContext("owner_b").firestore();
  const disabledDb = testEnv.authenticatedContext("disabled_a").firestore();
  const unknownRoleDb = testEnv.authenticatedContext("unknown_a").firestore();
  const suspendedOrgDb = testEnv.authenticatedContext("owner_inactive").firestore();
  const anonymousDb = testEnv.unauthenticatedContext().firestore();

  await assertSucceeds(getDoc(doc(ownerDb, "organizations/org_a")));
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

  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/chats/new_chat"), { text: "client write" }));
  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/contacts/new_contact"), { name: "client write" }));
  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/quickReplies/new_reply"), { title: "client write" }));
  await assertFails(setDoc(doc(ownerDb, "organizations/org_a/members/new_member"), { role: "admin" }));
  await assertFails(getDoc(doc(ownerDb, "organizations/org_a/chats/chat_a/sendRequests/request_a")));
  await assertFails(getDocs(collection(otherTenantDb, "organizations/org_a/chats")));
});
