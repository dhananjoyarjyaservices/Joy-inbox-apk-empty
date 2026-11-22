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
