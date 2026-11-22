import { auth } from "../firebase/config";
const API_URL = import.meta.env.VITE_API_BASE_URL;
async function call(path: string, method: string, body?: unknown, organizationId?: string) {
  if (!API_URL) throw new Error("AWS API URL is not configured.");
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in again.");
  const token = await user.getIdToken();
  const url = new URL(API_URL.replace(/\/$/, "") + path);
  if (method === "GET" && organizationId) url.searchParams.set("organizationId", organizationId);
  const response = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Workspace resource request failed.");
  return result;
}
export type TenantContact = { id: string; name: string; phone: string; email?: string; notes?: string; source?: "local" | "whatsapp" };
export type TenantQuickReply = { id: string; title: string; shortcut: string; message: string };
export async function listTenantContacts(org: string): Promise<TenantContact[]> {
  const result = await call("/organizations/contacts", "GET", undefined, org);
  return Array.isArray(result.items) ? result.items : [];
}
export async function saveTenantContact(org: string, data: Omit<TenantContact, "id">, resourceId?: string) {
  const result = await call("/organizations/contacts", resourceId ? "PUT" : "POST", { organizationId: org, data, ...(resourceId ? { resourceId } : {}) });
  return result.item as TenantContact;
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
export async function deleteTenantQuickReply(org: string, resourceId: string) {
  return call("/organizations/quick-replies", "DELETE", { organizationId: org, resourceId });
}
