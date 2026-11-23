const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isValidBase64,
  getAllowedTemplateMediaMimeTypes,
  isAllowedTemplateMedia
} = require("../src/templateValidation");

test("template media base64 validation rejects malformed and oversized data", () => {
  assert.equal(isValidBase64(Buffer.from("hello").toString("base64")), true);
  assert.equal(isValidBase64(""), false);
  assert.equal(isValidBase64("aGVsbG8"), false);
  assert.equal(isValidBase64("aGVs!G8="), false);
  assert.equal(isValidBase64("aGVsbG8=", 4), false);
  assert.equal(isValidBase64(Buffer.from([0, 1, 2]).toString("base64")), true);
});

test("template media MIME validation matches the approved header format", () => {
  assert.deepEqual(getAllowedTemplateMediaMimeTypes("IMAGE"), ["image/jpeg", "image/png"]);
  assert.deepEqual(getAllowedTemplateMediaMimeTypes("VIDEO"), ["video/mp4"]);
  assert.deepEqual(getAllowedTemplateMediaMimeTypes("DOCUMENT"), ["application/pdf"]);
  assert.deepEqual(getAllowedTemplateMediaMimeTypes("TEXT"), []);
  assert.equal(isAllowedTemplateMedia("image/png; charset=binary", "IMAGE"), true);
  assert.equal(isAllowedTemplateMedia("image/gif", "IMAGE"), false);
  assert.equal(isAllowedTemplateMedia("video/quicktime", "VIDEO"), false);
  assert.equal(isAllowedTemplateMedia("application/pdf", "DOCUMENT"), true);
});
