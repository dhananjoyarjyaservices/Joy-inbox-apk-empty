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
    const error = new Error(result.deliveryUnknown === true
      ? "Delivery status is unknown. Do not resend this message yet. Check the WhatsApp conversation first."
      : result.error || "Organization request failed.");
    Object.assign(error, { deliveryUnknown: result.deliveryUnknown === true });
    throw error;
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

export interface WhatsAppEmbeddedSignupConfig {
  enabled: boolean;
  appId?: string;
  configId?: string;
  graphApiVersion?: string;
  partnerMode?: "tech_provider" | "solution_partner";
  solutionId?: string;
}
export async function getWhatsAppEmbeddedSignupConfig(organizationId: string): Promise<WhatsAppEmbeddedSignupConfig> {
  return request(`/whatsapp/embedded-signup/config?organizationId=${encodeURIComponent(organizationId)}`);
}
export async function startWhatsAppEmbeddedSignup(organizationId: string): Promise<{ sessionId: string; expiresAt: string }> {
  return request("/whatsapp/embedded-signup/session", "POST", { organizationId });
}
export async function completeWhatsAppEmbeddedSignup(input: {
  organizationId: string;
  sessionId: string;
  code: string;
  wabaId: string;
  phoneNumberId: string;
}): Promise<{ connection: WhatsAppConnection; onboarding: string }> {
  return request("/whatsapp/embedded-signup/complete", "POST", input);
}
export async function disconnectWhatsApp(organizationId: string, phoneNumberId: string) {
  return request("/whatsapp/connect", "DELETE", { organizationId, phoneNumberId });
}

export async function sendTenantText(organizationId: string, to: string, text: string, phoneNumberId?: string, replyToMessageId?: string) {
  return request("/organizations/send", "POST", {
    organizationId, to, chatId: to, text, ...(phoneNumberId ? { phoneNumberId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
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
  wabaId?: string;
  billingModel?: "meta_direct" | "joy_inbox_partner_credit_line";
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
export async function checkTenantSlaAlerts(organizationId: string): Promise<{ notified: number }> {
  return request("/organizations/sla/check", "POST", { organizationId });
}

export async function checkWhatsAppConnectionHealth(organizationId: string): Promise<WhatsAppConnectionHealthResult[]> {
  const result = await request("/whatsapp/connection-health", "POST", { organizationId });
  return Array.isArray(result.results) ? result.results : [];
}
export async function listWhatsAppConnections(organizationId: string): Promise<WhatsAppConnection[]> {
  const result = await request(`/whatsapp/connections?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.connections) ? result.connections : [];
}

export async function getWhatsAppRegistrationPin(organizationId: string, phoneNumberId: string): Promise<string> {
  const query = new URLSearchParams({ organizationId, phoneNumberId });
  const result = await request(`/whatsapp/registration-pin?${query.toString()}`);
  if (typeof result.registrationPin !== "string") throw new Error("Saved WhatsApp security PIN is unavailable.");
  return result.registrationPin;
}

export interface OrganizationApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt?: unknown;
  expiresAt?: unknown;
  lastUsedAt?: unknown;
  revokedAt?: unknown;
}
export async function listOrganizationApiKeys(organizationId: string): Promise<OrganizationApiKey[]> {
  const result = await request(`/organizations/developer/api-keys?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.apiKeys) ? result.apiKeys : [];
}
export async function createOrganizationApiKey(input: {
  organizationId: string;
  name: string;
  scopes: string[];
  expiryDays: number;
}): Promise<{ apiKey: OrganizationApiKey & { apiKey: string } }> {
  return request("/organizations/developer/api-keys", "POST", input);
}
export async function revokeOrganizationApiKey(organizationId: string, keyId: string): Promise<void> {
  await request("/organizations/developer/api-keys", "DELETE", { organizationId, keyId });
}

export interface OrganizationWebhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  status: "active" | "revoked";
  createdAt?: unknown;
  lastDeliveryAt?: unknown;
}
export async function listOrganizationWebhooks(organizationId: string): Promise<OrganizationWebhook[]> {
  const result = await request(`/organizations/developer/webhooks?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.webhooks) ? result.webhooks : [];
}
export async function createOrganizationWebhook(input: {
  organizationId: string;
  name: string;
  url: string;
  events: string[];
}): Promise<{ webhook: OrganizationWebhook; secret: string }> {
  return request("/organizations/developer/webhooks", "POST", input);
}
export async function revokeOrganizationWebhook(organizationId: string, webhookId: string): Promise<void> {
  await request("/organizations/developer/webhooks", "DELETE", { organizationId, webhookId });
}

export interface OrganizationSlaSettings { enabled: boolean; targetMinutes: number; }
export async function getOrganizationSlaSettings(organizationId: string): Promise<OrganizationSlaSettings> {
  const result = await request(`/organizations/sla/settings?organizationId=${encodeURIComponent(organizationId)}`);
  return result.settings || { enabled: true, targetMinutes: 5 };
}
export async function saveOrganizationSlaSettings(organizationId: string, settings: OrganizationSlaSettings): Promise<OrganizationSlaSettings> {
  const result = await request("/organizations/sla/settings", "PUT", { organizationId, ...settings });
  return result.settings;
}

export interface OrganizationNotification { id: string; type: "assignment" | "status" | "sla"; title: string; body: string; chatId: string; createdAt: string; read: boolean; }
export async function listOrganizationNotifications(organizationId: string): Promise<OrganizationNotification[]> {
  const result = await request(`/organizations/notifications?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.notifications) ? result.notifications : [];
}
export async function markOrganizationNotificationRead(organizationId: string, notificationId: string): Promise<void> {
  await request("/organizations/notifications", "POST", { organizationId, notificationId });
}

export async function markAllOrganizationNotificationsRead(organizationId: string): Promise<void> {
  await request("/organizations/notifications", "POST", { organizationId, markAllRead: true });
}

export interface OrganizationNotificationPreferences { assignment: boolean; status: boolean; sla: boolean; soundEnabled: boolean; desktopEnabled: boolean; }
export const DEFAULT_NOTIFICATION_PREFERENCES: OrganizationNotificationPreferences = { assignment: true, status: true, sla: true, soundEnabled: true, desktopEnabled: true };
export async function getOrganizationNotificationPreferences(organizationId: string): Promise<OrganizationNotificationPreferences> {
  const result = await request(`/organizations/notifications/preferences?organizationId=${encodeURIComponent(organizationId)}`);
  return result.preferences || DEFAULT_NOTIFICATION_PREFERENCES;
}
export async function saveOrganizationNotificationPreferences(organizationId: string, preferences: OrganizationNotificationPreferences): Promise<OrganizationNotificationPreferences> {
  const result = await request("/organizations/notifications/preferences", "PUT", { organizationId, ...preferences });
  return result.preferences;
}


export interface OrganizationAutomationRule {
  id: string;
  name: string;
  keyword: string;
  matchType: "contains" | "exact" | "starts_with";
  response: string;
  steps: { message: string; delaySeconds: number }[];
  enabled: boolean;
  priority: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}
export async function listOrganizationAutomationRules(organizationId: string): Promise<OrganizationAutomationRule[]> {
  const result = await request(`/organizations/automation-rules?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.rules) ? result.rules : [];
}
export async function saveOrganizationAutomationRule(
  organizationId: string,
  data: Omit<OrganizationAutomationRule, "id" | "createdAt" | "updatedAt">,
  resourceId?: string,
): Promise<OrganizationAutomationRule> {
  const result = await request("/organizations/automation-rules", resourceId
    ? "PUT" : "POST", { organizationId, data, ...(resourceId ? { resourceId } : {}) });
  if (!result.rule?.id) throw new Error("Automation rule could not be saved.");
  return result.rule;
}
export async function deleteOrganizationAutomationRule(organizationId: string, resourceId: string): Promise<void> {
  await request("/organizations/automation-rules", "DELETE", { organizationId, resourceId });
}


export interface OrganizationAutomationRun {
  id: string;
  ruleId: string;
  ruleName: string;
  customerPhone: string;
  status: "sending" | "sent" | "failed" | "partially_failed" | "skipped" | string;
  completedSteps: number;
  totalSteps: number;
  error: string;
  reason: string;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface OrganizationAutomationQueueHealth {
  counts: Record<"queued" | "sending" | "sent" | "failed" | "skipped" | "uncertain", number>;
  dueNow: number;
  recentIssues: { id: string; status: string; ruleId: string; customerPhone: string; step: number; error: string; updatedAt: string | null }[];
  maxJobsPerInvocation: number;
  maxAttempts: number;
}
export async function getOrganizationAutomationQueueHealth(organizationId: string): Promise<OrganizationAutomationQueueHealth> {
  return request(`/organizations/automation-queue-health?organizationId=${encodeURIComponent(organizationId)}`);
}
export async function listOrganizationAutomationRuns(organizationId: string): Promise<OrganizationAutomationRun[]> {
  const result = await request(`/organizations/automation-runs?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.runs) ? result.runs : [];
}


export interface OrganizationCampaign {
  id: string;
  name: string;
  templateName: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION" | string;
  phoneNumberId: string;
  status: "draft" | "scheduled" | "queued" | "sending" | "paused" | "completed" | "failed" | "cancelled" | string;
  recipientCount: number;
  skippedRecipients: number;
  sentCount?: number;
  failedCount?: number;
  uncertainCount?: number;
  deliveredCount?: number;
  readCount?: number;
  deliveryFailedCount?: number;
  skippedCount?: number;
  scheduledAt?: string | null;
  createdAt: string | null;
}
export interface OrganizationCampaignDraftRecipient {
  phone: string;
  optedIn: true;
  consentAt: string;
  consentSource: string;
  variables?: string[];
}
export interface CreateOrganizationCampaignInput {
  name: string;
  templateName: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  phoneNumberId: string;
  wabaId: string;
  variables?: string[];
  recipients: OrganizationCampaignDraftRecipient[];
}
export async function listOrganizationCampaigns(organizationId: string): Promise<OrganizationCampaign[]> {
  const result = await request(`/organizations/campaigns?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.campaigns) ? result.campaigns : [];
}
export async function createOrganizationCampaign(organizationId: string, campaign: CreateOrganizationCampaignInput): Promise<OrganizationCampaign> {
  const result = await request("/organizations/campaigns", "POST", { organizationId, ...campaign });
  if (!result.campaign?.id) throw new Error("Campaign draft could not be created.");
  return result.campaign;
}

export type OrganizationCampaignAction = "start" | "schedule" | "pause" | "resume" | "cancel";
export async function updateOrganizationCampaign(
  organizationId: string,
  campaignId: string,
  action: OrganizationCampaignAction,
  scheduledAt?: string
): Promise<{ success: boolean; campaignId: string; status: string }> {
  return request("/organizations/campaigns", "POST", {
    organizationId,
    campaignId,
    action,
    ...(scheduledAt ? { scheduledAt } : {})
  });
}


export interface OrganizationBillingPlan {
  key: string;
  name: string;
  monthlyPriceInr: number;
  annualPriceInr: number;
  monthlyAvailable: boolean;
  annualAvailable: boolean;
  currency: "INR";
  intervals: ("month" | "year")[];
  limits: { messages: number; agents: number; mediaTransferGb: number; historyMonths: number };
  trialDays: number;
}
export interface OrganizationBillingState {
  billingEnabled: boolean;
  plans: OrganizationBillingPlan[];
  subscription: {
    plan: string;
    interval: "month" | "year";
    status: string;
    currentPeriodEnd: string | null;
    trialEnd: string | null;
    cancelAtPeriodEnd: boolean;
    usage: {
      messagesUsed: number;
      messagesReserved: number;
      messageLimit: number;
      percent: number;
      thresholdsReached: number[];
      mediaBytesUsed: number;
      mediaBytesReserved: number;
      mediaLimitBytes: number;
      mediaPercent: number;
      mediaThresholdsReached: number[];
      periodStart: string;
      periodEnd: string;
      trial: boolean;
    } | { error: string } | null;
  } | null;
}
export async function getOrganizationBilling(organizationId: string): Promise<OrganizationBillingState> {
  return request(`/organizations/billing?organizationId=${encodeURIComponent(organizationId)}`);
}
export async function createOrganizationBillingCheckout(organizationId: string, plan: string, interval: "month" | "year" = "month"): Promise<string> {
  const result = await request("/organizations/billing", "POST", { organizationId, action: "checkout", plan, interval });
  if (typeof result.checkout?.url !== "string") throw new Error("Stripe checkout URL was not returned.");
  return result.checkout.url;
}
export async function openOrganizationBillingPortal(organizationId: string): Promise<string> {
  const result = await request("/organizations/billing", "POST", { organizationId, action: "portal" });
  if (typeof result.portal?.url !== "string") throw new Error("Stripe billing portal URL was not returned.");
  return result.portal.url;
}


export interface OrganizationCampaignReportRecipient {
  id: string;
  phone: string;
  status: string;
  deliveryStatus: string;
  reason: string;
  error: string;
  messageId: string;
  createdAt: string | null;
  sentAt: string | null;
  deliveryUpdatedAt: string | null;
}
export async function getOrganizationCampaignReportRecipients(
  organizationId: string,
  campaignId: string,
  cursor?: string
): Promise<{ recipients: OrganizationCampaignReportRecipient[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ organizationId, campaignId, limit: "100" });
  if (cursor) query.set("cursor", cursor);
  const result = await request(`/organizations/campaigns?${query.toString()}`);
  return {
    recipients: Array.isArray(result.recipients) ? result.recipients : [],
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null
  };
}

// Backward-compatible name used by the tenant inbox report panel.
export const getOrganizationCampaignRecipients = getOrganizationCampaignReportRecipients;


export interface OrganizationInvitation {
  id: string;
  email: string;
  role: "admin" | "agent";
  status: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}
export async function listOrganizationInvitations(organizationId: string): Promise<OrganizationInvitation[]> {
  const result = await request(`/organizations/invitations?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.invitations) ? result.invitations : [];
}
export async function createOrganizationInvitation(
  organizationId: string,
  email: string,
  role: "admin" | "agent"
): Promise<{ email: string; role: string; status: string; expiresAt: string; token: string; inviteUrl: string | null }> {
  const result = await request("/organizations/invitations", "POST", { organizationId, email, role });
  if (!result.invitation?.token) throw new Error("Invitation token was not returned.");
  return result.invitation;
}
export async function revokeOrganizationInvitation(organizationId: string, email: string) {
  return request("/organizations/invitations", "DELETE", { organizationId, email });
}
export async function acceptOrganizationInvitation(organizationId: string, token: string) {
  return request("/organizations/invitations/accept", "POST", { organizationId, token });
}
