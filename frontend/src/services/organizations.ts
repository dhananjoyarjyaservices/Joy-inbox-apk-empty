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
  if (!response.ok) {
    if (result.deliveryUnknown === true) {
      throw new Error("Delivery status is unknown. Do not resend this message yet. Check the WhatsApp conversation first.");
    }
    throw new Error(result.error || "Organization request failed.");
  }
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

export async function sendTenantTemplate(organizationId: string, to: string, phoneNumberId: string, wabaId: string, templateName: string, language: string, variables: string[], headerVariables: string[] = [], buttonVariables: string[] = [], headerMedia?: { base64: string; mimeType: string; filename: string }) {
  return request("/organizations/send-template", "POST", {
    organizationId, to, chatId: to, phoneNumberId, wabaId, templateName, language, variables, headerVariables, buttonVariables, ...(headerMedia ? { headerMedia } : {}),
    clientMessageId: crypto.randomUUID()
  });
}

export async function retryTenantFailedTemplate(organizationId: string, chatId: string, originalMessageId: string) {
  return request("/organizations/retry-template", "POST", {
    organizationId, chatId, originalMessageId, clientMessageId: crypto.randomUUID()
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
export interface WhatsAppTemplate {
  id: string;
  name: string;
  status: string;
  language: string;
  category: string;
  components: Array<{ type?: string; text?: string; format?: string; buttons?: Array<{ type?: string; text?: string; url?: string }> }>;
}
export async function listWhatsAppTemplates(organizationId: string, phoneNumberId: string, wabaId: string): Promise<WhatsAppTemplate[]> {
  const query = new URLSearchParams({ organizationId, phoneNumberId, wabaId });
  const result = await request(`/whatsapp/templates?${query.toString()}`);
  return Array.isArray(result.templates) ? result.templates : [];
}
export async function checkWhatsAppConnectionHealth(organizationId: string): Promise<WhatsAppConnectionHealthResult[]> {
  const result = await request("/whatsapp/connection-health", "POST", { organizationId });
  return Array.isArray(result.results) ? result.results : [];
}
export async function listWhatsAppConnections(organizationId: string): Promise<WhatsAppConnection[]> {
  const result = await request(`/whatsapp/connections?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.connections) ? result.connections : [];
}
