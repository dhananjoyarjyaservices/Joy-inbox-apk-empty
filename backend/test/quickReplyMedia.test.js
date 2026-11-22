const test = require("node:test");
const assert = require("node:assert/strict");
const {
  QUICK_REPLY_IMAGE_MAX_BYTES,
  quickReplyImagePath,
  validateQuickReplyImage
} = require("../src/media");

test("builds tenant-scoped Quick Reply image paths from safe IDs", () => {
  assert.equal(
    quickReplyImagePath("org_123", "reply-456"),
    "organizations/org_123/quickReplies/reply-456"
  );
  assert.throws(() => quickReplyImagePath("../other", "reply"), { statusCode: 400 });
  assert.throws(() => quickReplyImagePath("org", "../../private"), { statusCode: 400 });
});

test("accepts JPEG and PNG only when file signatures match", () => {
  assert.equal(validateQuickReplyImage("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(validateQuickReplyImage("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.throws(() => validateQuickReplyImage("image/jpeg", Buffer.from("not an image")), { statusCode: 400 });
  assert.throws(() => validateQuickReplyImage("image/gif", Buffer.from([0x47, 0x49, 0x46])), { statusCode: 400 });
});

test("enforces the 3 MB Quick Reply image limit", () => {
  const oversized = Buffer.alloc(QUICK_REPLY_IMAGE_MAX_BYTES + 1);
  oversized.set([0xff, 0xd8, 0xff]);
  assert.throws(() => validateQuickReplyImage("image/jpeg", oversized), { statusCode: 400 });
});
