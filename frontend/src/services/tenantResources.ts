import { auth } from "../firebase/config";
const API_URL = import.meta.env.VITE_API_BASE_URL;
async function call(path: string, method: string, body?: unknown, organizationId?: string, query?: Record<string, string>) {
  if (!API_URL) throw new Error("AWS API URL is not configured.");
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in again.");
  const token = await user.getIdToken();
  const url = new URL(API_URL.replace(/\/$/, "") + path);
  if (method === "GET" && organizationId) url.searchParams.set("organizationId", organizationId);
  if (method === "GET" && query) Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Workspace resource request failed.");
  return result;
}
export type TenantContact = { id: string; name: string; phone: string; email?: string; notes?: string; source?: "local" | "whatsapp"; tags?: string[]; customFields?: Record<string, string | number | boolean> };
export type TenantQuickReply = { id: string; title: string; shortcut: string; message: string; hasImage?: boolean; imageMimeType?: string };
export async function listTenantContacts(org: string): Promise<TenantContact[]> {
  const result = await call("/organizations/contacts", "GET", undefined, org);
  return Array.isArray(result.items) ? result.items : [];
}
export async function saveTenantContact(org: string, data: Omit<TenantContact, "id">, resourceId?: string) {
  const result = await call("/organizations/contacts", resourceId ? "PUT" : "POST", { organizationId: org, data, ...(resourceId ? { resourceId } : {}) });
  return result.item as TenantContact;
}
export async function mergeTenantContacts(org: string, sourceId: string, targetId: string): Promise<{ item: TenantContact; mergedLeadCount: number }> {
  const result = await call("/organizations/contacts/merge", "POST", { organizationId: org, sourceId, targetId });
  return result as { item: TenantContact; mergedLeadCount: number };
}
export async function deleteTenantContact(org: string, resourceId: string) {
  return call("/organizations/contacts", "DELETE", { organizationId: org, resourceId });
}
export async function listTenantQuickReplies(org: string): Promise<TenantQuickReply[]> {
  const result = await call("/organizations/quick-replies", "GET", undefined, org);
  return Array.isArray(result.items) ? result.items : [];
}
export async function saveTenantQuickReply(org: string, data: Omit<TenantQuickReply, "id">, resourceId?: string) {
  const result = await call("/organizations/quick-replies", resourceId ? "PUT" : "POST", { organizationId: org, data, ...(resourceId ? { resourceId } : {}) });
  return result.item as TenantQuickReply;
}
export async function uploadTenantQuickReplyImage(org: string, quickReplyId: string, file: File) {
  if (!["image/jpeg", "image/png"].includes(file.type) || file.size <= 0 || file.size > 3 * 1024 * 1024) {
    throw new Error("Choose a JPEG or PNG image up to 3 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const fileBase64 = btoa(binary);
  return call("/organizations/quick-replies/image", "POST", {
    organizationId: org, quickReplyId, mimeType: file.type, fileBase64
  });
}
export async function fetchTenantQuickReplyImage(org: string, quickReplyId: string): Promise<Blob> {
  const result = await call("/organizations/quick-replies/image", "GET", undefined, org, { quickReplyId });
  if (typeof result.fileBase64 !== "string" || !["image/jpeg", "image/png"].includes(result.mimeType)) {
    throw new Error("Saved Quick Reply image preview is invalid.");
  }
  const binary = atob(result.fileBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: result.mimeType });
}
export async function removeTenantQuickReplyImage(org: string, quickReplyId: string) {
  return call("/organizations/quick-replies/image", "DELETE", { organizationId: org, quickReplyId });
}
export async function sendTenantQuickReplyImage(org: string, chatId: string, quickReplyId: string, phoneNumberId?: string) {
  return call("/organizations/send-quick-reply", "POST", { organizationId: org, chatId, quickReplyId, ...(phoneNumberId ? { phoneNumberId } : {}) });
}
export async function deleteTenantQuickReply(org: string, resourceId: string) {
  return call("/organizations/quick-replies", "DELETE", { organizationId: org, resourceId });
}

export async function updateTenantChatState(org: string, data: { chatId: string; pinned?: boolean; archived?: boolean; markRead?: boolean }) {
  return call("/organizations/chat-state", "POST", { organizationId: org, ...data });
}
export async function updateTenantMessageState(org: string, data: { chatId: string; messageId: string; pinned?: boolean; saved?: boolean }) {
  return call("/organizations/message-state", "POST", { organizationId: org, ...data });
}
export async function deleteTenantChat(org: string, chatId: string) {
  return call("/organizations/delete-chats", "POST", { organizationId: org, chatIds: [chatId] });
}

export interface TenantOutOfOfficeSettings {
  enabled: boolean;
  message: string;
  schedule: { timezone: string; days: number[]; startTime: string; endTime: string };
}
export async function getTenantOutOfOfficeSettings(org: string): Promise<TenantOutOfOfficeSettings> {
  const result = await call("/organizations/out-of-office-settings", "GET", undefined, org);
  return {
    enabled: Boolean(result.enabled), message: String(result.message || ""),
    schedule: result.schedule || { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" }
  };
}
export async function saveTenantOutOfOfficeSettings(org: string, data: TenantOutOfOfficeSettings): Promise<TenantOutOfOfficeSettings> {
  const result = await call("/organizations/out-of-office-settings", "POST", { organizationId: org, data });
  return { enabled: Boolean(result.enabled), message: String(result.message || ""), schedule: result.schedule };
}

export async function getTenantGreeting(org: string): Promise<{ enabled: boolean; text: string; trigger: string }> {
  const result = await call("/organizations/greeting-settings", "GET", undefined, org);
  return { enabled: Boolean(result.enabled), text: String(result.text || ""), trigger: String(result.trigger || "first_inbound") };
}
export async function saveTenantGreeting(org: string, enabled: boolean, text: string) {
  return call("/organizations/greeting-settings", "POST", { organizationId: org, enabled, text });
}
export async function getTenantStatus(org: string) {
  return call("/organizations/status", "GET", undefined, org);
}


export interface TenantInternalNote {
  id: string;
  text: string;
  authorUid: string;
  authorName: string;
  createdAt: string;
  visibility: "internal";
}
export async function listTenantInternalNotes(org: string, chatId: string): Promise<TenantInternalNote[]> {
  const result = await call("/organizations/internal-notes", "GET", undefined, org, { chatId });
  return Array.isArray(result.notes) ? result.notes : [];
}
export async function addTenantInternalNote(org: string, chatId: string, text: string): Promise<TenantInternalNote> {
  const result = await call("/organizations/internal-notes", "POST", { organizationId: org, chatId, text });
  if (!result.note?.id) throw new Error("Internal note could not be saved.");
  return result.note;
}


export type TenantInteractiveMessageInput =
  | { type: "button"; body: string; header?: string; footer?: string; buttons: Array<{ id: string; title: string }> }
  | { type: "list"; body: string; header?: string; footer?: string; buttonTitle: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> }
  | { type: "cta_url"; body: string; header?: string; footer?: string; displayText: string; url: string }
  | { type: "carousel"; body: string; cards: Array<{ imageUrl: string; body: string; displayText: string; url: string }> };
export async function sendTenantInteractiveMessage(
  org: string,
  chatId: string,
  interactive: TenantInteractiveMessageInput,
  phoneNumberId?: string
) {
  return call("/organizations/send-interactive", "POST", {
    organizationId: org,
    chatId,
    to: chatId,
    interactive,
    ...(phoneNumberId ? { phoneNumberId } : {})
  });
}
