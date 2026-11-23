function isValidBase64(value, maxLength = 5_600_000) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value;
}

function getAllowedTemplateMediaMimeTypes(format) {
  if (format === "IMAGE") return ["image/jpeg", "image/png"];
  if (format === "VIDEO") return ["video/mp4"];
  if (format === "DOCUMENT") return ["application/pdf"];
  return [];
}

function isAllowedTemplateMedia(mimeType, format) {
  const normalized = typeof mimeType === "string" ? mimeType.split(";")[0].trim().toLowerCase() : "";
  return getAllowedTemplateMediaMimeTypes(format).includes(normalized);
}

module.exports = { isValidBase64, getAllowedTemplateMediaMimeTypes, isAllowedTemplateMedia };
