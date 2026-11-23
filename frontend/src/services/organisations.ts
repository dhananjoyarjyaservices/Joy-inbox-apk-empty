import { auth } from "../firebase/config";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export interface Organisation {
  id: string;
  name: string;
  role: "owner" | "admin" | "manager" | "agent";
  plan?: string;
  status: string;
}

export interface OrganisationMember {
  uid: string;
  email: string;
  role: string;
  status: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE) throw new Error("Backend URL is not configured.");
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in again.");
  const token = await user.getIdToken(true);
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Request failed.");
  }
  return payload as T;
}

export async function listOrganisations(): Promise<Organisation[]> {
  const result = await request<{ organisations: Organisation[] }>("/organisations");
  return result.organisations || [];
}

export async function createOrganisation(name: string): Promise<Organisation> {
  const result = await request<{ organisation: Organisation }>("/organisations", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return result.organisation;
}

export async function createInvitation(
  orgId: string,
  email: string,
  role: "admin" | "manager" | "agent",
) {
  return request<{ invitation: { invitationId: string; email: string; role: string; expiresAt: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/invitations`,
    { method: "POST", body: JSON.stringify({ email, role }) },
  );
}

export async function acceptInvitation(orgId: string, invitationId: string) {
  return request<{ membership: { organisationId: string; role: string; status: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/invitations/accept`,
    { method: "POST", body: JSON.stringify({ invitationId }) },
  );
}

export async function listMembers(orgId: string): Promise<OrganisationMember[]> {
  const result = await request<{ members: OrganisationMember[] }>(
    `/organisations/${encodeURIComponent(orgId)}/members`,
  );
  return result.members || [];
}

export interface WhatsAppConnection {
  connected: boolean;
  phoneNumberId?: string;
  wabaId?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  status?: string;
  webhookVerifyToken?: string;
}

export async function getOrganisationWhatsAppConnection(orgId: string) {
  return request<WhatsAppConnection>(
    `/organisations/${encodeURIComponent(orgId)}/whatsapp-connection`,
  );
}

export async function saveOrganisationWhatsAppConnection(
  orgId: string,
  details: { phoneNumberId: string; wabaId: string; accessToken: string },
) {
  return request<{ success: boolean; connection: WhatsAppConnection }>(
    `/organisations/${encodeURIComponent(orgId)}/whatsapp-connection`,
    { method: "POST", body: JSON.stringify(details) },
  );
}

export async function sendOrganisationWhatsAppText(
  orgId: string,
  to: string,
  text: string,
) {
  return request<{ success: boolean; message: { messageId: string; chatId: string; status: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/messages`,
    { method: "POST", body: JSON.stringify({ to, text }) },
  );
}

export interface OrganisationNote {
  id: string;
  content: string;
  authorUid: string;
  authorEmail: string;
  createdAt: { toDate?: () => Date } | Date;
}

export async function getOrganisationNotes(orgId: string, chatId: string) {
  const result = await request<{ notes: OrganisationNote[] }>(
    `/organisations/${encodeURIComponent(orgId)}/chats/${encodeURIComponent(chatId)}/notes`,
  );
  return result.notes || [];
}

export async function addOrganisationNote(orgId: string, chatId: string, content: string) {
  return request<{ success: boolean; result: { id: string; content: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/chats/${encodeURIComponent(chatId)}/notes`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
}

export async function assignOrganisationChat(
  orgId: string,
  chatId: string,
  assignedToUid: string | null,
  status?: "open" | "pending" | "resolved",
) {
  return request<{ success: boolean; result: { assignedToUid: string | null; assignedToEmail: string | null; status: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/chats/${encodeURIComponent(chatId)}/assignment`,
    { method: "POST", body: JSON.stringify({ assignedToUid, ...(status ? { status } : {}) }) },
  );
}

export interface OrganisationQuickReply {
  id: string;
  shortcut: string;
  title: string;
  text: string;
  updatedAt?: { toDate?: () => Date } | Date;
}

export async function getOrganisationQuickReplies(orgId: string) {
  const result = await request<{ quickReplies: OrganisationQuickReply[] }>(
    `/organisations/${encodeURIComponent(orgId)}/quick-replies`,
  );
  return result.quickReplies || [];
}

export async function saveOrganisationQuickReply(
  orgId: string,
  reply: { shortcut: string; title: string; text: string },
) {
  return request<{ success: boolean; quickReply: OrganisationQuickReply }>(
    `/organisations/${encodeURIComponent(orgId)}/quick-replies`,
    { method: "POST", body: JSON.stringify(reply) },
  );
}

export async function deleteOrganisationQuickReply(orgId: string, shortcut: string) {
  return request<{ success: boolean; result: { deleted: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/quick-replies/${encodeURIComponent(shortcut)}`,
    { method: "DELETE" },
  );
}

export async function updateOrganisationChatTags(orgId: string, chatId: string, tags: string[]) {
  return request<{ success: boolean; result: { tags: string[] } }>(
    `/organisations/${encodeURIComponent(orgId)}/chats/${encodeURIComponent(chatId)}/tags`,
    { method: "POST", body: JSON.stringify({ tags }) },
  );
}

export async function updateOrganisationChatStatus(
  orgId: string,
  chatId: string,
  status: "open" | "pending" | "resolved",
) {
  return request<{ success: boolean; result: { status: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/chats/${encodeURIComponent(chatId)}/assignment`,
    { method: "POST", body: JSON.stringify({ status }) },
  );
}
