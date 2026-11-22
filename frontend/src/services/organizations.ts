import { auth } from "../firebase/config";
const API_URL = import.meta.env.VITE_API_BASE_URL;

async function request(path: string, method = "GET", body?: unknown) {
  if (!API_URL) throw new Error("AWS API URL is not configured.");
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in again.");
  const token = await user.getIdToken();
  const response = await fetch(`${API_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Organization request failed.");
  return result;
}
export interface Organization {
  id: string;
  name: string;
  role: "owner" | "admin" | "agent";
  status: string;
  createdAt?: unknown;
}
export async function listOrganizations(): Promise<Organization[]> {
  const result = await request("/organizations");
  return Array.isArray(result.organizations) ? result.organizations : [];
}
export async function createOrganization(name: string): Promise<Organization> {
  const result = await request("/organizations", "POST", { name });
  if (!result.organization?.id) throw new Error("Organization could not be created.");
  return result.organization;
}
export async function connectWhatsApp(organizationId: string, phoneNumberId: string, accessToken: string) {
  return request("/whatsapp/connect", "POST", { organizationId, phoneNumberId, accessToken });
}
export async function disconnectWhatsApp(organizationId: string, phoneNumberId: string) {
  return request("/whatsapp/connect", "DELETE", { organizationId, phoneNumberId });
}

export async function sendTenantText(organizationId: string, to: string, text: string, phoneNumberId?: string) {
  return request("/organizations/send", "POST", {
    organizationId, to, chatId: to, text, ...(phoneNumberId ? { phoneNumberId } : {}),
    clientMessageId: crypto.randomUUID()
  });
}

export async function retryTenantFailedText(organizationId: string, chatId: string, originalMessageId: string) {
  return request("/organizations/retry", "POST", {
    organizationId, chatId, originalMessageId, clientMessageId: crypto.randomUUID()
  });
}

export interface WhatsAppConnection {
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  connected: boolean;
  updatedAt?: unknown;
  healthStatus?: "healthy" | "attention";
  healthCheckedAt?: string;
  healthError?: string;
}
export interface WhatsAppConnectionHealthResult {
  phoneNumberId: string;
  status: "healthy" | "attention";
  checkedAt: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  error?: string;
}
export async function checkWhatsAppConnectionHealth(organizationId: string): Promise<WhatsAppConnectionHealthResult[]> {
  const result = await request("/whatsapp/connection-health", "POST", { organizationId });
  return Array.isArray(result.results) ? result.results : [];
}
export async function listWhatsAppConnections(organizationId: string): Promise<WhatsAppConnection[]> {
  const result = await request(`/whatsapp/connections?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.connections) ? result.connections : [];
}
