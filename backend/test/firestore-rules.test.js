const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rules = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

test("legacy owner wildcard reads are limited to explicitly approved root collections", () => {
  assert.match(rules, /collection in \["chats", "deletedChats", "whatsappPhoneNumbers"\]/);
  assert.doesNotMatch(rules, /collection != "organizations"/);
  assert.doesNotMatch(rules, /collection != "fcmTokens"/);
});

test("user-owned contacts and quick replies retain per-user ownership checks", () => {
  assert.match(rules, /match \/users\/\{userId\}\/quickReplies\/\{replyId\}/);
  assert.match(rules, /match \/users\/\{userId\}\/contacts\/\{contactId\}/);
  assert.match(rules, /request\.auth\.uid == userId/);
});

test("tenant organization writes remain server-only", () => {
  assert.match(rules, /match \/organizations\/\{organizationId\}[\s\S]*?allow write: if false;/);
  assert.match(rules, /match \/chats\/\{chatId\}[\s\S]*?allow write: if false;/);
});

test("tenant Firestore reads require an active recognized membership role", () => {
  assert.match(rules, /\.data\.status == "active"/);
  assert.match(rules, /\.data\.role in \["owner", "admin", "agent"\]/);
});

test("tenant chat, message, contact and quick reply reads all use the same membership gate", () => {
  const protectedPaths = [
    /match \/chats\/\{chatId\} \{[\s\S]*?allow read: if isActiveOrganizationMember\(organizationId\);/,
    /match \/messages\/\{messageId\} \{[\s\S]*?allow read: if isActiveOrganizationMember\(organizationId\);/,
    /match \/contacts\/\{contactId\} \{[\s\S]*?allow read: if isActiveOrganizationMember\(organizationId\);/,
    /match \/quickReplies\/\{replyId\} \{[\s\S]*?allow read: if isActiveOrganizationMember\(organizationId\);/
  ];
  for (const pattern of protectedPaths) assert.match(rules, pattern);
});

test("tenant writes are denied for organization metadata, chats, messages, contacts, replies and members", () => {
  const tenantBlock = rules.slice(
    rules.indexOf("match /organizations/{organizationId}"),
    rules.indexOf("// Legacy single-owner data")
  );
  assert.ok(tenantBlock.length > 0);
  assert.equal((tenantBlock.match(/allow write: if false;/g) || []).length, 6);
  assert.doesNotMatch(tenantBlock, /allow (?:create|update|delete|write): if true/);
});

test("organization membership reads are limited to the requesting member's own record", () => {
  const memberBlock = rules.slice(rules.indexOf("match /members/{memberUid}"), rules.indexOf("// Legacy single-owner data"));
  assert.match(memberBlock, /request\.auth\.uid == memberUid/);
  assert.match(memberBlock, /isActiveOrganizationMember\(organizationId\)/);
  assert.match(memberBlock, /allow write: if false;/);
});

test("unrecognized roles and missing authentication cannot satisfy the tenant membership gate", () => {
  const gateStart = rules.indexOf("function isActiveOrganizationMember");
  const gateEnd = rules.indexOf("\n    }", gateStart) + 6;
  const gate = rules.slice(gateStart, gateEnd);
  assert.match(gate, /request\.auth != null/);
  assert.match(gate, /\.data\.role in \["owner", "admin", "agent"\]/);
  assert.match(gate, /\.data\.status == "active"/);
});

test("workspace switcher index reads also require active membership in that workspace", () => {
  const block = rules.slice(rules.indexOf("match /users/{userId}/organizations/{organizationId}"), rules.indexOf("// Organization metadata"));
  assert.match(block, /request\\.auth\\.uid == userId/);
  assert.match(block, /isActiveOrganizationMember\\(organizationId\\)/);
});
