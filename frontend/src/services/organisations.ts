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
  return request<{ invitation: { invitationId: string; email: string; role: string; expiresAt: string; emailSent: boolean } }>(
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

export async function sendOrganisationWhatsAppMedia(
  orgId: string,
  details: { to: string; type: string; mimeType: string; filename: string; caption?: string; fileBase64: string },
) {
  return request<{ success: boolean; message: { messageId: string; chatId: string; status: string; mediaRetained: boolean } }>(
    `/organisations/${encodeURIComponent(orgId)}/media`,
    { method: "POST", body: JSON.stringify(details) },
  );
}

export async function sendOrganisationWhatsAppTemplate(
  orgId: string,
  details: { to: string; name: string; language: string; bodyParameters?: string[] },
) {
  return request<{ success: boolean; message: { messageId: string; chatId: string; status: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/messages/template`,
    { method: "POST", body: JSON.stringify(details) },
  );
}

export interface OrganisationInteractiveButton {
  id: string;
  title: string;
}

export interface OrganisationInteractiveRow {
  id: string;
  title: string;
  description?: string;
}

export async function sendOrganisationInteractive(
  orgId: string,
  details: {
    to: string;
    kind: "button" | "list";
    body: string;
    header?: string;
    footer?: string;
    buttons?: OrganisationInteractiveButton[];
    buttonText?: string;
    sections?: Array<{ title: string; rows: OrganisationInteractiveRow[] }>;
  },
) {
  return request<{ success: boolean; message: { messageId: string; chatId: string; status: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/messages/interactive`,
    { method: "POST", body: JSON.stringify(details) },
  );
}

export interface OrganisationCampaign {
  id: string;
  title: string;
  templateName: string;
  language: string;
  bodyParameters: string[];
  audience?: { consentRequired: boolean; tags: string[] };
  status: "draft" | string;
  createdAt?: { toDate?: () => Date } | Date;
  updatedAt?: { toDate?: () => Date } | Date;
}

export async function listOrganisationCampaigns(orgId: string) {
  const result = await request<{ campaigns: OrganisationCampaign[] }>(
    `/organisations/${encodeURIComponent(orgId)}/campaigns`,
  );
  return result.campaigns || [];
}

export async function createOrganisationCampaign(
  orgId: string,
  details: { title: string; templateName: string; language: string; bodyParameters?: string[]; tags?: string[] },
) {
  return request<{ success: boolean; campaign: OrganisationCampaign }>(
    `/organisations/${encodeURIComponent(orgId)}/campaigns`,
    { method: "POST", body: JSON.stringify(details) },
  );
}

export async function previewOrganisationCampaign(orgId: string, campaignId: string) {
  const result = await request<{ preview: {
    campaignId: string; eligibleCount: number; excludedCount: number;
    requiresExplicitConsent: boolean; sendingEnabled: boolean; message: string;
  } }>(
    `/organisations/${encodeURIComponent(orgId)}/campaigns/${encodeURIComponent(campaignId)}/preview`,
  );
  return result.preview;
}


export interface OrganisationAutomationSettings {
  greetingEnabled: boolean;
  greetingText: string;
  awayEnabled: boolean;
  awayText: string;
  keywordRules: { keyword: string; reply: string; enabled: boolean }[];
}

export async function getOrganisationAutomation(orgId: string) {
  const result = await request<{ settings: OrganisationAutomationSettings }>(
    `/organisations/${encodeURIComponent(orgId)}/automation`,
  );
  return result.settings;
}

export async function saveOrganisationAutomation(orgId: string, settings: OrganisationAutomationSettings) {
  return request<{ success: boolean; settings: OrganisationAutomationSettings }>(
    `/organisations/${encodeURIComponent(orgId)}/automation`,
    { method: "PUT", body: JSON.stringify(settings) },
  );
}


export async function updateOrganisationContactConsent(
  orgId: string,
  phone: string,
  details: { status: "opted_in" | "opted_out"; source?: string; evidence?: string },
) {
  return request<{ success: boolean; consent: { phone: string; status: string; updatedAt: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/contacts/${encodeURIComponent(phone.replace(/\\D/g, ""))}/consent`,
    { method: "PUT", body: JSON.stringify(details) },
  );
}


export async function updateOrganisationMemberRole(orgId: string, uid: string, role: "admin" | "manager" | "agent") {
  return request<{ success: boolean; member: OrganisationMember }>(
    "/organisations/" + encodeURIComponent(orgId) + "/members/" + encodeURIComponent(uid),
    { method: "PUT", body: JSON.stringify({ role }) },
  );
}

export async function removeOrganisationMember(orgId: string, uid: string) {
  return request<{ success: boolean; member: OrganisationMember }>(
    "/organisations/" + encodeURIComponent(orgId) + "/members/" + encodeURIComponent(uid),
    { method: "DELETE" },
  );
}



export interface OrganisationInvitation {
  id: string;
  email: string;
  role: "admin" | "manager" | "agent" | string;
  status: "pending" | "expired" | "revoked" | "accepted" | string;
  createdAt?: { toDate?: () => Date } | Date | string | null;
  expiresAt?: { toDate?: () => Date } | Date | string | null;
  createdBy?: string;
  emailDelivery?: "sent" | "failed" | string;
  emailLastAttemptAt?: { toDate?: () => Date } | Date | string;
}

export async function listOrganisationInvitations(orgId: string) {
  const result = await request<{ invitations: OrganisationInvitation[] }>(
    `/organisations/${encodeURIComponent(orgId)}/invitations`,
  );
  return result.invitations || [];
}


export async function resendOrganisationInvitationEmail(orgId: string, invitationId: string) {
  return request<{ success: boolean; invitation: { invitationId: string; email: string; emailSent: boolean; reason?: string | null } }>(
    `/organisations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}/send`,
    { method: "POST" },
  );
}

export async function revokeOrganisationInvitation(orgId: string, invitationId: string) {
  return request<{ success: boolean; invitation: { invitationId: string; status: string } }>(
    `/organisations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
    { method: "DELETE" },
  );
}

export interface OrganisationAuditLog {
  id: string;
  action: string;
  actorUid: string;
  actorEmail: string;
  targetUid?: string;
  targetEmail?: string;
  details?: Record<string, unknown>;
  createdAt?: { toDate?: () => Date } | Date | string;
}

export async function getOrganisationAuditLogs(orgId: string) {
  const result = await request<{ auditLogs: OrganisationAuditLog[] }>(
    "/organisations/" + encodeURIComponent(orgId) + "/audit-logs",
  );
  return result.auditLogs || [];
}
