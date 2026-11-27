"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createS3MediaStore } = require("../src/aws/s3MediaStore");

class Command { constructor(input) { this.input = input; } }
const commands = {
  PutObjectCommand: class extends Command {},
  GetObjectCommand: class extends Command {},
  DeleteObjectCommand: class extends Command {}
};
function setup() {
  const calls = [];
  const client = { async send(command) { calls.push(command); return {}; } };
  const signed = [];
  const getSignedUrl = async (_client, command, options) => {
    signed.push({ command, options });
    return "https://signed.example/media";
  };
  const store = createS3MediaStore({ client, commands, getSignedUrl, bucketName: "joy-inbox-private-media", expiresIn: 300 });
  return { store, calls, signed };
}

test("S3 media keys are tenant scoped and uploads request server-side encryption", async () => {
  const { store, calls } = setup();
  const result = await store.save({
    organizationId: "org_a", chatId: "chat_a", mediaId: "media_1",
    body: Buffer.from("image"), contentType: "image/png", contentLength: 5
  });
  assert.equal(result.key, "organizations/org_a/chats/chat_a/media/media_1");
  assert.equal(calls[0].input.ServerSideEncryption, "AES256");
  assert.equal(calls[0].input.Metadata.organizationid, "org_a");
  assert.equal(calls[0].input.ACL, undefined);
});

test("S3 media store creates short-lived signed download URLs", async () => {
  const { store, signed } = setup();
  const url = await store.signedDownload({ organizationId: "org_a", chatId: "chat_a", mediaId: "media_1" });
  assert.equal(url, "https://signed.example/media");
  assert.equal(signed[0].options.expiresIn, 300);
  assert.equal(signed[0].command.input.Key, "organizations/org_a/chats/chat_a/media/media_1");
});

test("S3 media store rejects invalid tenant IDs, media types and oversized uploads", async () => {
  const { store, calls } = setup();
  await assert.rejects(store.signedDownload({ organizationId: "org/a", chatId: "chat_a", mediaId: "media_1" }), { statusCode: 400 });
  await assert.rejects(store.save({
    organizationId: "org_a", chatId: "chat_a", mediaId: "media_1",
    body: Buffer.from("x"), contentType: "text/html", contentLength: 1
  }), { statusCode: 415 });
  await assert.rejects(store.save({
    organizationId: "org_a", chatId: "chat_a", mediaId: "media_1",
    body: Buffer.alloc(16 * 1024 * 1024 + 1), contentType: "image/png", contentLength: 16 * 1024 * 1024 + 1
  }), { statusCode: 413 });
  assert.equal(calls.length, 0);
});

test("S3 media delete remains scoped to the requested organization and chat", async () => {
  const { store, calls } = setup();
  await store.remove({ organizationId: "org_b", chatId: "chat_b", mediaId: "media_2" });
  assert.equal(calls[0].input.Key, "organizations/org_b/chats/chat_b/media/media_2");
});
