import { auth } from "../firebase/config";
const API_URL = import.meta.env.VITE_API_BASE_URL;
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED = new Set([
  "image/jpeg","image/png","video/mp4","video/3gpp","audio/aac","audio/amr","audio/mpeg","audio/mp4","audio/ogg",
  "application/pdf","text/plain","application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);
async function credentials() {
  if (!API_URL) throw new Error("AWS API URL is not configured.");
  if (!auth.currentUser) throw new Error("Please sign in again.");
  return auth.currentUser.getIdToken();
}
function mediaType(mime: string) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File could not be read."));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("File encoding failed."));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
export async function sendTenantMedia(org: string, to: string, file: File, caption = "", phoneNumberId?: string) {
  if (!ALLOWED.has(file.type)) throw new Error("This file type is not supported by the current WhatsApp media integration.");
  if (!file.size || file.size > MAX_BYTES) throw new Error("Choose a file up to 3 MB.");
  if (caption.length > 1024) throw new Error("Caption is too long.");
  if (file.type.startsWith("audio/") && caption.trim()) throw new Error("Audio attachments cannot have a caption.");
  const token = await credentials();
  const response = await fetch(API_URL!.replace(/\/$/, "") + "/organizations/send-media", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId: org, to, chatId: to, ...(phoneNumberId ? { phoneNumberId } : {}), fileBase64: await fileToBase64(file),
      mimeType: file.type, type: mediaType(file.type), filename: file.name,
      caption, clientMessageId: crypto.randomUUID()
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Media could not be sent.");
  return result;
}
export async function fetchTenantMedia(org: string, chatId: string, messageId: string): Promise<Blob> {
  const token = await credentials();
  const url = new URL(API_URL!.replace(/\/$/, "") + "/organizations/media");
  url.searchParams.set("organizationId", org);
  url.searchParams.set("chatId", chatId);
  url.searchParams.set("messageId", messageId);
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "Media preview could not be loaded.");
  }
  return response.blob();
}
export function isSupportedTenantMedia(mime?: string) {
  return Boolean(mime && ALLOWED.has(mime.toLowerCase()));
}
