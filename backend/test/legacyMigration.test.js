"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeLegacyMessage,
  sanitizeLegacyContact,
  sanitizeLegacyQuickReply,
  runLegacyMigration
} = require("../src/legacyMigration");
const { parseArguments } = require("../scripts/migrate-legacy-to-tenant");

test("legacy message migration strips durable media paths and raw media bytes", () => {
  const result = sanitizeLegacyMessage({
    text: "Hello",
    mediaId: "meta-media-123",
    mediaStoragePath: "customer-uploads/private.jpg",
    imageStoragePath: "customer-uploads/another-private.jpg",
    imageUrl: "https://storage.example/customer-profile.jpg",
    signedUrl: "https://storage.example/private",
    base64: "aGVsbG8=",
    mimeType: "image/jpeg",
    timestamp: new Date("2026-01-01T00:00:00Z")
  });
  assert.equal(result.text, "Hello");
  assert.equal(result.mediaId, "meta-media-123");
  assert.equal(result.mediaStoragePath, undefined);
  assert.equal(result.imageStoragePath, undefined);
  assert.equal(result.imageUrl, undefined);
  assert.equal(result.signedUrl, undefined);
  assert.equal(result.base64, undefined);
  assert.equal(result.migratedFromLegacy, true);
});

test("legacy message without a Meta media ID is marked unavailable rather than copying storage", () => {
  const result = sanitizeLegacyMessage({
    text: "Photo",
    mediaStoragePath: "customer-uploads/photo.jpg",
    mimeType: "image/jpeg"
  });
  assert.equal(result.mediaUnavailable, true);
  assert.equal(result.mimeType, undefined);
});

test("legacy contacts copy only approved contact fields", () => {
  const result = sanitizeLegacyContact({
    name: "A Customer",
    phone: "+919876543210",
    email: "a@example.com",
    notes: "Asked for details",
    privateToken: "must-not-copy",
    mediaStoragePath: "private/path"
  });
  assert.equal(result.name, "A Customer");
  assert.equal(result.phone, "+919876543210");
  assert.equal(result.privateToken, undefined);
  assert.equal(result.mediaStoragePath, undefined);
});

test("legacy quick replies do not copy storage URLs or image bytes", () => {
  const result = sanitizeLegacyQuickReply({
    title: "Welcome",
    shortcut: "welcome",
    message: "Hello!",
    imageStoragePath: "quick-replies/welcome.png",
    imageUrl: "https://storage.example/welcome.png",
    base64: "aGVsbG8="
  });
  assert.equal(result.title, "Welcome");
  assert.equal(result.imageStoragePath, undefined);
  assert.equal(result.imageUrl, undefined);
  assert.equal(result.base64, undefined);
  assert.equal(result.imageUnavailable, true);
});

test("migration CLI defaults to dry-run and requires explicit --execute", () => {
  assert.deepEqual(parseArguments(["--organization=org_123", "--owner=uid_123"]), {
    execute: false, organizationId: "org_123", ownerUid: "uid_123"
  });
  assert.equal(parseArguments(["--organization=org_123", "--owner=uid_123", "--execute"]).execute, true);
  assert.throws(() => parseArguments(["--delete-production"]), /Unknown argument/);
});

test("legacy migration dry-run validates organization ownership and performs no writes", async () => {
  let writes = 0;
  const organizationRef = {
    async get() { return { exists: true, data: () => ({ status: "active" }) }; },
    collection(name) {
      if (name === "members") return { doc(uid) {
        assert.equal(uid, "uid_123");
        return { async get() { return { exists: true, data: () => ({ status: "active", role: "owner" }) }; } };
      } };
      if (name === "settings") return { doc(id) {
        assert.equal(id, "legacyMigration");
        return { async get() { return { exists: false }; } };
      } };
      throw new Error("Unexpected organization collection " + name);
    }
  };
  const db = {
    collection(name) {
      if (name === "organizations") return { doc(id) {
        assert.equal(id, "org_123");
        return organizationRef;
      } };
      if (name === "chats") return { async get() { return { size: 2, docs: [] }; } };
      if (name === "users") return { doc(uid) {
        assert.equal(uid, "uid_123");
        return { collection(child) {
          if (child === "contacts") return { async get() { return { size: 3, docs: [] }; } };
          if (child === "quickReplies") return { async get() { return { size: 4, docs: [] }; } };
          if (child === "settings") return { doc(id) {
            assert.equal(id, "greeting");
            return { async get() { return { exists: true }; } };
          } };
          throw new Error("Unexpected user collection " + child);
        } };
      } };
      throw new Error("Unexpected root collection " + name);
    },
    batch() { writes += 1; throw new Error("Dry-run must never create a batch."); }
  };
  const result = await runLegacyMigration(db, { organizationId: "org_123", ownerUid: "uid_123" });
  assert.equal(result.execute, false);
  assert.deepEqual(result.source, { chats: 2, messages: 0, contacts: 3, quickReplies: 4, greetingSettings: 1 });
  assert.equal(writes, 0);
});

test("legacy migration refuses a target user who is not an active organization owner", async () => {
  const organizationRef = {
    async get() { return { exists: true, data: () => ({ status: "active" }) }; },
    collection(name) {
      assert.equal(name, "members");
      return { doc() { return { async get() {
        return { exists: true, data: () => ({ status: "active", role: "agent" }) };
      } }; } };
    }
  };
  const db = {
    collection(name) {
      assert.equal(name, "organizations");
      return { doc() { return organizationRef; } };
    }
  };
  await assert.rejects(
    runLegacyMigration(db, { organizationId: "org_123", ownerUid: "uid_123", execute: true }),
    /active owner/
  );
});
