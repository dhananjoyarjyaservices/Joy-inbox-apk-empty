import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { LogOut, MessageCircle, Send, Settings, RefreshCw, Paperclip, FileText, Bell } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import { getActiveOrganizationId, setActiveOrganizationId } from "../services/activeOrganization";
import { listOrganizations, listWhatsAppConnections, checkWhatsAppConnectionHealth, checkTenantSlaAlerts, listWhatsAppTemplates, sendTenantTemplate, sendTenantText, retryTenantFailedText, retryTenantFailedTemplate, getOrganizationSlaSettings, saveOrganizationSlaSettings, type Organization, type WhatsAppConnection, type WhatsAppConnectionHealthResult, type WhatsAppTemplate, listOrganizationNotifications, listOrganizationAutomationRules, listOrganizationAutomationRuns, getOrganizationAutomationQueueHealth, type OrganizationAutomationQueueHealth, saveOrganizationAutomationRule, deleteOrganizationAutomationRule, type OrganizationAutomationRule, type OrganizationAutomationRun, markOrganizationNotificationRead, markAllOrganizationNotificationsRead, getOrganizationNotificationPreferences, saveOrganizationNotificationPreferences, DEFAULT_NOTIFICATION_PREFERENCES, type OrganizationNotificationPreferences, type OrganizationNotification, listOrganizationCampaigns, createOrganizationCampaign, updateOrganizationCampaign, type OrganizationCampaign, type OrganizationCampaignAction, getOrganizationCampaignReportRecipients, type OrganizationCampaignReportRecipient, getOrganizationBilling, createOrganizationBillingCheckout, openOrganizationBillingPortal, type OrganizationBillingState } from "../services/organizations";
import OrganizationMembers from "../components/OrganizationMembers";
import { listOrganizationMembers, updateOrganizationChatAssignment, listChatAssignmentAudit, listHistoricalAgentPerformance, type OrganizationMember, type ChatAssignmentAuditEvent, type HistoricalAgentPerformance } from "../services/organizationMembers";
import { listenToTenantChats, listenToTenantMessages, loadOlderTenantMessages } from "../services/tenantChats";
import { sendTenantMedia, fetchTenantMedia } from "../services/tenantMedia";
import { enablePushNotifications, syncPushToken, listenForForegroundPush, playNotificationSound, listRegisteredPushDevices, revokePushDevice, listNotificationDeliveries, listTeamNotificationDeliveryAnalytics, getMemberNotificationDeliveryReport, type TeamNotificationDeliveryAnalytics, type MemberNotificationDeliveryReport, type NotificationDelivery, type RegisteredPushDevice } from "../services/pushNotifications";
import { listTenantContacts, saveTenantContact, deleteTenantContact, listTenantQuickReplies, saveTenantQuickReply, uploadTenantQuickReplyImage, fetchTenantQuickReplyImage, removeTenantQuickReplyImage, sendTenantQuickReplyImage, deleteTenantQuickReply, updateTenantChatState, updateTenantMessageState, deleteTenantChat, getTenantGreeting, saveTenantGreeting, getTenantStatus, listTenantInternalNotes, addTenantInternalNote, sendTenantInteractiveMessage, type TenantInteractiveMessageInput, type TenantContact, type TenantQuickReply, type TenantInternalNote } from "../services/tenantResources";

type TenantChat = {
  id: string;
  customerPhone?: string;
  phoneNumberId?: string;
  customerName?: string;
  lastMessage?: string;
  lastMessageAt?: { toDate?: () => Date } | Date | string;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean;
  assignedTo?: string | null;
  assigneeName?: string;
  assigneeEmail?: string;
  status?: "open" | "pending" | "resolved";
  responsePendingSince?: { toDate?: () => Date } | Date | string | null;
};
type TenantMessage = {
  id: string;
  text?: string;
  type?: string;
  direction?: string;
  timestamp?: { toDate?: () => Date } | Date | string;
  status?: string;
  deliveryError?: { code?: string; title?: string; message?: string; details?: string };
  mediaId?: string | null;
  mediaMimeType?: string | null;
  mediaFilename?: string | null;
  phoneNumberId?: string | null;
  interactive?: TenantInteractiveMessageInput;
  interactiveReplyId?: string;
  interactiveReplyTitle?: string;
};

function asDate(value: TenantChat["lastMessageAt"] | TenantMessage["timestamp"]): Date | null {
  if (!value) return null;
  const date = typeof value === "object" && "toDate" in value && typeof value.toDate === "function"
    ? value.toDate() : new Date(value as string | Date);
  return Number.isNaN(date.getTime()) ? null : date;
}
function timeLabel(value: TenantChat["lastMessageAt"] | TenantMessage["timestamp"]) {
  return asDate(value)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) || "";
}
function slaState(chat: TenantChat, now: number, targetMinutes = 5) {
  const targetMs = targetMinutes * 60 * 1000;
  const since = asDate(chat.responsePendingSince as TenantChat["lastMessageAt"]);
  if (!since) return null;
  const elapsed = Math.max(0, now - since.getTime());
  const remaining = Math.max(0, targetMs - elapsed);
  const overdue = elapsed > targetMs;
  const minutes = Math.floor(Math.abs(overdue ? elapsed - targetMs : remaining) / 60000);
  const seconds = Math.floor((Math.abs(overdue ? elapsed - targetMs : remaining) % 60000) / 1000);
  return { overdue, remaining, elapsed, label: overdue ? `Overdue ${minutes}m ${seconds}s` : `Reply in ${minutes}m ${seconds}s` };
}

export default function TenantInbox() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [whatsappConnections, setWhatsappConnections] = useState<WhatsAppConnection[]>([]);
  const [teamMembers, setTeamMembers] = useState<OrganizationMember[]>([]);
  const [agentHistory, setAgentHistory] = useState<HistoricalAgentPerformance[]>([]);
  const [agentHistoryDays, setAgentHistoryDays] = useState<7 | 30 | 90>(30);
  const [agentHistoryLoading, setAgentHistoryLoading] = useState(false);
  const [agentHistoryError, setAgentHistoryError] = useState("");
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [bulkAssignmentTarget, setBulkAssignmentTarget] = useState("");
  const [bulkAssignmentSaving, setBulkAssignmentSaving] = useState(false);
  const [bulkAssignmentResult, setBulkAssignmentResult] = useState("");
  const [showAssignmentHistory, setShowAssignmentHistory] = useState(false);
  const [assignmentHistory, setAssignmentHistory] = useState<ChatAssignmentAuditEvent[]>([]);
  const [assignmentHistoryLoading, setAssignmentHistoryLoading] = useState(false);
  const [assignmentHistoryError, setAssignmentHistoryError] = useState("");
  const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState("");
  const [chats, setChats] = useState<TenantChat[]>([]);
  const [slaClock, setSlaClock] = useState(() => Date.now());
  const [pushReady, setPushReady] = useState(false);
  const [pushSaving, setPushSaving] = useState(false);
  const [pushDevices, setPushDevices] = useState<RegisteredPushDevice[]>([]);
  const [notificationDeliveries, setNotificationDeliveries] = useState<NotificationDelivery[]>([]);
  const [teamDeliveryAnalytics, setTeamDeliveryAnalytics] = useState<TeamNotificationDeliveryAnalytics[]>([]);
  const [teamDeliveryLoading, setTeamDeliveryLoading] = useState(false);
  const [teamDeliveryDateFrom, setTeamDeliveryDateFrom] = useState("");
  const [teamDeliveryDateTo, setTeamDeliveryDateTo] = useState("");
  const [selectedDeliveryAgent, setSelectedDeliveryAgent] = useState("");
  const [memberDeliveryReport, setMemberDeliveryReport] = useState<MemberNotificationDeliveryReport | null>(null);
  const [memberDeliveryLoading, setMemberDeliveryLoading] = useState(false);
  const [deliveryLogsLoading, setDeliveryLogsLoading] = useState(false);
  const [deliveryStatusFilter, setDeliveryStatusFilter] = useState<"all" | "delivered" | "failed">("all");
  const [deliveryTypeFilter, setDeliveryTypeFilter] = useState("all");
  const [deliverySearch, setDeliverySearch] = useState("");
  const [deliveryDateFrom, setDeliveryDateFrom] = useState("");
  const [deliveryDateTo, setDeliveryDateTo] = useState("");
  const [pushDevicesLoading, setPushDevicesLoading] = useState(false);
  const [revokingDeviceId, setRevokingDeviceId] = useState("");
  const [selected, setSelected] = useState("");
  const [notificationMessageId, setNotificationMessageId] = useState(() => new URLSearchParams(window.location.search).get("messageId") || "");
  const [messages, setMessages] = useState<TenantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [retryingMessageIds, setRetryingMessageIds] = useState<string[]>([]);
  const [retriedMessageIds, setRetriedMessageIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [deliveryUnknown, setDeliveryUnknown] = useState(false);
  const [view, setView] = useState<"chats" | "contacts" | "replies" | "templates" | "settings" | "members" | "analytics" | "notifications" | "automation" | "campaigns" | "billing">("chats");
  const [showArchived, setShowArchived] = useState(false);
  const [notifications, setNotifications] = useState<OrganizationNotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationFilter, setNotificationFilter] = useState<"all" | "unread" | "assignment" | "status" | "sla">("all");
  const [markingAllNotifications, setMarkingAllNotifications] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState<OrganizationNotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
  const [savingNotificationPreference, setSavingNotificationPreference] = useState<keyof OrganizationNotificationPreferences | "">("");
  const [chatFilter, setChatFilter] = useState<"all" | "unread" | "unassigned" | "mine" | "open" | "pending" | "resolved" | "sla_overdue">("all");
  const [assignedAgentFilter, setAssignedAgentFilter] = useState("all");
  const [chatSearch, setChatSearch] = useState("");
  const [messageSearch, setMessageSearch] = useState("");
  const [chatDateFrom, setChatDateFrom] = useState("");
  const [chatDateTo, setChatDateTo] = useState("");
  const [messageDateFrom, setMessageDateFrom] = useState("");
  const [messageDateTo, setMessageDateTo] = useState("");
  const [messageCursor, setMessageCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [showCustomerInfo, setShowCustomerInfo] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [contactTagFilter, setContactTagFilter] = useState("all");
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [bulkTagValue, setBulkTagValue] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [customerNotes, setCustomerNotes] = useState("");
  const [customerTags, setCustomerTags] = useState("");
  const [internalNotes, setInternalNotes] = useState<TenantInternalNote[]>([]);
  const [internalNoteDraft, setInternalNoteDraft] = useState("");
  const [internalNotesLoading, setInternalNotesLoading] = useState(false);
  const [internalNoteSaving, setInternalNoteSaving] = useState(false);
  const [interactiveBuilderOpen, setInteractiveBuilderOpen] = useState(false);
  const [interactiveType, setInteractiveType] = useState<"button" | "list" | "cta_url">("button");
  const [interactiveBody, setInteractiveBody] = useState("");
  const [interactiveHeader, setInteractiveHeader] = useState("");
  const [interactiveFooter, setInteractiveFooter] = useState("");
  const [interactiveDisplayText, setInteractiveDisplayText] = useState("Open link");
  const [interactiveUrl, setInteractiveUrl] = useState("");
  const [interactiveOptions, setInteractiveOptions] = useState("");
  const [interactiveSending, setInteractiveSending] = useState(false);
  const [customerSaving, setCustomerSaving] = useState(false);
  const [contacts, setContacts] = useState<TenantContact[]>([]);
  const [replies, setReplies] = useState<TenantQuickReply[]>([]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactNotes, setContactNotes] = useState("");
  const [editingContactId, setEditingContactId] = useState("");
  const [contactSaving, setContactSaving] = useState(false);
  const [campaigns, setCampaigns] = useState<OrganizationCampaign[]>([]);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [campaignSaving, setCampaignSaving] = useState(false);
  const [campaignActionLoading, setCampaignActionLoading] = useState("");
  const [campaignReportId, setCampaignReportId] = useState("");
  const [campaignReportRecipients, setCampaignReportRecipients] = useState<OrganizationCampaignReportRecipient[]>([]);
  const [campaignReportCursor, setCampaignReportCursor] = useState<string | null>(null);
  const [campaignReportLoading, setCampaignReportLoading] = useState(false);
  const [billing, setBilling] = useState<OrganizationBillingState | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingAction, setBillingAction] = useState("");
  const [billingNotice, setBillingNotice] = useState("");
  const [campaignScheduleAt, setCampaignScheduleAt] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignTemplateName, setCampaignTemplateName] = useState("");
  const [campaignLanguage, setCampaignLanguage] = useState("en");
  const [campaignCategory, setCampaignCategory] = useState<"MARKETING" | "UTILITY" | "AUTHENTICATION">("MARKETING");
  const [campaignWabaId, setCampaignWabaId] = useState("");
  const [campaignVariables, setCampaignVariables] = useState("");
  const [campaignRecipientsCsv, setCampaignRecipientsCsv] = useState("");
  const [automationRules, setAutomationRules] = useState<OrganizationAutomationRule[]>([]);
  const [automationRuns, setAutomationRuns] = useState<OrganizationAutomationRun[]>([]);
  const [automationQueueHealth, setAutomationQueueHealth] = useState<OrganizationAutomationQueueHealth | null>(null);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationName, setAutomationName] = useState("");
  const [automationKeyword, setAutomationKeyword] = useState("");
  const [automationMatchType, setAutomationMatchType] = useState<"contains" | "exact" | "starts_with">("contains");
  const [automationSteps, setAutomationSteps] = useState<{ message: string; delaySeconds: number }[]>([{ message: "", delaySeconds: 0 }]);
  const [automationPriority, setAutomationPriority] = useState(100);
  const [editingAutomationId, setEditingAutomationId] = useState("");
  const [replyTitle, setReplyTitle] = useState("");
  const [replyShortcut, setReplyShortcut] = useState("");
  const [replyMessage, setReplyMessage] = useState("");
  const [replyImage, setReplyImage] = useState<File | null>(null);
  const [editingReplyId, setEditingReplyId] = useState("");
  const [quickReplyImageUrls, setQuickReplyImageUrls] = useState<Record<string, string>>({});
  const [attachment, setAttachment] = useState<File | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [slaEnabled, setSlaEnabled] = useState(true);
  const [slaTargetMinutes, setSlaTargetMinutes] = useState(5);
  const [greetingEnabled, setGreetingEnabled] = useState(false);
  const [greetingText, setGreetingText] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<{ whatsapp?: { connected?: boolean; error?: { message?: string } }; firestore?: { connected?: boolean } } | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResults, setHealthResults] = useState<WhatsAppConnectionHealthResult[]>([]);
  const [healthCheckedAt, setHealthCheckedAt] = useState("");
  const [templateWabaId, setTemplateWabaId] = useState("");
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateRecipient, setTemplateRecipient] = useState("");
  const [templateChoice, setTemplateChoice] = useState("");
  const [templateVariablesText, setTemplateVariablesText] = useState("");
  const [templateHeaderVariablesText, setTemplateHeaderVariablesText] = useState("");
  const [templateButtonVariablesText, setTemplateButtonVariablesText] = useState("");
  const [templateHeaderFile, setTemplateHeaderFile] = useState<File | null>(null);
  const [templateSending, setTemplateSending] = useState(false);

  useEffect(() => {
    let active = true;
    listOrganizations().then((items) => {
      if (!active) return;
      const id = getActiveOrganizationId();
      const current = items.find((item) => item.id === id) || items[0];
      if (!current) { navigate("/setup", { replace: true }); return; }
      // Keep the selected workspace in sync when the saved ID is stale or no longer accessible.
      if (current.id !== id) setActiveOrganizationId(current.id);
      setOrganization(current);
      setLoading(false);
    }).catch((e) => { if (active) { setError(e instanceof Error ? e.message : "Workspace could not load."); setLoading(false); } });
    return () => { active = false; };
  }, [navigate]);

  useEffect(() => {
    if (view === "campaigns" && organization && !campaigns.length) void loadCampaignDrafts();
  }, [view, organization?.id]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("billing");
    if (result === "success") {
      setView("billing");
      setBillingNotice("Checkout completed. Your subscription status will update after Stripe confirms the webhook.");
    } else if (result === "cancelled") {
      setView("billing");
      setBillingNotice("Checkout was cancelled. No new subscription was started.");
    } else if (result === "portal") {
      setView("billing");
      setBillingNotice("You have returned from the Stripe Billing Portal.");
    }
  }, []);

  useEffect(() => {
    if (view === "billing" && organization) void loadBilling();
  }, [view, organization?.id]);

  useEffect(() => {
    if (!organization || !selected) {
      setInternalNotes([]);
      return;
    }
    let active = true;
    setInternalNotes([]);
    setInternalNotesLoading(true);
    listTenantInternalNotes(organization.id, selected)
      .then(notes => { if (active) setInternalNotes(notes); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Internal notes could not load."); })
      .finally(() => { if (active) setInternalNotesLoading(false); });
    return () => { active = false; };
  }, [organization?.id, selected]);

  useEffect(() => {
    if (!organization) { setTeamMembers([]); return; }
    let active = true;
    listOrganizationMembers(organization.id, { limit: 100 })
      .then(page => { if (active) setTeamMembers(page.members.filter(member => member.status === "active")); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Team members could not load."); });
    return () => { active = false; };
  }, [organization?.id]);

  useEffect(() => {
    if (!organization || !["owner", "admin"].includes(organization.role)) {
      setTeamDeliveryAnalytics([]);
      return;
    }
    let active = true;
    setTeamDeliveryLoading(true);
    listTeamNotificationDeliveryAnalytics(organization.id, { from: teamDeliveryDateFrom || undefined, to: teamDeliveryDateTo || undefined })
      .then(items => { if (active) setTeamDeliveryAnalytics(items); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Team delivery analytics could not load."); })
      .finally(() => { if (active) setTeamDeliveryLoading(false); });
    return () => { active = false; };
  }, [organization?.id, organization?.role, teamDeliveryDateFrom, teamDeliveryDateTo]);

  useEffect(() => {
    if (!organization || view !== "automation" || !["owner", "admin"].includes(organization.role)) return;
    let active = true;
    setAutomationLoading(true);
    Promise.all([
      listOrganizationAutomationRules(organization.id),
      listOrganizationAutomationRuns(organization.id),
      getOrganizationAutomationQueueHealth(organization.id)
    ])
      .then(([rules, runs, queueHealth]) => {
        if (!active) return;
        setAutomationRules(rules);
        setAutomationRuns(runs);
        setAutomationQueueHealth(queueHealth);
      })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Automation data could not load."); })
      .finally(() => { if (active) setAutomationLoading(false); });
    return () => { active = false; };
  }, [organization?.id, organization?.role, view]);


  useEffect(() => {
    if (!organization) { setPushDevices([]); setNotificationDeliveries([]); return; }
    let active = true;
    setDeliveryLogsLoading(true);
    listNotificationDeliveries(organization.id)
      .then(items => { if (active) setNotificationDeliveries(items); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Delivery history could not load."); })
      .finally(() => { if (active) setDeliveryLogsLoading(false); });
    return () => { active = false; };
  }, [organization?.id]);

  useEffect(() => {
    if (!organization) { setPushDevices([]); return; }
    let active = true;
    setPushDevicesLoading(true);
    listRegisteredPushDevices(organization.id)
      .then(devices => { if (active) setPushDevices(devices); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Registered devices could not load."); })
      .finally(() => { if (active) setPushDevicesLoading(false); });
    return () => { active = false; };
  }, [organization?.id]);

  useEffect(() => {
    if (!organization) return;
    let active = true;
    getOrganizationNotificationPreferences(organization.id)
      .then(preferences => { if (active) setNotificationPreferences(preferences); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Notification preferences could not load."); });
    return () => { active = false; };
  }, [organization?.id]);

  useEffect(() => {
    if (!organization) return;
    let active = true;
    setNotificationsLoading(true);
    listOrganizationNotifications(organization.id)
      .then(items => { if (active) setNotifications(items); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Notifications could not load."); })
      .finally(() => { if (active) setNotificationsLoading(false); });
    return () => { active = false; };
  }, [organization?.id]);

  useEffect(() => {
    if (!organization || view !== "notifications") return;
    let active = true;
    const refreshNotifications = () => {
      listOrganizationNotifications(organization.id)
        .then(items => { if (active) setNotifications(items); })
        .catch(() => { /* Keep the last successful notification snapshot during transient network errors. */ });
    };
    const timer = window.setInterval(refreshNotifications, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [organization?.id, view]);

  async function removePushDevice(device: RegisteredPushDevice) {
    if (!organization || revokingDeviceId) return;
    setRevokingDeviceId(device.installationId);
    try {
      await revokePushDevice(organization.id, device.installationId);
      setPushDevices(current => current.filter(item => item.installationId !== device.installationId));
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Device could not be removed.");
    } finally { setRevokingDeviceId(""); }
  }

  async function updateNotificationPreference(key: keyof OrganizationNotificationPreferences, enabled: boolean) {
    if (!organization || savingNotificationPreference) return;
    const previous = notificationPreferences;
    const next = { ...previous, [key]: enabled };
    setNotificationPreferences(next);
    setSavingNotificationPreference(key);
    try {
      const saved = await saveOrganizationNotificationPreferences(organization.id, next);
      setNotificationPreferences(saved);
    } catch (error) {
      setNotificationPreferences(previous);
      setError(error instanceof Error ? error.message : "Notification preference could not be saved.");
    } finally { setSavingNotificationPreference(""); }
  }

  async function markAllNotificationsRead() {
    if (!organization || !notifications.some(item => !item.read)) return;
    setMarkingAllNotifications(true);
    try {
      await markAllOrganizationNotificationsRead(organization.id);
      setNotifications(current => current.map(item => ({ ...item, read: true })));
    } catch (error) { setError(error instanceof Error ? error.message : "Notifications could not be marked read."); }
    finally { setMarkingAllNotifications(false); }
  }

  async function openNotification(item: OrganizationNotification) {
    if (!organization) return;
    if (!item.read) {
      try {
        await markOrganizationNotificationRead(organization.id, item.id);
        setNotifications(current => current.map(entry => entry.id === item.id ? { ...entry, read: true } : entry));
      } catch (error) { setError(error instanceof Error ? error.message : "Notification could not be marked read."); }
    }
    if (item.chatId) { setSelected(item.chatId); setView("chats"); }
  }

  useEffect(() => {
    if (!organization || view !== "analytics") return;
    let active = true;
    setAgentHistoryLoading(true);
    setAgentHistoryError("");
    listHistoricalAgentPerformance(organization.id, agentHistoryDays)
      .then(result => { if (active) setAgentHistory(result.agents); })
      .catch(error => { if (active) setAgentHistoryError(error instanceof Error ? error.message : "Historical agent performance could not load."); })
      .finally(() => { if (active) setAgentHistoryLoading(false); });
    return () => { active = false; };
  }, [organization?.id, view, agentHistoryDays]);

  useEffect(() => {
    let active = true;
    if (!organization || typeof Notification === "undefined" || Notification.permission !== "granted") {
      setPushReady(false);
      return;
    }
    syncPushToken()
      .then(() => { if (active) setPushReady(true); })
      .catch(error => console.warn("Push token sync unavailable:", error));
    return () => { active = false; };
  }, [organization?.id]);

  useEffect(() => {
    if (!organization || !pushReady) return;
    let active = true;
    const check = () => {
      checkTenantSlaAlerts(organization.id).catch(error => {
        if (active) console.warn("SLA alert check unavailable:", error);
      });
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [organization?.id, pushReady]);

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => {};
    listenForForegroundPush(data => {
      if (!active) return;
      const isSla = data.type === "tenant_sla_overdue";
      const isIncoming = data.type === "incoming_whatsapp_text";
      if (!isSla && !isIncoming) return;
      if (notificationPreferences.soundEnabled && data.soundEnabled !== "false") playNotificationSound();
      if (!notificationPreferences.desktopEnabled || data.desktopEnabled === "false" || !data.chatId || typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const notification = new Notification(data.title || (isSla ? "First reply SLA overdue" : "New WhatsApp message"), {
        body: data.body || (isSla ? "A customer is waiting for your reply." : "You have a new message."),
        tag: isSla ? `sla-${data.organizationId || ""}-${data.chatId}` : `whatsapp-${data.messageId || data.chatId}`
      });
      notification.onclick = () => {
        window.focus();
        navigate(`/inbox?chatId=${encodeURIComponent(data.chatId)}${data.messageId ? `&messageId=${encodeURIComponent(data.messageId)}` : ""}`);
        notification.close();
      };
    }).then(stop => { unsubscribe = stop; })
      .catch(error => console.warn("Foreground notifications unavailable:", error));
    return () => { active = false; unsubscribe(); };
  }, [navigate, notificationPreferences.soundEnabled, notificationPreferences.desktopEnabled]);

  useEffect(() => {
    const timer = window.setInterval(() => setSlaClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!organization) return;
    return listenToTenantChats(organization.id, (items) => {
      setChats(items as TenantChat[]);
      const requestedChatId = new URLSearchParams(window.location.search).get("chatId");
      setSelected((current) => requestedChatId && items.some((item) => item.id === requestedChatId)
        ? requestedChatId
        : current && items.some((item) => item.id === current) ? current : items[0]?.id || "");
    }, (e) => setError(e.message));
  }, [organization]);

  useEffect(() => {
    setMessageCursor(null); setHasOlderMessages(false); setMessageSearch(""); setMessageDateFrom(""); setMessageDateTo("");
    if (!organization || !selected) { setMessages([]); return; }
    return listenToTenantMessages(organization.id, selected, (items, cursor, hasOlder) => {
      setMessages(current => {
        const recentIds = new Set(items.map(item => item.id));
        const newestLoaded = asDate(items[0]?.timestamp as TenantMessage["timestamp"]);
        const olderLoaded = current.filter(item => !recentIds.has(item.id) && Boolean(newestLoaded && asDate(item.timestamp) && asDate(item.timestamp)! < newestLoaded));
        return [...olderLoaded, ...(items as TenantMessage[])];
      });
      setMessageCursor(current => current || cursor); setHasOlderMessages(current => current || hasOlder);
    }, (e) => setError(e.message));
  }, [organization, selected]);

  async function loadOlderMessages() {
    if (!organization || !selected || !messageCursor || !hasOlderMessages || loadingOlderMessages) return;
    setLoadingOlderMessages(true);
    try {
      const page = await loadOlderTenantMessages(organization.id, selected, messageCursor);
      setMessages(current => [...(page.messages as TenantMessage[]), ...current.filter(item => !page.messages.some(old => old.id === item.id))]);
      setMessageCursor(page.cursor); setHasOlderMessages(page.hasOlder);
    } catch (e) { setError(e instanceof Error ? e.message : "Older messages could not be loaded."); }
    finally { setLoadingOlderMessages(false); }
  }

  useEffect(() => {
    if (!notificationMessageId || !messages.length) return;
    const target = document.getElementById("message-" + notificationMessageId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setNotificationMessageId("");
    navigate("/inbox", { replace: true });
  }, [messages, notificationMessageId, navigate]);

  useEffect(() => {
    if (!organization) return;
    let active = true;
    listWhatsAppConnections(organization.id).then(items => { if (active) { setWhatsappConnections(items.filter(item => item.connected)); setSelectedPhoneNumberId(currentChat?.phoneNumberId || items.find(item => item.connected)?.phoneNumberId || ""); } }).catch(e => { if (active) setError(e instanceof Error ? e.message : "WhatsApp numbers could not load."); });
    return () => { active = false; };
  }, [organization?.id]);

  useEffect(() => {
    if (!organization) return;
    let active = true;
    Promise.all([listTenantContacts(organization.id), listTenantQuickReplies(organization.id)])
      .then(([savedContacts, savedReplies]) => { if (active) { setContacts(savedContacts); setReplies(savedReplies); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Contacts or Quick Replies could not load."); });
    return () => { active = false; };
  }, [organization]);

  useEffect(() => {
    if (!organization) { setQuickReplyImageUrls({}); return; }
    let active = true;
    const created: string[] = [];
    Promise.all(replies.filter(reply => reply.hasImage).map(async reply => {
      try {
        const blob = await fetchTenantQuickReplyImage(organization.id, reply.id);
        const url = URL.createObjectURL(blob);
        if (!active) { URL.revokeObjectURL(url); return [reply.id, ""] as const; }
        created.push(url);
        return [reply.id, url] as const;
      } catch (e) {
        console.warn("Quick Reply image preview unavailable:", e);
        return [reply.id, ""] as const;
      }
    })).then(entries => { if (active) setQuickReplyImageUrls(Object.fromEntries(entries)); });
    return () => { active = false; created.forEach(url => URL.revokeObjectURL(url)); };
  }, [organization, replies]);

  useEffect(() => {
    if (!organization) return;
    let active = true;
    const greetingRequest = organization.role === "agent" ? Promise.resolve({ enabled: false, text: "", trigger: "first_inbound" }) : getTenantGreeting(organization.id);
    const slaRequest = organization.role === "agent" ? Promise.resolve({ enabled: true, targetMinutes: 5 }) : getOrganizationSlaSettings(organization.id);
    Promise.all([greetingRequest, getTenantStatus(organization.id), slaRequest])
      .then(([greeting, status, sla]) => { if (active) { setGreetingEnabled(greeting.enabled); setGreetingText(greeting.text); setConnectionStatus(status); setSlaEnabled(sla.enabled); setSlaTargetMinutes(sla.targetMinutes); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Workspace settings could not load."); });
    return () => { active = false; };
  }, [organization]);

  async function saveSlaSettings() {
    if (!organization || !["owner", "admin"].includes(organization.role)) return;
    setSettingsSaving(true); setError("");
    try { const saved = await saveOrganizationSlaSettings(organization.id, { enabled: slaEnabled, targetMinutes: slaTargetMinutes }); setSlaEnabled(saved.enabled); setSlaTargetMinutes(saved.targetMinutes); }
    catch (e) { setError(e instanceof Error ? e.message : "SLA settings could not be saved."); }
    finally { setSettingsSaving(false); }
  }

  function resetAutomationForm() {
    setEditingAutomationId(""); setAutomationName(""); setAutomationKeyword("");
    setAutomationMatchType("contains"); setAutomationSteps([{ message: "", delaySeconds: 0 }]); setAutomationPriority(100);
  }
  async function loadCampaignDrafts() {
    if (!organization || campaignLoading) return;
    setCampaignLoading(true);
    try { setCampaigns(await listOrganizationCampaigns(organization.id)); }
    catch (error) { setError(error instanceof Error ? error.message : "Campaigns could not be loaded."); }
    finally { setCampaignLoading(false); }
  }
  async function sendInteractiveMessage() {
    if (!organization || !selected || interactiveSending) return;
    const optionLines = interactiveOptions.split("\n").map(line => line.trim()).filter(Boolean);
    let interactive: TenantInteractiveMessageInput;
    if (interactiveType === "cta_url") {
      interactive = {
        type: "cta_url",
        body: interactiveBody,
        ...(interactiveHeader.trim() ? { header: interactiveHeader } : {}),
        ...(interactiveFooter.trim() ? { footer: interactiveFooter } : {}),
        displayText: interactiveDisplayText,
        url: interactiveUrl
      };
    } else if (interactiveType === "button") {
      interactive = {
        type: "button",
        body: interactiveBody,
        ...(interactiveHeader.trim() ? { header: interactiveHeader } : {}),
        ...(interactiveFooter.trim() ? { footer: interactiveFooter } : {}),
        buttons: optionLines.map((title, index) => ({ id: `option_${index + 1}`, title }))
      };
    } else {
      interactive = {
        type: "list",
        body: interactiveBody,
        ...(interactiveHeader.trim() ? { header: interactiveHeader } : {}),
        ...(interactiveFooter.trim() ? { footer: interactiveFooter } : {}),
        buttonTitle: "Choose",
        sections: [{
          title: "Options",
          rows: optionLines.map((line, index) => {
            const [title, ...description] = line.split("|");
            return { id: `option_${index + 1}`, title: title.trim(), ...(description.join("|").trim() ? { description: description.join("|").trim() } : {}) };
          })
        }]
      };
    }
    setInteractiveSending(true);
    setError("");
    try {
      await sendTenantInteractiveMessage(organization.id, selected, interactive, currentChat?.phoneNumberId);
      setInteractiveBody("");
      setInteractiveHeader("");
      setInteractiveFooter("");
      setInteractiveDisplayText("Open link");
      setInteractiveUrl("");
      setInteractiveOptions("");
      setInteractiveBuilderOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Interactive message could not be sent.");
    } finally {
      setInteractiveSending(false);
    }
  }

  async function saveInternalNote(event: FormEvent) {
    event.preventDefault();
    if (!organization || !selected || internalNoteSaving || !internalNoteDraft.trim()) return;
    const chatId = selected;
    setInternalNoteSaving(true);
    setError("");
    try {
      const note = await addTenantInternalNote(organization.id, chatId, internalNoteDraft);
      if (selected === chatId) {
        setInternalNotes(current => [note, ...current]);
        setInternalNoteDraft("");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Internal note could not be saved.");
    } finally {
      setInternalNoteSaving(false);
    }
  }

  async function loadBilling() {
    if (!organization || billingLoading) return;
    setBillingLoading(true);
    try { setBilling(await getOrganizationBilling(organization.id)); }
    catch (error) { setError(error instanceof Error ? error.message : "Billing information could not be loaded."); }
    finally { setBillingLoading(false); }
  }

  async function startBillingCheckout(plan: string) {
    if (!organization || billingAction) return;
    setBillingAction(plan);
    setError("");
    try {
      const url = await createOrganizationBillingCheckout(organization.id, plan);
      window.location.assign(url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Stripe checkout could not be started.");
      setBillingAction("");
    }
  }

  async function openBillingPortal() {
    if (!organization || billingAction) return;
    setBillingAction("portal");
    setError("");
    try {
      const url = await openOrganizationBillingPortal(organization.id);
      window.location.assign(url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Billing portal could not be opened.");
      setBillingAction("");
    }
  }

  function exportCampaignRecipientReport(campaignName: string) {
    if (!campaignReportRecipients.length) return;
    const columns = ["phone", "status", "deliveryStatus", "reason", "error", "messageId", "createdAt", "sentAt", "deliveryUpdatedAt"] as const;
    const rows = [
      columns.join(","),
      ...campaignReportRecipients.map(recipient => columns.map(column =>
        `"${String(recipient[column] ?? "").replace(/"/g, '""')}"`
      ).join(","))
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${campaignName.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "campaign"}-recipients.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function loadCampaignRecipientReport(campaignId: string, cursor?: string) {
    if (!organization || campaignReportLoading) return;
    setCampaignReportLoading(true);
    if (!cursor) {
      setCampaignReportId(campaignId);
      setCampaignReportRecipients([]);
      setCampaignReportCursor(null);
    }
    setError("");
    try {
      const result = await getOrganizationCampaignReportRecipients(organization.id, campaignId, cursor);
      if (cursor && campaignReportId === campaignId) {
        setCampaignReportRecipients(current => [...current, ...result.recipients]);
      } else {
        setCampaignReportId(campaignId);
        setCampaignReportRecipients(result.recipients);
      }
      setCampaignReportCursor(result.nextCursor);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Campaign recipient report could not load.");
    } finally {
      setCampaignReportLoading(false);
    }
  }

  async function changeCampaignStatus(campaign: OrganizationCampaign, action: OrganizationCampaignAction) {
    if (!organization || campaignActionLoading) return;
    if (action === "start" && !window.confirm(`Start sending the approved WhatsApp template "${campaign.templateName}" to up to ${campaign.recipientCount} opted-in recipients?`)) return;
    if (action === "cancel" && !window.confirm(`Cancel campaign "${campaign.name}"? Messages already accepted by WhatsApp cannot be recalled.`)) return;
    let scheduledAt: string | undefined;
    if (action === "schedule") {
      const selected = new Date(campaignScheduleAt);
      if (!campaignScheduleAt || Number.isNaN(selected.getTime()) || selected.getTime() <= Date.now()) {
        setError("Choose a future date and time before scheduling this campaign.");
        return;
      }
      scheduledAt = selected.toISOString();
    }
    setCampaignActionLoading(campaign.id);
    setError("");
    try {
      await updateOrganizationCampaign(organization.id, campaign.id, action, scheduledAt);
      await loadCampaignDrafts();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Campaign status could not be updated.");
    } finally {
      setCampaignActionLoading("");
    }
  }

  async function submitCampaignDraft(event: FormEvent) {
    event.preventDefault();
    if (!organization || campaignSaving) return;
    const recipients = campaignRecipientsCsv.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const [phone, consentAt, ...sourceParts] = line.split(",");
      return { phone: phone?.trim() || "", consentAt: consentAt?.trim() || "", consentSource: sourceParts.join(",").trim(), optedIn: true as const };
    });
    if (!recipients.length) { setError("Add recipients as: phone,consent date/time,consent source."); return; }
    const connection = whatsappConnections.find(item => item.phoneNumberId === selectedPhoneNumberId && item.connected);
    if (!connection) { setError("Select a connected WhatsApp number first."); return; }
    setCampaignSaving(true); setError("");
    try {
      const saved = await createOrganizationCampaign(organization.id, {
        name: campaignName.trim(), templateName: campaignTemplateName.trim(), language: campaignLanguage.trim(),
        category: campaignCategory, phoneNumberId: connection.phoneNumberId, wabaId: campaignWabaId.trim(),
        variables: campaignVariables.split(/\r?\n/).map(value => value.trim()).filter(Boolean), recipients
      });
      setCampaigns(current => [saved, ...current]);
      setCampaignName(""); setCampaignTemplateName(""); setCampaignVariables(""); setCampaignRecipientsCsv("");
    } catch (error) { setError(error instanceof Error ? error.message : "Campaign draft could not be saved."); }
    finally { setCampaignSaving(false); }
  }

  async function submitAutomationRule(event: FormEvent) {
    event.preventDefault();
    if (!organization || automationSaving) return;
    setAutomationSaving(true); setError("");
    try {
      const saved = await saveOrganizationAutomationRule(organization.id, {
        name: automationName.trim(), keyword: automationKeyword.trim(), matchType: automationMatchType,
        response: automationSteps[0]?.message.trim() || "", steps: automationSteps.map(step => ({ message: step.message.trim(), delaySeconds: step.delaySeconds })), enabled: true, priority: automationPriority
      }, editingAutomationId || undefined);
      setAutomationRules(current => editingAutomationId ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved].sort((a, b) => a.priority - b.priority));
      resetAutomationForm();
    } catch (error) { setError(error instanceof Error ? error.message : "Automation rule could not be saved."); }
    finally { setAutomationSaving(false); }
  }
  async function toggleAutomationRule(rule: OrganizationAutomationRule) {
    if (!organization || automationSaving) return;
    setAutomationSaving(true);
    try {
      const saved = await saveOrganizationAutomationRule(organization.id, { name: rule.name, keyword: rule.keyword, matchType: rule.matchType, response: rule.response, steps: rule.steps?.length ? rule.steps : [{ message: rule.response, delaySeconds: 0 }], enabled: !rule.enabled, priority: rule.priority }, rule.id);
      setAutomationRules(current => current.map(item => item.id === rule.id ? saved : item));
    } catch (error) { setError(error instanceof Error ? error.message : "Automation rule could not be updated."); }
    finally { setAutomationSaving(false); }
  }
  async function removeAutomationRule(rule: OrganizationAutomationRule) {
    if (!organization || automationSaving || !window.confirm(`Delete automation rule "${rule.name}"?`)) return;
    setAutomationSaving(true);
    try { await deleteOrganizationAutomationRule(organization.id, rule.id); setAutomationRules(current => current.filter(item => item.id !== rule.id)); if (editingAutomationId === rule.id) resetAutomationForm(); }
    catch (error) { setError(error instanceof Error ? error.message : "Automation rule could not be deleted."); }
    finally { setAutomationSaving(false); }
  }
  function editAutomationRule(rule: OrganizationAutomationRule) {
    setEditingAutomationId(rule.id); setAutomationName(rule.name); setAutomationKeyword(rule.keyword);
    setAutomationMatchType(rule.matchType); setAutomationSteps(rule.steps?.length ? rule.steps : [{ message: rule.response, delaySeconds: 0 }]); setAutomationPriority(rule.priority);
  }

  async function saveGreeting() {
    if (!organization) return;
    setSettingsSaving(true); setError("");
    try { await saveTenantGreeting(organization.id, greetingEnabled, greetingText); }
    catch (e) { setError(e instanceof Error ? e.message : "Greeting could not be saved."); }
    finally { setSettingsSaving(false); }
  }

  async function loadTemplates() {
    if (!organization || !selectedPhoneNumberId || !/^\d{5,32}$/.test(templateWabaId.trim()) || templatesLoading) {
      if (!templateWabaId.trim()) setError("Enter your WhatsApp Business Account ID (WABA ID) first.");
      else if (!selectedPhoneNumberId) setError("Connect and select a WhatsApp number first.");
      else if (!/^\d{5,32}$/.test(templateWabaId.trim())) setError("Enter a valid numeric WABA ID.");
      return;
    }
    setTemplatesLoading(true); setError("");
    try { setTemplates(await listWhatsAppTemplates(organization.id, selectedPhoneNumberId, templateWabaId.trim())); }
    catch (e) { setError(e instanceof Error ? e.message : "WhatsApp templates could not be loaded."); }
    finally { setTemplatesLoading(false); }
  }

  async function submitTemplateMessage(event: FormEvent) {
    event.preventDefault();
    if (!organization || !selectedPhoneNumberId || !templateRecipient || templateSending || deliveryUnknown) return;
    const [name, language] = templateChoice.split("::");
    const chosen = templates.find(item => item.name === name && item.language === language && item.status === "APPROVED");
    if (!chosen) { setError("Select an approved template first."); return; }
    const count = (value: string) => {
      const indexes = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
      return indexes.length ? Math.max(...indexes) : 0;
    };
    const header = chosen.components.find(component => component.type === "HEADER");
    const buttons = chosen.components.flatMap(component => component.type === "BUTTONS" && Array.isArray(component.buttons) ? component.buttons.map((button, index) => ({ ...button, index })) : []).filter(button => button.type === "URL" && String(button.url || "").includes("{{"));
    const bodyRequired = count(chosen.components.find(component => component.type === "BODY")?.text || "");
    const headerRequired = header?.format === "TEXT" ? count(header.text || "") : 0;
    const mediaHeader = Boolean(header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format || ""));
    if (mediaHeader && !templateHeaderFile) { setError(`Select a ${String(header?.format).toLowerCase()} file for this template header.`); return; }
    if (!mediaHeader && templateHeaderFile) { setError("This template does not use a media header."); return; }
    let headerMedia: { base64: string; mimeType: string; filename: string } | undefined;
    if (templateHeaderFile) {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "").split(",")[1] || ""); reader.onerror = () => reject(new Error("Could not read the selected header file.")); reader.readAsDataURL(templateHeaderFile); });
      headerMedia = { base64, mimeType: templateHeaderFile.type, filename: templateHeaderFile.name };
    }
    const variables = templateVariablesText.split("\n").map(value => value.trim()).filter(Boolean);
    const headerVariables = templateHeaderVariablesText.split("\n").map(value => value.trim()).filter(Boolean);
    const buttonVariables = templateButtonVariablesText.split("\n").map(value => value.trim()).filter(Boolean);
    if (variables.length !== bodyRequired || headerVariables.length !== headerRequired || buttonVariables.length !== buttons.length) {
      setError(`Enter ${bodyRequired} body, ${headerRequired} header and ${buttons.length} URL button variable(s), one per line.`); return;
    }
    setTemplateSending(true); setError("");
    try {
      await sendTenantTemplate(organization.id, templateRecipient, selectedPhoneNumberId, templateWabaId.trim(), name, language, variables, headerVariables, buttonVariables, headerMedia);
      setTemplateVariablesText(""); setTemplateHeaderVariablesText(""); setTemplateButtonVariablesText(""); setTemplateHeaderFile(null);
      setError("");
    } catch (e) { if (e && typeof e === "object" && "deliveryUnknown" in e && e.deliveryUnknown === true) setDeliveryUnknown(true); setError(e instanceof Error ? e.message : "Template message could not be sent."); }
    finally { setTemplateSending(false); }
  }

  async function refreshResources() {
    if (!organization) return;
    const [savedContacts, savedReplies] = await Promise.all([listTenantContacts(organization.id), listTenantQuickReplies(organization.id)]);
    setContacts(savedContacts); setReplies(savedReplies);
  }

  function exportVisibleContacts() {
    const headers = ["Name", "Phone", "Email", "Notes", "Tags", "Source"];
    const rows = visibleContacts.map(contact => [contact.name, contact.phone, contact.email || "", contact.notes || "", (contact.tags || []).join("; "), contact.source || "local"]);
    const csv = [headers, ...rows].map(row => row.map(value => {
      const text = String(value ?? "");
      return `"${text.replace(/"/g, '""')}"`;
    }).join(",")).join("\\r\\n");
    const blob = new Blob(["\\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "joy-inbox-customers.csv"; anchor.click();
    URL.revokeObjectURL(url);
  }

  async function deleteSelectedContacts() {
    if (!organization || !selectedContactIds.length || bulkSaving) return;
    const ids = contacts.filter(contact => selectedContactIds.includes(contact.id)).map(contact => contact.id);
    if (!ids.length || !confirm(`Delete ${ids.length} selected customer(s)? This cannot be undone.`)) return;
    setBulkSaving(true); setError("");
    try {
      for (const id of ids) await deleteTenantContact(organization.id, id);
      if (editingContactId && ids.includes(editingContactId)) resetContactForm();
      setSelectedContactIds([]); await refreshResources();
    } catch (e) { setError(e instanceof Error ? e.message : "Selected contacts could not all be deleted."); await refreshResources(); }
    finally { setBulkSaving(false); }
  }

  async function applyBulkTags() {
    if (!organization || !selectedContactIds.length || bulkSaving) return;
    const additions = [...new Set(bulkTagValue.split(",").map(tag => tag.trim()).filter(Boolean).map(tag => tag.slice(0, 30)))];
    if (!additions.length) { setError("Enter at least one tag."); return; }
    setBulkSaving(true); setError("");
    try {
      const selected = contacts.filter(contact => selectedContactIds.includes(contact.id));
      for (const contact of selected) {
        const merged = [...(contact.tags || [])];
        for (const tag of additions) if (!merged.some(existing => existing.toLowerCase() === tag.toLowerCase()) && merged.length < 20) merged.push(tag);
        await saveTenantContact(organization.id, { name: contact.name, phone: contact.phone, email: contact.email || "", notes: contact.notes || "", source: contact.source || "local", tags: merged }, contact.id);
      }
      setSelectedContactIds([]); setBulkTagValue(""); await refreshResources();
    } catch (e) { setError(e instanceof Error ? e.message : "Bulk tags could not be saved."); }
    finally { setBulkSaving(false); }
  }

  function resetContactForm() {
    setContactName(""); setContactPhone(""); setContactEmail(""); setContactNotes(""); setEditingContactId("");
  }

  function startEditContact(contact: TenantContact) {
    setEditingContactId(contact.id); setContactName(contact.name); setContactPhone(contact.phone);
    setContactEmail(contact.email || ""); setContactNotes(contact.notes || "");
  }

  async function addContact(event: FormEvent) {
    event.preventDefault();
    if (!organization || contactSaving) return;
    setContactSaving(true); setError("");
    try {
      await saveTenantContact(organization.id, {
        name: contactName.trim(), phone: contactPhone.trim(), email: contactEmail.trim(),
        notes: contactNotes.trim(), source: contacts.find(item => item.id === editingContactId)?.source || "local", tags: contacts.find(item => item.id === editingContactId)?.tags || []
      }, editingContactId || undefined);
      resetContactForm(); await refreshResources();
    } catch (e) { setError(e instanceof Error ? e.message : "Contact could not be saved."); }
    finally { setContactSaving(false); }
  }

  function resetReplyForm() {
    setReplyTitle(""); setReplyShortcut(""); setReplyMessage(""); setReplyImage(null); setEditingReplyId("");
  }

  function startEditReply(reply: TenantQuickReply) {
    setEditingReplyId(reply.id); setReplyTitle(reply.title); setReplyShortcut(reply.shortcut);
    setReplyMessage(reply.message || ""); setReplyImage(null); setView("replies");
  }

  async function addReply(event: FormEvent) {
    event.preventDefault();
    if (!organization) return;
    try {
      if (!replyMessage.trim() && !replyImage && !editingReplyId) throw new Error("Add a message or attach an image.");
      if (!replyMessage.trim() && !replyImage && editingReplyId && !replies.find(item => item.id === editingReplyId)?.hasImage) throw new Error("Add a message or attach an image.");
      const saved = await saveTenantQuickReply(organization.id, { title: replyTitle.trim(), shortcut: replyShortcut.trim(), message: replyMessage.trim() }, editingReplyId || undefined);
      if (replyImage) await uploadTenantQuickReplyImage(organization.id, saved.id, replyImage);
      resetReplyForm(); await refreshResources();
    } catch (e) { setError(e instanceof Error ? e.message : "Quick Reply could not be saved."); }
  }

  async function chooseQuickReply(reply: TenantQuickReply) {
    if (reply.hasImage) {
      if (!organization || !selected || sending) return;
      setSending(true); setError("");
      try {
        await sendTenantQuickReplyImage(organization.id, selected, reply.id, selectedPhoneNumberId || undefined);
        setDraft("");
      } catch (e) { setError(e instanceof Error ? e.message : "Quick Reply image could not be sent."); }
      finally { setSending(false); }
      return;
    }
    setDraft(reply.message);
  }

  const matchingReplies = useMemo(() => {
    if (!draft.startsWith("/")) return [];
    const query = draft.slice(1).trim().toLowerCase();
    return replies.filter(reply => !query || reply.shortcut.toLowerCase().includes(query) || reply.title.toLowerCase().includes(query)).slice(0, 6);
  }, [draft, replies]);

  async function chatAction(action: "pin" | "archive" | "delete" | "read", chat: TenantChat) {
    if (!organization) return;
    try {
      if (action === "delete") {
        if (!confirm("Delete this conversation and its messages?")) return;
        await deleteTenantChat(organization.id, chat.id);
        if (selected === chat.id) { setSelected(""); setMessages([]); }
      } else {
        await updateTenantChatState(organization.id, {
          chatId: chat.id,
          ...(action === "pin" ? { pinned: !Boolean(chat.pinned) } : {}),
          ...(action === "archive" ? { archived: !Boolean(chat.archived) } : {}),
          ...(action === "read" ? { markRead: true } : {})
        });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Chat action failed."); }
  }

  async function bulkAssignChats() {
    if (!organization || !bulkAssignmentTarget || !selectedChatIds.length || bulkAssignmentSaving) return;
    setBulkAssignmentSaving(true);
    setBulkAssignmentResult("");
    let succeeded = 0;
    const failed: string[] = [];
    for (const chatId of selectedChatIds) {
      try {
        await updateOrganizationChatAssignment(organization.id, { chatId, assignedTo: bulkAssignmentTarget });
        succeeded += 1;
      } catch {
        failed.push(chatId);
      }
    }
    const member = teamMembers.find(item => item.uid === bulkAssignmentTarget);
    setChats(items => items.map(chat => selectedChatIds.includes(chat.id) && !failed.includes(chat.id) ? {
      ...chat,
      assignedTo: bulkAssignmentTarget,
      assigneeName: member?.displayName || member?.email || "Assigned"
    } : chat));
    setBulkAssignmentResult(failed.length
      ? `Assigned ${succeeded}; failed ${failed.length}. Failed chats remain selected.`
      : `Successfully assigned ${succeeded} conversation(s).`);
    setSelectedChatIds(failed);
    setBulkAssignmentSaving(false);
  }

  async function loadAssignmentHistory() {
    if (!organization || !currentChat || assignmentHistoryLoading) return;
    setAssignmentHistoryLoading(true);
    setAssignmentHistoryError("");
    try {
      const events = await listChatAssignmentAudit(organization.id, currentChat.id);
      setAssignmentHistory(events);
    } catch (e) {
      setAssignmentHistoryError(e instanceof Error ? e.message : "Conversation history could not be loaded.");
    } finally {
      setAssignmentHistoryLoading(false);
    }
  }

  async function updateAssignment(input: { assignedTo?: string | null; status?: "open" | "pending" | "resolved" }) {
    if (!organization || !currentChat || assignmentSaving) return;
    setAssignmentSaving(true); setError("");
    try {
      await updateOrganizationChatAssignment(organization.id, { chatId: currentChat.id, ...input });
      setChats(items => items.map(chat => chat.id === currentChat.id ? {
        ...chat,
        ...(Object.hasOwn(input, "assignedTo") ? {
          assignedTo: input.assignedTo ?? null,
          assigneeName: teamMembers.find(member => member.uid === input.assignedTo)?.displayName || teamMembers.find(member => member.uid === input.assignedTo)?.email || ""
        } : {}),
        ...(input.status ? { status: input.status } : {})
      } : chat));
    } catch (e) { setError(e instanceof Error ? e.message : "Conversation assignment could not be updated."); }
    finally { setAssignmentSaving(false); }
  }

  async function toggleMessagePin(message: TenantMessage) {
    if (!organization || !selected) return;
    try { await updateTenantMessageState(organization.id, { chatId: selected, messageId: message.id, pinned: !Boolean((message as TenantMessage & { pinned?: boolean }).pinned) }); }
    catch (e) { setError(e instanceof Error ? e.message : "Message pin failed."); }
  }

  async function toggleMessageSaved(message: TenantMessage) {
    if (!organization || !selected) return;
    try { await updateTenantMessageState(organization.id, { chatId: selected, messageId: message.id, saved: !Boolean((message as TenantMessage & { saved?: boolean }).saved) }); }
    catch (e) { setError(e instanceof Error ? e.message : "Message save failed."); }
  }

  useEffect(() => {
    if (!organization || !selected) { setMediaUrls({}); return; }
    let active = true;
    const created: string[] = [];
    const mediaMessages = messages.filter(message => message.mediaId);
    Promise.all(mediaMessages.map(async message => {
      try {
        const blob = await fetchTenantMedia(organization.id, selected, message.id);
        const url = URL.createObjectURL(blob);
        if (!active) { URL.revokeObjectURL(url); return [message.id, ""] as const; }
        created.push(url);
        return [message.id, url] as const;
      } catch (e) {
        console.warn("Tenant media preview unavailable:", e);
        return [message.id, ""] as const;
      }
    })).then(entries => { if (active) setMediaUrls(Object.fromEntries(entries)); });
    return () => { active = false; created.forEach(url => URL.revokeObjectURL(url)); };
  }, [organization, selected, messages]);

  async function sendAttachment() {
    if (!organization || !selected || !attachment || sending || deliveryUnknown) return;
    setSending(true); setError("");
    try {
      await sendTenantMedia(organization.id, selected, attachment, draft.trim(), selectedPhoneNumberId || undefined);
      setAttachment(null); setDraft("");
    } catch (e) { if (e && typeof e === "object" && "deliveryUnknown" in e && e.deliveryUnknown === true) setDeliveryUnknown(true); setError(e instanceof Error ? e.message : "Attachment could not be sent."); }
    finally { setSending(false); }
  }

  const visibleChats = useMemo(() => chats.filter(chat => {
    const phone = (chat.customerPhone || chat.id).replace(/[^0-9]/g, "");
    const contact = contacts.find(item => item.phone.replace(/[^0-9]/g, "") === phone);
    const searchable = `${chat.customerName || ""} ${contact?.name || ""} ${chat.customerPhone || ""} ${chat.lastMessage || ""}`.toLowerCase();
    const status = chat.status || "open";
    const liveSla = slaState(chat, slaClock, slaTargetMinutes);
    const matchesFilter = (chatFilter === "all" || (chatFilter === "unread" && Number(chat.unreadCount || 0) > 0) || (chatFilter === "unassigned" && !chat.assignedTo) || (chatFilter === "mine" && Boolean(user?.uid) && chat.assignedTo === user?.uid) || (chatFilter === "sla_overdue" && Boolean(liveSla?.overdue)) || (chatFilter !== "sla_overdue" && status === chatFilter)) && (assignedAgentFilter === "all" || (assignedAgentFilter === "unassigned" ? !chat.assignedTo : chat.assignedTo === assignedAgentFilter));
    const date = asDate(chat.lastMessageAt);
    const from = chatDateFrom ? new Date(`${chatDateFrom}T00:00:00`) : null;
    const to = chatDateTo ? new Date(`${chatDateTo}T23:59:59.999`) : null;
    const matchesDate = (!from || Boolean(date && date >= from)) && (!to || Boolean(date && date <= to));
    return Boolean(chat.archived) === showArchived && matchesFilter && matchesDate && (!chatSearch.trim() || searchable.includes(chatSearch.trim().toLowerCase()));
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))), [chats, contacts, showArchived, chatSearch, chatFilter, assignedAgentFilter, chatDateFrom, chatDateTo, user?.uid, slaClock]);
  const contactSegments = useMemo(() => [...new Set(contacts.flatMap(contact => contact.tags || []))].sort((a, b) => a.localeCompare(b)), [contacts]);
  const visibleContacts = useMemo(() => contacts.filter(contact => (contactTagFilter === "all" || (contact.tags || []).some(tag => tag.toLowerCase() === contactTagFilter.toLowerCase())) && (!contactSearch.trim() || `${contact.name} ${contact.phone} ${contact.email || ""} ${contact.notes || ""} ${(contact.tags || []).join(" ")}`.toLowerCase().includes(contactSearch.trim().toLowerCase()))), [contacts, contactSearch, contactTagFilter]);
  const inboxAnalytics = useMemo(() => ({ total: chats.filter(chat => !chat.archived).length, slaOverdue: chats.filter(chat => !chat.archived && slaState(chat, slaClock, slaTargetMinutes)?.overdue).length, unread: chats.filter(chat => !chat.archived && Number(chat.unreadCount || 0) > 0).length, unassigned: chats.filter(chat => !chat.archived && !chat.assignedTo).length, open: chats.filter(chat => !chat.archived && (chat.status || "open") === "open").length, pending: chats.filter(chat => !chat.archived && chat.status === "pending").length, resolved: chats.filter(chat => !chat.archived && chat.status === "resolved").length, archived: chats.filter(chat => Boolean(chat.archived)).length }), [chats, slaClock]);
  const agentPerformance = useMemo(() => teamMembers.map(member => {
    const assignedChats = chats.filter(chat => !chat.archived && chat.assignedTo === member.uid);
    return {
      uid: member.uid,
      name: member.displayName || member.email || "Team member",
      total: assignedChats.length,
      open: assignedChats.filter(chat => (chat.status || "open") === "open").length,
      pending: assignedChats.filter(chat => chat.status === "pending").length,
      resolved: assignedChats.filter(chat => chat.status === "resolved").length
    };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)), [teamMembers, chats]);
  const visibleMessages = useMemo(() => messages.filter(message => {
    const date = asDate(message.timestamp);
    const from = messageDateFrom ? new Date(`${messageDateFrom}T00:00:00`) : null;
    const to = messageDateTo ? new Date(`${messageDateTo}T23:59:59.999`) : null;
    return (!savedOnly || Boolean((message as TenantMessage & { saved?: boolean }).saved)) &&
      (!messageSearch.trim() || `${message.text || ""} ${message.type || ""} ${message.mediaFilename || ""}`.toLowerCase().includes(messageSearch.trim().toLowerCase())) &&
      (!from || Boolean(date && date >= from)) && (!to || Boolean(date && date <= to));
  }), [messages, messageSearch, savedOnly, messageDateFrom, messageDateTo]);
  const currentChat = useMemo(() => chats.find((chat) => chat.id === selected), [chats, selected]);
  useEffect(() => { if (currentChat?.phoneNumberId) setSelectedPhoneNumberId(currentChat.phoneNumberId); }, [currentChat?.phoneNumberId]);
  const currentContact = useMemo(() => {
    const phone = (currentChat?.customerPhone || selected).replace(/[^0-9]/g, "");
    return contacts.find(contact => contact.phone.replace(/[^0-9]/g, "") === phone);
  }, [contacts, currentChat, selected]);

  useEffect(() => {
    setCustomerName(currentContact?.name || currentChat?.customerName || "");
    setCustomerEmail(currentContact?.email || "");
    setCustomerNotes(currentContact?.notes || "");
    setCustomerTags((currentContact?.tags || []).join(", "));
  }, [currentContact?.id, currentContact?.name, currentContact?.email, currentContact?.notes, currentChat?.customerName, selected]);

  async function checkConnectionHealth() {
    if (!organization || healthChecking) return;
    setHealthChecking(true); setError("");
    try {
      const results = await checkWhatsAppConnectionHealth(organization.id);
      setHealthResults(results);
      setHealthCheckedAt(results[0]?.checkedAt || new Date().toISOString());
    } catch (e) { setError(e instanceof Error ? e.message : "Connection health could not be checked."); }
    finally { setHealthChecking(false); }
  }

  async function saveCustomerInfo() {
    if (!organization || !currentChat) return;
    const phone = currentChat.customerPhone || selected;
    const name = customerName.trim() || currentChat.customerName || currentContact?.name || phone;
    setCustomerSaving(true); setError("");
    try {
      await saveTenantContact(organization.id, {
        name, phone, email: customerEmail.trim(), notes: customerNotes.trim(), source: currentContact?.source || "whatsapp", tags: [...new Set(customerTags.split(",").map(tag => tag.trim()).filter(Boolean).map(tag => tag.slice(0, 30)))].slice(0, 20)
      }, currentContact?.id);
      await refreshResources();
    } catch (e) { setError(e instanceof Error ? e.message : "Customer details could not be saved."); }
    finally { setCustomerSaving(false); }
  }

  async function retryFailedText(message: TenantMessage) {
    if (!organization || !selected || !message.text?.trim() || message.type !== "text" || message.direction !== "outgoing" || message.status !== "failed" || retryingMessageIds.includes(message.id) || retriedMessageIds.includes(message.id)) return;
    if (!message.phoneNumberId) {
      setError("Original WhatsApp number is not recorded for this message. Please select the correct number and send it again manually.");
      return;
    }
    setRetryingMessageIds(current => [...current, message.id]);
    setError("");
    try {
      await retryTenantFailedText(organization.id, selected, message.id);
      setRetriedMessageIds(current => [...current, message.id]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message retry could not be sent.");
    } finally {
      setRetryingMessageIds(current => current.filter(id => id !== message.id));
    }
  }

  async function retryFailedTemplate(message: TenantMessage) {
    if (!organization || !selected || message.type !== "template" || message.direction !== "outgoing" || message.status !== "failed" || retryingMessageIds.includes(message.id) || retriedMessageIds.includes(message.id)) return;
    setRetryingMessageIds(current => [...current, message.id]); setError("");
    try {
      await retryTenantFailedTemplate(organization.id, selected, message.id);
      setRetriedMessageIds(current => [...current, message.id]);
    } catch (e) { setError(e instanceof Error ? e.message : "Template retry could not be sent."); }
    finally { setRetryingMessageIds(current => current.filter(id => id !== message.id)); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!organization || !selected || !text || sending || deliveryUnknown) return;
    setSending(true); setError("");
    try { await sendTenantText(organization.id, selected, text, selectedPhoneNumberId || undefined); setDraft(""); }
    catch (e) { if (e && typeof e === "object" && "deliveryUnknown" in e && e.deliveryUnknown === true) setDeliveryUnknown(true); setError(e instanceof Error ? e.message : "Message could not be sent."); }
    finally { setSending(false); }
  }

  const deliveryAnalytics = useMemo(() => {
    const total = notificationDeliveries.length;
    const delivered = notificationDeliveries.filter(item => item.status === "delivered").length;
    const failed = total - delivered;
    const retried = notificationDeliveries.filter(item => item.attempts > 1).length;
    const attempts = notificationDeliveries.reduce((sum, item) => sum + Math.max(1, item.attempts || 1), 0);
    const daily = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (6 - index));
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      const items = notificationDeliveries.filter(item => {
        if (!item.createdAt) return false;
        const timestamp = new Date(item.createdAt).getTime();
        return timestamp >= date.getTime() && timestamp < next.getTime();
      });
      return {
        label: date.toLocaleDateString(undefined, { weekday: "short" }),
        total: items.length,
        delivered: items.filter(item => item.status === "delivered").length,
        failed: items.filter(item => item.status === "failed").length
      };
    });
    return { total, delivered, failed, retried, attempts, rate: total ? Math.round(delivered / total * 100) : 0, daily };
  }, [notificationDeliveries]);

  const teamDeliveryTypeTotals = useMemo(() => {
    const totals: Record<string, { total: number; delivered: number; failed: number; retried: number; attempts: number }> = {};
    for (const agent of teamDeliveryAnalytics) {
      for (const [type, stats] of Object.entries(agent.byType || {})) {
        if (!totals[type]) totals[type] = { total: 0, delivered: 0, failed: 0, retried: 0, attempts: 0 };
        totals[type].total += stats.total;
        totals[type].delivered += stats.delivered;
        totals[type].failed += stats.failed;
        totals[type].retried += stats.retried;
        totals[type].attempts += stats.attempts;
      }
    }
    return Object.entries(totals).map(([type, stats]) => ({
      type, ...stats, rate: stats.total ? Math.round(stats.delivered / stats.total * 100) : 0
    })).sort((a, b) => b.total - a.total);
  }, [teamDeliveryAnalytics]);

  const filteredDeliveryLogs = useMemo(() => notificationDeliveries.filter(item => {
    const timestamp = item.createdAt ? new Date(item.createdAt).getTime() : 0;
    const from = deliveryDateFrom ? new Date(deliveryDateFrom + "T00:00:00").getTime() : null;
    const to = deliveryDateTo ? new Date(deliveryDateTo + "T23:59:59.999").getTime() : null;
    const search = deliverySearch.trim().toLowerCase();
    return (deliveryStatusFilter === "all" || item.status === deliveryStatusFilter) &&
      (deliveryTypeFilter === "all" || item.type === deliveryTypeFilter) &&
      (!from || timestamp >= from) && (!to || timestamp <= to) &&
      (!search || [item.type, item.status, item.errorCode || ""].some(value => value.toLowerCase().includes(search)));
  }), [notificationDeliveries, deliveryStatusFilter, deliveryTypeFilter, deliverySearch, deliveryDateFrom, deliveryDateTo]);

  function exportMemberDeliveryReport() {
    if (!memberDeliveryReport) return;
    const columns = ["Timestamp", "Notification type", "Status", "Attempts", "Error code"];
    const rows = memberDeliveryReport.deliveries.map(item => [
      item.createdAt || "", item.type, item.status, String(item.attempts), item.errorCode || ""
    ]);
    const summaryRows = [
      ["Agent", memberDeliveryReport.member.name],
      ["Role", memberDeliveryReport.member.role],
      ["Delivery rate", memberDeliveryReport.summary.rate + "%"],
      ["Total records", String(memberDeliveryReport.summary.total)],
      ["Delivered", String(memberDeliveryReport.summary.delivered)],
      ["Failed", String(memberDeliveryReport.summary.failed)],
      ["Retried records", String(memberDeliveryReport.summary.retried)],
      ["Total attempts", String(memberDeliveryReport.summary.attempts)],
      [],
      columns,
      ...rows
    ];
    const csv = summaryRows.map(row => row.map(value => '"' + String(value ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "joy-inbox-agent-notification-report.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportTeamDeliveryAnalytics() {
    const columns = ["Team member", "Role", "Records", "Delivered", "Failed", "Retried records", "Total attempts", "Delivery rate", "Message delivered", "Message failed", "SLA delivered", "SLA failed", "Last activity"];
    const rows = teamDeliveryAnalytics.map(agent => [agent.name, agent.role, String(agent.total), String(agent.delivered), String(agent.failed), String(agent.retried), String(agent.attempts), agent.rate + "%", String(agent.byType?.message?.delivered || 0), String(agent.byType?.message?.failed || 0), String(agent.byType?.sla?.delivered || 0), String(agent.byType?.sla?.failed || 0), agent.lastActivityAt || ""]);
    const csv = [columns, ...rows].map(row => row.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "joy-inbox-team-notification-analytics.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportNotificationLogs() {
    const columns = ["Timestamp", "Type", "Status", "Attempts", "Error code"];
    const rows = filteredDeliveryLogs.map(item => [item.createdAt || "", item.type, item.status, String(item.attempts), item.errorCode || ""]);
    const csv = [columns, ...rows].map(row => row.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "joy-inbox-notification-delivery-logs.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-gray-500">Loading your workspace...</div>;

  return <main className="flex h-screen flex-col bg-[#eef2f3] text-gray-900">
    <header className="flex items-center justify-between bg-[#075e54] px-4 py-3 text-white shadow">
      <div className="flex items-center gap-3"><MessageCircle/><div><h1 className="font-bold">JOY INBOX</h1><p className="text-xs text-white/75">{organization?.name || user?.email}</p></div></div>
      <div className="flex items-center gap-3"><button type="button" disabled={pushSaving || pushReady} onClick={async () => { setPushSaving(true); try { await enablePushNotifications(); setPushReady(true); } catch (e) { setError(e instanceof Error ? e.message : "Push notifications could not be enabled."); } finally { setPushSaving(false); } }} className="rounded-full border border-white/40 px-3 py-1.5 text-xs font-medium disabled:opacity-70">{pushSaving ? "Enabling..." : pushReady ? "Alerts on" : "Enable alerts"}</button><button onClick={() => navigate("/setup")} title="Workspace settings"><Settings size={19}/></button><button onClick={() => void logout()} title="Sign out"><LogOut size={19}/></button></div>
    </header>
    <nav className="flex gap-2 overflow-x-auto border-b bg-white px-3 py-2">{(["chats", "notifications", "analytics", "contacts", "replies", "templates", ...(organization?.role === "agent" ? [] : ["campaigns" as const, "automation" as const, "billing" as const, "members" as const, "settings" as const])] as const).map((item) => <button key={item} onClick={() => setView(item)} className={`shrink-0 rounded-full px-4 py-2 text-sm capitalize ${view === item ? "bg-[#075e54] text-white" : "bg-gray-100 text-gray-700"}`}>{item === "notifications" ? `Notifications${notifications.filter(item => !item.read).length ? ` (${notifications.filter(item => !item.read).length})` : ""}` : item === "replies" ? "Quick Replies" : item === "templates" ? "Templates" : item === "members" ? "Members" : item === "analytics" ? "Analytics" : item}</button>)}</nav>
    {(view === "campaigns" ? <section className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6"><div className="mx-auto max-w-5xl"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">WhatsApp Campaigns</h2><p className="text-sm text-gray-500">Create, schedule and control approved-template campaigns. Sending begins only after you select Start or a scheduled time.</p></div><button type="button" onClick={() => void loadCampaignDrafts()} disabled={campaignLoading} className="rounded-lg border bg-white px-3 py-2 text-xs text-[#075e54]">{campaignLoading ? "Refreshing..." : "Refresh campaigns"}</button></div><form onSubmit={submitCampaignDraft} className="mb-5 grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2"><h3 className="text-sm font-semibold sm:col-span-2">Create campaign draft</h3><label className="text-xs text-gray-600">Campaign name<input required maxLength={100} value={campaignName} onChange={e => setCampaignName(e.target.value)} placeholder="November update" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label><label className="text-xs text-gray-600">Connected WhatsApp number<select required value={selectedPhoneNumberId} onChange={e => setSelectedPhoneNumberId(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Select number</option>{whatsappConnections.filter(item => item.connected).map(item => <option key={item.phoneNumberId} value={item.phoneNumberId}>{item.displayPhoneNumber || item.verifiedName || item.phoneNumberId}</option>)}</select></label><label className="text-xs text-gray-600">WhatsApp Business Account ID<input required inputMode="numeric" value={campaignWabaId} onChange={e => setCampaignWabaId(e.target.value.replace(/\D/g, "").slice(0, 32))} placeholder="WABA ID" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label><label className="text-xs text-gray-600">Approved template name<input required value={campaignTemplateName} onChange={e => setCampaignTemplateName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} placeholder="november_update" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label><label className="text-xs text-gray-600">Template language<input required value={campaignLanguage} onChange={e => setCampaignLanguage(e.target.value)} placeholder="en or en_US" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label><label className="text-xs text-gray-600">Template category<select value={campaignCategory} onChange={e => setCampaignCategory(e.target.value as typeof campaignCategory)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="MARKETING">Marketing</option><option value="UTILITY">Utility</option><option value="AUTHENTICATION">Authentication</option></select></label><label className="text-xs text-gray-600 sm:col-span-2">Default BODY variables <span className="text-gray-400">(one value per line)</span><textarea rows={2} value={campaignVariables} onChange={e => setCampaignVariables(e.target.value)} placeholder="November" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label><label className="text-xs text-gray-600 sm:col-span-2">Recipients <span className="text-gray-400">(one per line: international phone, consent date/time, consent source)</span><textarea required rows={6} value={campaignRecipientsCsv} onChange={e => setCampaignRecipientsCsv(e.target.value)} placeholder={"919876543210,2026-11-20T10:00:00Z,website signup\n919876543211,2026-11-21T11:30:00Z,checkout opt-in"} className="mt-1 w-full rounded-lg border p-2 font-mono text-xs"/></label><p className="text-[11px] text-gray-500 sm:col-span-2">Only enter recipients who genuinely opted in. Invalid, duplicate and previously opted-out numbers are skipped. Replies such as STOP and UNSUBSCRIBE are added to this workspace's suppression list. Server verifies template approval with Meta. This saves a draft. Start or schedule it from the campaign list when you are ready to send.</p><div className="sm:col-span-2"><button disabled={campaignSaving || !whatsappConnections.some(item => item.connected)} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{campaignSaving ? "Validating and saving..." : "Validate & save draft"}</button></div></form><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Saved campaigns</h3><span className="text-xs text-gray-500">Latest 50</span></div>{campaigns.length ? <div className="space-y-2">{campaigns.map(campaign => <article key={campaign.id} className="rounded-xl border bg-white p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{campaign.name}</strong><span className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold capitalize text-gray-600">{campaign.status}</span></div><p className="mt-1 text-xs text-gray-500">{campaign.templateName} · {campaign.language} · {campaign.category}</p><p className="mt-2 text-xs text-gray-600">{campaign.recipientCount} recipients · {campaign.skippedRecipients} skipped during validation · {campaign.phoneNumberId}</p><div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-gray-500 sm:grid-cols-4"><span>Sent <strong className="text-green-700">{campaign.sentCount || 0}</strong></span><span>Failed <strong className="text-red-600">{campaign.failedCount || 0}</strong></span><span>Uncertain <strong className="text-amber-700">{campaign.uncertainCount || 0}</strong></span><span>Delivered <strong className="text-green-700">{campaign.deliveredCount || 0}</strong></span><span>Read <strong>{campaign.readCount || 0}</strong></span><span>Delivery failed <strong className="text-red-600">{campaign.deliveryFailedCount || 0}</strong></span><span>Skipped <strong>{campaign.skippedCount || 0}</strong></span></div>{campaign.scheduledAt && <p className="mt-2 text-[11px] text-gray-500">Scheduled: {new Date(campaign.scheduledAt).toLocaleString()}</p>}<div className="mt-3 flex flex-wrap items-center gap-2">{campaign.status === "draft" && <><button type="button" disabled={campaignActionLoading === campaign.id} onClick={() => void changeCampaignStatus(campaign, "start")} className="rounded-lg bg-[#075e54] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Start now</button><input type="datetime-local" value={campaignScheduleAt} onChange={event => setCampaignScheduleAt(event.target.value)} className="min-w-0 rounded-lg border px-2 py-1.5 text-xs"/><button type="button" disabled={campaignActionLoading === campaign.id} onClick={() => void changeCampaignStatus(campaign, "schedule")} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54] disabled:opacity-50">Schedule</button></>}{["queued", "sending", "scheduled"].includes(campaign.status) && <button type="button" disabled={campaignActionLoading === campaign.id} onClick={() => void changeCampaignStatus(campaign, "pause")} className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50">Pause</button>}{campaign.status === "paused" && <button type="button" disabled={campaignActionLoading === campaign.id} onClick={() => void changeCampaignStatus(campaign, "resume")} className="rounded-lg bg-[#075e54] px-3 py-1.5 text-xs text-white disabled:opacity-50">Resume</button>}{["draft", "scheduled", "queued", "sending", "paused"].includes(campaign.status) && <button type="button" disabled={campaignActionLoading === campaign.id} onClick={() => void changeCampaignStatus(campaign, "cancel")} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 disabled:opacity-50">Cancel</button>}{campaignActionLoading === campaign.id && <span className="text-[11px] text-gray-400">Updating...</span>}</div><div className="mt-3 border-t pt-2"><button type="button" onClick={() => { if (campaignReportId === campaign.id) { setCampaignReportId(""); setCampaignReportRecipients([]); setCampaignReportCursor(null); } else void loadCampaignRecipientReport(campaign.id); }} className="text-xs font-medium text-[#075e54]">{campaignReportId === campaign.id ? "Hide recipient report" : "View recipient report"}</button>{campaignReportId === campaign.id && <div className="mt-2 space-y-2">{campaignReportRecipients.length > 0 && <div className="flex justify-end"><button type="button" onClick={() => exportCampaignRecipientReport(campaign.name)} className="rounded-lg border px-2 py-1 text-[10px] text-[#075e54]">Export loaded CSV</button></div>}{campaignReportLoading && !campaignReportRecipients.length ? <p className="text-xs text-gray-400">Loading recipients...</p> : campaignReportRecipients.length ? campaignReportRecipients.map(recipient => <div key={recipient.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-2 py-2 text-[11px]"><span className="font-medium text-gray-700">{recipient.phone}</span><span className="capitalize text-gray-600">{recipient.status}</span><span className="capitalize text-gray-600">{recipient.deliveryStatus || "Awaiting delivery"}</span>{(recipient.error || recipient.reason) && <span className="w-full text-red-600">{recipient.error || recipient.reason}</span>}</div>) : <p className="text-xs text-gray-400">No recipient records.</p>}{campaignReportCursor && <button type="button" disabled={campaignReportLoading} onClick={() => void loadCampaignRecipientReport(campaign.id, campaignReportCursor)} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54] disabled:opacity-50">{campaignReportLoading ? "Loading..." : "Load more recipients"}</button>}</div>}</div></article>)}</div> : <p className="rounded-xl border bg-white p-4 text-sm text-gray-500">{campaignLoading ? "Loading campaigns..." : "No campaigns saved yet. Create a draft above."}</p>}</div></section> : view === "billing" ? <section className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6"><div className="mx-auto max-w-4xl"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Workspace billing</h2><p className="text-sm text-gray-500">Manage the subscription for this Joy Inbox workspace.</p></div><button type="button" onClick={() => void loadBilling()} disabled={billingLoading} className="rounded-lg border bg-white px-3 py-2 text-xs text-[#075e54]">{billingLoading ? "Refreshing..." : "Refresh billing"}</button></div>{billingLoading && !billing ? <p className="rounded-xl border bg-white p-4 text-sm text-gray-500">Loading billing information...</p> : <>{billingNotice && <p className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{billingNotice}</p>}<div className="mb-5 rounded-xl border bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-gray-500">Current subscription</p><h3 className="mt-1 text-lg font-semibold capitalize">{billing?.subscription?.plan || "No active plan"}</h3><p className="mt-1 text-xs text-gray-500">Status: <strong className="capitalize text-gray-800">{billing?.subscription?.status || "not subscribed"}</strong></p>{billing?.subscription?.currentPeriodEnd && <p className="mt-1 text-xs text-gray-500">Current period ends {new Date(billing.subscription.currentPeriodEnd).toLocaleDateString()}</p>}{billing?.subscription?.cancelAtPeriodEnd && <p className="mt-1 text-xs text-amber-700">Cancellation is scheduled at the end of the billing period.</p>}</div>{billing?.subscription && <button type="button" disabled={billingAction !== ""} onClick={() => void openBillingPortal()} className="rounded-lg border px-3 py-2 text-xs font-medium text-[#075e54] disabled:opacity-50">{billingAction === "portal" ? "Opening..." : "Manage subscription"}</button>}</div></div><h3 className="mb-3 text-sm font-semibold">Available plans</h3>{billing?.plans.length ? <div className="grid gap-3 sm:grid-cols-3">{billing.plans.map(plan => <article key={plan.key} className="rounded-xl border bg-white p-4"><h4 className="font-semibold">{plan.name}</h4><p className="mt-1 text-xs text-gray-500">Subscription managed securely by Stripe.</p>{["active", "trialing", "past_due", "unpaid"].includes(billing?.subscription?.status || "") ? <p className="mt-4 text-xs text-gray-500">Use Manage subscription above to change this plan.</p> : <button type="button" disabled={billingAction !== ""} onClick={() => void startBillingCheckout(plan.key)} className="mt-4 w-full rounded-lg bg-[#075e54] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{billingAction === plan.key ? "Opening checkout..." : "Subscribe"}</button>}</article>)}</div> : <p className="rounded-xl border bg-white p-4 text-sm text-gray-500">Stripe plans are not configured yet. Add the Stripe Price IDs and billing return URLs to the backend secret environment to enable checkout.</p>}</>}</div></section> : view === "automation" ? <section className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6"><div className="mx-auto max-w-4xl"><div className="mb-4"><h2 className="text-lg font-semibold">Keyword Automation</h2><p className="text-sm text-gray-500">Build a reply sequence of up to five messages. The first matching rule by priority runs, and its replies are sent in order.</p></div><form onSubmit={submitAutomationRule} className="mb-5 grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2"><h3 className="text-sm font-semibold sm:col-span-2">{editingAutomationId ? "Edit automation rule" : "Create automation rule"}</h3><input required maxLength={80} value={automationName} onChange={event => setAutomationName(event.target.value)} placeholder="Rule name (e.g. Pricing enquiry)" className="rounded-lg border p-2 text-sm"/><input required maxLength={80} value={automationKeyword} onChange={event => setAutomationKeyword(event.target.value)} placeholder="Keyword (e.g. price)" className="rounded-lg border p-2 text-sm"/><select value={automationMatchType} onChange={event => setAutomationMatchType(event.target.value as typeof automationMatchType)} className="rounded-lg border bg-white p-2 text-sm"><option value="contains">Message contains keyword</option><option value="exact">Message exactly matches</option><option value="starts_with">Message starts with keyword</option></select><input type="number" min={0} max={1000} value={automationPriority} onChange={event => setAutomationPriority(Number(event.target.value))} className="rounded-lg border p-2 text-sm" aria-label="Priority (lower runs first)"/><div className="space-y-3 sm:col-span-2"><div className="flex items-center justify-between"><h4 className="text-sm font-semibold">Reply sequence ({automationSteps.length}/5)</h4><button type="button" disabled={automationSteps.length >= 5} onClick={() => setAutomationSteps(current => [...current, { message: "", delaySeconds: 0 }])} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54] disabled:opacity-40">+ Add reply step</button></div>{automationSteps.map((step, index) => <div key={index} className="rounded-lg border bg-gray-50 p-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-gray-600">Step {index + 1}</span><button type="button" disabled={automationSteps.length <= 1} onClick={() => setAutomationSteps(current => current.filter((_, itemIndex) => itemIndex !== index))} className="text-xs text-red-600 disabled:opacity-40">Remove</button></div><textarea required maxLength={1024} rows={3} value={step.message} onChange={event => setAutomationSteps(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, message: event.target.value } : item))} placeholder={index === 0 ? "First automatic reply..." : "Next reply message..."} className="w-full rounded-lg border bg-white p-2 text-sm"/>{index > 0 && <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">Wait before this step <input type="number" min={0} max={86400} value={step.delaySeconds} onChange={event => setAutomationSteps(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, delaySeconds: Math.max(0, Math.min(86400, Number(event.target.value) || 0)) } : item))} className="w-24 rounded-md border bg-white p-1.5 text-sm"/> seconds <span className="text-gray-400">(max 24 hours)</span></label>}</div>)}</div><div className="flex gap-2 sm:col-span-2"><button disabled={automationSaving} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{automationSaving ? "Saving..." : editingAutomationId ? "Update rule" : "Create rule"}</button>{editingAutomationId && <button type="button" onClick={resetAutomationForm} className="rounded-lg border px-4 py-2 text-sm">Cancel edit</button>}</div></form><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Saved rules ({automationRules.length}/100)</h3><button type="button" onClick={() => { if (!organization) return; setAutomationLoading(true); void Promise.all([listOrganizationAutomationRules(organization.id), listOrganizationAutomationRuns(organization.id), getOrganizationAutomationQueueHealth(organization.id)]).then(([rules, runs, queueHealth]) => { setAutomationRules(rules); setAutomationRuns(runs); setAutomationQueueHealth(queueHealth); }).catch(error => setError(error instanceof Error ? error.message : "Automation data could not refresh.")).finally(() => setAutomationLoading(false)); }} className="rounded-lg border bg-white px-3 py-1.5 text-xs text-[#075e54]">Refresh</button></div>{automationLoading ? <p className="rounded-xl border bg-white p-4 text-sm text-gray-500">Loading automation rules...</p> : automationRules.length ? <div className="space-y-2">{automationRules.map(rule => <div key={rule.id} className="rounded-xl border bg-white p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{rule.name}</strong><span className={`rounded-full px-2 py-0.5 text-[10px] ${rule.enabled ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}`}>{rule.enabled ? "Active" : "Paused"}</span></div><p className="mt-1 text-xs text-gray-500">When message {rule.matchType === "contains" ? "contains" : rule.matchType === "exact" ? "exactly matches" : "starts with"} <strong className="text-gray-700">“{rule.keyword}”</strong> · Priority {rule.priority}</p><div className="mt-2 space-y-1">{(rule.steps?.length ? rule.steps : [{ message: rule.response, delaySeconds: 0 }]).map((step, index) => <p key={index} className="whitespace-pre-wrap text-sm"><span className="mr-2 text-xs text-gray-400">{index + 1}.</span>{step.message}{index > 0 && step.delaySeconds > 0 ? <span className="ml-2 text-[10px] text-gray-400">· wait {step.delaySeconds}s</span> : null}</p>)}</div></div><div className="flex flex-wrap gap-2"><button type="button" disabled={automationSaving} onClick={() => void toggleAutomationRule(rule)} className="rounded-lg border px-2 py-1 text-xs">{rule.enabled ? "Pause" : "Enable"}</button><button type="button" onClick={() => editAutomationRule(rule)} className="rounded-lg border px-2 py-1 text-xs text-[#075e54]">Edit</button><button type="button" disabled={automationSaving} onClick={() => void removeAutomationRule(rule)} className="rounded-lg border px-2 py-1 text-xs text-red-600">Delete</button></div></div></div>)}</div> : <p className="rounded-xl border bg-white p-4 text-sm text-gray-500">No automation rules yet. Create a rule above to start with keyword auto-replies.</p>}<section className="mt-6 rounded-xl border bg-white p-4"><div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Queue health</h3><p className="text-xs text-gray-500">Delayed automation delivery overview</p></div><button type="button" onClick={() => { if (!organization) return; void getOrganizationAutomationQueueHealth(organization.id).then(setAutomationQueueHealth).catch(error => setError(error instanceof Error ? error.message : "Queue health could not refresh.")); }} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54]">Refresh</button></div>{automationQueueHealth ? <><div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">{(["queued", "sending", "sent", "failed", "skipped", "uncertain"] as const).map(status => <div key={status} className="rounded-lg bg-gray-50 p-3"><span className="block text-xs capitalize text-gray-500">{status.replace(/_/g, " ")}</span><strong className="text-xl text-gray-900">{automationQueueHealth.counts[status] || 0}</strong></div>)}</div><p className="mt-3 text-xs text-gray-500">Due now: {automationQueueHealth.dueNow} · Worker batch limit: {automationQueueHealth.maxJobsPerInvocation} · Retry attempts: {automationQueueHealth.maxAttempts}</p>{automationQueueHealth.recentIssues.length > 0 && <div className="mt-3 space-y-2"><h4 className="text-xs font-semibold text-red-700">Recent failures / uncertain deliveries</h4>{automationQueueHealth.recentIssues.slice(0, 5).map(issue => <div key={issue.id} className="rounded-lg bg-red-50 p-2 text-xs"><strong>{issue.status} · step {issue.step}</strong><span className="ml-2 text-gray-600">{issue.customerPhone}</span><p className="mt-1 text-red-700">{issue.error || "Needs review"}</p></div>)}</div>}</> : <p className="text-xs text-gray-500">Queue health is not available yet.</p>}</section><section className="mt-7"><div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Recent execution history</h3><p className="text-xs text-gray-500">Latest {automationRuns.length} runs · up to 50 records</p></div><button type="button" onClick={() => { if (!organization) return; void listOrganizationAutomationRuns(organization.id).then(setAutomationRuns).catch(error => setError(error instanceof Error ? error.message : "Run history could not refresh.")); }} className="rounded-lg border bg-white px-3 py-1.5 text-xs text-[#075e54]">Refresh history</button></div>{automationRuns.length ? <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full min-w-[620px] text-left text-xs"><thead className="bg-gray-50 text-gray-500"><tr><th className="p-3">Rule / customer</th><th className="p-3">Status</th><th className="p-3">Steps</th><th className="p-3">Time</th></tr></thead><tbody>{automationRuns.map(run => <tr key={run.id} className="border-t"><td className="p-3"><strong className="block text-gray-800">{run.ruleName}</strong><span className="text-gray-500">{run.customerPhone}</span>{run.error && <span className="mt-1 block max-w-xs text-red-600">{run.error}</span>}{run.reason && <span className="mt-1 block text-gray-500">{run.reason.replace(/_/g, " ")}</span>}</td><td className="p-3"><span className={`rounded-full px-2 py-1 ${run.status === "sent" ? "bg-green-100 text-green-800" : run.status === "partially_failed" || run.status === "failed" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"}`}>{run.status.replace(/_/g, " ")}</span></td><td className="p-3 tabular-nums">{run.completedSteps}/{run.totalSteps}</td><td className="p-3 text-gray-500">{run.createdAt ? new Date(run.createdAt).toLocaleString() : "—"}</td></tr>)}</tbody></table></div> : <p className="rounded-xl border bg-white p-4 text-sm text-gray-500">No automation runs have been recorded yet.</p>}</section><p className="mt-4 text-[11px] text-gray-500">Rules only match incoming text messages. Automatic replies are sent only inside WhatsApp’s 24-hour customer service window. Only one matching rule runs per incoming message. Each flow supports up to five text replies, with optional delays of up to 24 hours before later steps. Owners and admins can manage rules.</p></div></section> : view === "notifications" ? <section className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6"><div className="mx-auto max-w-3xl"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Notification Center</h2><p className="text-sm text-gray-500">Assignments, conversation updates and SLA alerts · refreshes automatically</p></div><div className="flex items-center gap-2"><span className="rounded-full bg-[#d9fdd3] px-3 py-1 text-xs font-semibold text-[#075e54]">{notifications.filter(item => !item.read).length} unread</span><button type="button" disabled={markingAllNotifications || !notifications.some(item => !item.read)} onClick={() => void markAllNotificationsRead()} className="rounded-lg border bg-white px-3 py-2 text-xs font-medium text-[#075e54] disabled:opacity-40">{markingAllNotifications ? "Marking..." : "Mark all read"}</button></div></div><div className="mb-4 rounded-xl border bg-white p-4"><div className="mb-3"><h3 className="text-sm font-semibold">Notification preferences</h3><p className="text-xs text-gray-500">Choose which alerts you want to receive for this account.</p></div><div className="grid gap-3 sm:grid-cols-2">{([{key:"assignment",label:"Assignments",description:"When a chat is assigned to you"},{key:"status",label:"Status updates",description:"When a conversation status changes"},{key:"sla",label:"SLA alerts",description:"When your response deadline is overdue"},{key:"soundEnabled",label:"Notification sound",description:"Play a short sound for new alerts while Joy Inbox is open"},{key:"desktopEnabled",label:"Desktop notifications",description:"Show browser notifications when permission is allowed"}] as const).map(option => <label key={option.key} className="flex cursor-pointer items-start gap-2 rounded-lg border p-3"><input type="checkbox" className="mt-0.5 accent-[#075e54]" checked={notificationPreferences[option.key]} disabled={Boolean(savingNotificationPreference)} onChange={event => void updateNotificationPreference(option.key, event.target.checked)}/><span><span className="block text-sm font-medium">{option.label}{savingNotificationPreference === option.key ? " · Saving..." : ""}</span><span className="mt-0.5 block text-xs text-gray-500">{option.description}</span></span></label>)}</div><button type="button" onClick={() => playNotificationSound()} className="mt-3 rounded-lg border px-3 py-2 text-xs font-medium text-[#075e54]">Test notification sound</button><p className="mt-2 text-[11px] text-gray-400">Sound plays while Joy Inbox is open. Browser notifications also require permission from your browser and device settings.</p></div>{organization && ["owner", "admin"].includes(organization.role) && <div className="mb-4 rounded-xl border bg-white p-4"><div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-sm font-semibold">Team delivery analytics</h3><p className="text-xs text-gray-500">Push delivery attempts by active team member · up to 500 records per member</p></div><div className="flex flex-wrap gap-2"><label className="text-[10px] text-gray-500">From<input type="date" value={teamDeliveryDateFrom} max={teamDeliveryDateTo || undefined} onChange={event => setTeamDeliveryDateFrom(event.target.value)} className="mt-1 block rounded-lg border bg-white p-1.5 text-xs"/></label><label className="text-[10px] text-gray-500">To<input type="date" value={teamDeliveryDateTo} min={teamDeliveryDateFrom || undefined} onChange={event => setTeamDeliveryDateTo(event.target.value)} className="mt-1 block rounded-lg border bg-white p-1.5 text-xs"/></label><button type="button" onClick={() => { if (organization) { setTeamDeliveryLoading(true); void listTeamNotificationDeliveryAnalytics(organization.id, { from: teamDeliveryDateFrom || undefined, to: teamDeliveryDateTo || undefined }).then(setTeamDeliveryAnalytics).catch(error => setError(error instanceof Error ? error.message : "Team analytics could not refresh.")).finally(() => setTeamDeliveryLoading(false)); } }} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54]">Refresh team</button><button type="button" disabled={!teamDeliveryAnalytics.length} onClick={exportTeamDeliveryAnalytics} className="rounded-lg bg-[#075e54] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">Export CSV</button></div></div>{teamDeliveryLoading ? <p className="text-xs text-gray-500">Loading team analytics...</p> : teamDeliveryAnalytics.length ? <><div className="mb-4"><h4 className="mb-2 text-xs font-semibold">Delivery by notification type</h4><div className="grid gap-2 sm:grid-cols-2">{teamDeliveryTypeTotals.map(item => <div key={item.type} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold capitalize">{item.type.replace(/[_-]/g, " ")}</span><span className="text-xs font-semibold text-[#075e54]">{item.rate}% delivered</span></div><div className="mt-2 grid grid-cols-4 gap-2 text-[10px] text-gray-500"><span>Total<strong className="block text-sm text-gray-800">{item.total}</strong></span><span>Delivered<strong className="block text-sm text-green-700">{item.delivered}</strong></span><span>Failed<strong className="block text-sm text-red-600">{item.failed}</strong></span><span>Retries<strong className="block text-sm text-gray-800">{item.retried}</strong></span></div></div>)}</div></div><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-xs"><thead className="text-gray-500"><tr><th className="py-2 pr-3 font-medium">Team member</th><th className="py-2 pr-3 font-medium">Attempts</th><th className="py-2 pr-3 font-medium">Delivered</th><th className="py-2 pr-3 font-medium">Failed</th><th className="py-2 pr-3 font-medium">Retries</th><th className="py-2 font-medium">Rate</th></tr></thead><tbody>{teamDeliveryAnalytics.map(agent => <tr key={agent.uid} className="border-t"><td className="py-2 pr-3"><span className="font-medium">{agent.name}</span><span className="ml-2 text-[10px] text-gray-400">{agent.role}</span></td><td className="py-2 pr-3 tabular-nums">{agent.attempts}</td><td className="py-2 pr-3 text-green-700 tabular-nums">{agent.delivered}</td><td className="py-2 pr-3 text-red-600 tabular-nums">{agent.failed}</td><td className="py-2 pr-3 tabular-nums">{agent.retried}</td><td className="py-2 tabular-nums">{agent.rate}%</td><td className="py-2 text-right"><button type="button" onClick={() => { if (!organization) return; setSelectedDeliveryAgent(agent.uid); setMemberDeliveryReport(null); setMemberDeliveryLoading(true); void getMemberNotificationDeliveryReport(organization.id, agent.uid, { from: teamDeliveryDateFrom || undefined, to: teamDeliveryDateTo || undefined }).then(setMemberDeliveryReport).catch(error => setError(error instanceof Error ? error.message : "Agent report could not load.")).finally(() => setMemberDeliveryLoading(false)); }} className="rounded-lg border px-2 py-1 text-[10px] font-medium text-[#075e54]">View report</button></td></tr>)}</tbody></table></div>{selectedDeliveryAgent && <div className="mt-4 rounded-lg border bg-gray-50 p-3">{memberDeliveryLoading ? <p className="text-xs text-gray-500">Loading agent report...</p> : memberDeliveryReport ? <><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold">{memberDeliveryReport.member.name} · Detailed report</h4><p className="text-[10px] text-gray-500">{memberDeliveryReport.member.role} · latest {memberDeliveryReport.deliveries.length} records in selected date range</p></div><div className="flex gap-2"><button type="button" disabled={!memberDeliveryReport.deliveries.length} onClick={exportMemberDeliveryReport} className="rounded-lg border bg-white px-2 py-1 text-[10px] text-[#075e54] disabled:opacity-40">Export CSV</button><button type="button" onClick={() => { setSelectedDeliveryAgent(""); setMemberDeliveryReport(null); }} className="rounded-lg border bg-white px-2 py-1 text-[10px]">Close</button></div></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-5"><div className="rounded-lg bg-white p-2"><p className="text-[10px] text-gray-500">Delivery rate</p><strong className="text-lg text-[#075e54]">{memberDeliveryReport.summary.rate}%</strong></div><div className="rounded-lg bg-white p-2"><p className="text-[10px] text-gray-500">Delivered</p><strong className="text-lg text-green-700">{memberDeliveryReport.summary.delivered}</strong></div><div className="rounded-lg bg-white p-2"><p className="text-[10px] text-gray-500">Failed</p><strong className="text-lg text-red-600">{memberDeliveryReport.summary.failed}</strong></div><div className="rounded-lg bg-white p-2"><p className="text-[10px] text-gray-500">Retries</p><strong className="text-lg">{memberDeliveryReport.summary.retried}</strong></div><div className="rounded-lg bg-white p-2"><p className="text-[10px] text-gray-500">Total attempts</p><strong className="text-lg">{memberDeliveryReport.summary.attempts}</strong></div></div><div className="mt-3"><h5 className="mb-2 text-xs font-semibold">By notification type</h5><div className="grid gap-2 sm:grid-cols-2">{Object.entries(memberDeliveryReport.summary.byType).map(([type, stats]) => <div key={type} className="rounded-lg bg-white p-2 text-xs"><div className="flex justify-between gap-2"><strong className="capitalize">{type.replace(/[_-]/g, " ")}</strong><span>{stats.total ? Math.round(stats.delivered / stats.total * 100) : 0}% delivered</span></div><p className="mt-1 text-[10px] text-gray-500">Total {stats.total} · Delivered {stats.delivered} · Failed {stats.failed} · Retries {stats.retried}</p></div>)}</div></div><div className="mt-3"><h5 className="mb-2 text-xs font-semibold">Recent delivery history</h5><div className="max-h-64 overflow-y-auto rounded-lg bg-white"><table className="w-full text-left text-[11px]"><thead className="sticky top-0 bg-gray-100 text-gray-500"><tr><th className="p-2">Time</th><th className="p-2">Type</th><th className="p-2">Status</th><th className="p-2">Attempts</th><th className="p-2">Error</th></tr></thead><tbody>{memberDeliveryReport.deliveries.map(item => <tr key={item.id} className="border-t"><td className="p-2 whitespace-nowrap">{item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}</td><td className="p-2 capitalize">{item.type}</td><td className={`p-2 font-medium ${item.status === "delivered" ? "text-green-700" : "text-red-600"}`}>{item.status}</td><td className="p-2 tabular-nums">{item.attempts}</td><td className="p-2">{item.errorCode || "—"}</td></tr>)}</tbody></table>{!memberDeliveryReport.deliveries.length && <p className="p-3 text-xs text-gray-500">No delivery records in this date range.</p>}</div>{memberDeliveryReport.capped && <p className="mt-1 text-[10px] text-amber-700">Showing the latest 200 records. Narrow the date range for a more focused report.</p>}</div></> : <div className="flex items-center justify-between"><p className="text-xs text-gray-500">Agent report is not available.</p><button type="button" onClick={() => setSelectedDeliveryAgent("")} className="text-xs text-[#075e54]">Close</button></div>}</div>}</> : <p className="text-xs text-gray-500">No team push delivery records yet.</p>}<p className="mt-2 text-[10px] text-gray-400">This reports FCM push delivery, not whether a person opened or read a notification. Each member is sampled independently.</p></div>}
<div className="mb-4 rounded-xl border bg-white p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Delivery monitoring</h3><p className="text-xs text-gray-500">Filter the latest 100 push attempts and export matching rows.</p></div><div className="flex gap-2"><button type="button" onClick={() => { if (organization) void listNotificationDeliveries(organization.id).then(setNotificationDeliveries).catch(error => setError(error instanceof Error ? error.message : "Delivery history could not refresh.")); }} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54]">Refresh</button><button type="button" disabled={!filteredDeliveryLogs.length} onClick={exportNotificationLogs} className="rounded-lg bg-[#075e54] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">Export CSV</button></div></div><div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg bg-gray-50 p-3"><p className="text-[11px] text-gray-500">Delivery rate</p><p className="mt-1 text-xl font-semibold text-[#075e54]">{deliveryAnalytics.rate}%</p><p className="text-[10px] text-gray-400">of latest {deliveryAnalytics.total} records</p></div><div className="rounded-lg bg-gray-50 p-3"><p className="text-[11px] text-gray-500">Delivered</p><p className="mt-1 text-xl font-semibold text-green-700">{deliveryAnalytics.delivered}</p></div><div className="rounded-lg bg-gray-50 p-3"><p className="text-[11px] text-gray-500">Failed</p><p className="mt-1 text-xl font-semibold text-red-700">{deliveryAnalytics.failed}</p></div><div className="rounded-lg bg-gray-50 p-3"><p className="text-[11px] text-gray-500">Retried records</p><p className="mt-1 text-xl font-semibold">{deliveryAnalytics.retried}</p><p className="text-[10px] text-gray-400">{deliveryAnalytics.attempts} total attempts</p></div></div><div className="mb-4 rounded-lg border p-3"><div className="mb-3 flex items-center justify-between"><h4 className="text-xs font-semibold">Daily notification trend</h4><span className="text-[10px] text-gray-400">Last 7 days · latest 100 records</span></div><div className="flex h-28 items-end gap-2">{deliveryAnalytics.daily.map(day => { const max = Math.max(1, ...deliveryAnalytics.daily.map(item => item.total)); return <div key={day.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"><span className="text-[10px] text-gray-500">{day.total || ""}</span><div className="flex w-full max-w-8 items-end overflow-hidden rounded-t bg-gray-100" style={{height: "72px"}}><div className="w-full bg-[#128c7e]" style={{height: (day.delivered / max * 72) + "px"}}/><div className="w-full bg-red-400" style={{height: (day.failed / max * 72) + "px"}}/></div><span className="text-[10px] text-gray-500">{day.label}</span></div>; })}</div><div className="mt-2 flex gap-3 text-[10px] text-gray-500"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#128c7e]"/>Delivered</span><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-400"/>Failed</span></div></div><div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3"><label className="text-[11px] text-gray-500">Status<select value={deliveryStatusFilter} onChange={e => setDeliveryStatusFilter(e.target.value as "all" | "delivered" | "failed")} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"><option value="all">All statuses</option><option value="delivered">Delivered</option><option value="failed">Failed</option></select></label><label className="text-[11px] text-gray-500">Type<select value={deliveryTypeFilter} onChange={e => setDeliveryTypeFilter(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"><option value="all">All types</option><option value="message">Incoming message</option><option value="sla">SLA alert</option></select></label><label className="col-span-2 text-[11px] text-gray-500 sm:col-span-1">Search<input value={deliverySearch} onChange={e => setDeliverySearch(e.target.value)} placeholder="Type or error code" className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"/></label><label className="text-[11px] text-gray-500">From<input type="date" value={deliveryDateFrom} max={deliveryDateTo || undefined} onChange={e => setDeliveryDateFrom(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"/></label><label className="text-[11px] text-gray-500">To<input type="date" value={deliveryDateTo} min={deliveryDateFrom || undefined} onChange={e => setDeliveryDateTo(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"/></label></div>{deliveryLogsLoading ? <p className="text-xs text-gray-500">Loading delivery history...</p> : filteredDeliveryLogs.length ? <div className="space-y-2">{filteredDeliveryLogs.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><p className="text-sm font-medium capitalize">{item.type.replace(/_/g, " ")} <span className={item.status === "delivered" ? "text-green-700" : "text-red-700"}>· {item.status}</span></p><p className="text-xs text-gray-500">{item.createdAt ? new Date(item.createdAt).toLocaleString() : "Time unavailable"} · {item.attempts} attempt{item.attempts === 1 ? "" : "s"}</p>{item.errorCode && <p className="mt-1 text-xs text-red-700">Error: {item.errorCode}</p>}</div></div>)}</div> : <p className="text-xs text-gray-500">{notificationDeliveries.length ? "No delivery logs match these filters." : "No push delivery attempts recorded yet."}</p>}</div><div className="mb-4 rounded-xl border bg-white p-4"><div className="mb-3"><h3 className="text-sm font-semibold">Registered devices</h3><p className="text-xs text-gray-500">Manage browsers and devices receiving push alerts for your account. Up to 50 recent devices are shown.</p></div>{pushDevicesLoading ? <p className="text-xs text-gray-500">Loading devices...</p> : pushDevices.length ? <div className="space-y-2">{pushDevices.map(device => <div key={device.installationId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0"><p className="text-sm font-medium">{device.deviceName}</p><p className="text-xs text-gray-500">{device.platform} · Last active {device.updatedAt ? new Date(device.updatedAt).toLocaleString() : "unknown"}</p></div><button type="button" disabled={Boolean(revokingDeviceId)} onClick={() => void removePushDevice(device)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50">{revokingDeviceId === device.installationId ? "Removing..." : "Remove"}</button></div>)}</div> : <p className="text-xs text-gray-500">No registered push devices. Tap Enable alerts on this device to register it.</p>}</div><div className="mb-4 flex flex-wrap gap-2">{([{id:"all",label:"All"},{id:"unread",label:"Unread"},{id:"assignment",label:"Assignments"},{id:"status",label:"Status"},{id:"sla",label:"SLA alerts"}] as const).map(filter => <button key={filter.id} type="button" onClick={() => setNotificationFilter(filter.id)} className={`rounded-full px-3 py-1.5 text-xs font-medium ${notificationFilter === filter.id ? "bg-[#075e54] text-white" : "border bg-white text-gray-600"}`}>{filter.label}</button>)}</div>{notificationsLoading ? <p className="py-10 text-center text-sm text-gray-500">Loading notifications...</p> : notifications.filter(item => notificationFilter === "all" || (notificationFilter === "unread" ? !item.read : item.type === notificationFilter)).length ? <div className="space-y-2">{notifications.filter(item => notificationFilter === "all" || (notificationFilter === "unread" ? !item.read : item.type === notificationFilter)).map(item => <button key={item.id} type="button" onClick={() => void openNotification(item)} className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition hover:border-[#075e54] ${item.read ? "border-gray-200 bg-white" : "border-[#b7e4c7] bg-[#f0fff4]"}`}><span className="mt-0.5 rounded-full bg-[#e7f5ec] p-2 text-[#075e54]"><Bell size={17}/></span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><strong className="text-sm">{item.title}</strong>{!item.read && <span className="h-2 w-2 shrink-0 rounded-full bg-[#16a34a]"/>}</span><span className="mt-1 block text-sm text-gray-600">{item.body}</span><span className="mt-2 block text-xs text-gray-400">{new Date(item.createdAt).toLocaleString()}</span></span></button>)}</div> : <div className="rounded-xl border border-dashed bg-white p-10 text-center"><Bell className="mx-auto mb-3 text-gray-300" size={30}/><p className="font-medium text-gray-700">{notificationFilter === "all" ? "You're all caught up" : "No matching notifications"}</p><p className="mt-1 text-sm text-gray-500">New assignments and SLA alerts will appear here.</p></div>}</div></section> : view === "analytics" ? <section className="flex-1 space-y-5 overflow-y-auto p-4 md:p-6"><div><h2 className="text-lg font-semibold">Inbox analytics</h2><p className="mt-1 text-sm text-gray-500">Live overview of conversations in this workspace. Archived chats are excluded from active totals.</p></div><div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{([{label:"Active conversations",value:inboxAnalytics.total},{label:"SLA overdue ({slaTargetMinutes} min)",value:inboxAnalytics.slaOverdue},{label:"Unread conversations",value:inboxAnalytics.unread},{label:"Unassigned",value:inboxAnalytics.unassigned},{label:"Open",value:inboxAnalytics.open},{label:"Pending",value:inboxAnalytics.pending},{label:"Resolved",value:inboxAnalytics.resolved},{label:"Archived",value:inboxAnalytics.archived}] as const).map(metric => <div key={metric.label} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><p className="text-xs font-medium text-gray-500">{metric.label}</p><p className="mt-2 text-2xl font-semibold tabular-nums text-[#075e54]">{metric.value}</p></div>)}</div><div className="rounded-xl border border-gray-200 bg-white p-4"><h3 className="font-semibold">Conversation status</h3><div className="mt-3 space-y-3">{([{label:"Open",value:inboxAnalytics.open},{label:"Pending",value:inboxAnalytics.pending},{label:"Resolved",value:inboxAnalytics.resolved}] as const).map(item => <div key={item.label}><div className="mb-1 flex justify-between text-xs text-gray-600"><span>{item.label}</span><span>{item.value}</span></div><div className="h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-[#128c7e]" style={{width:`${inboxAnalytics.total ? item.value / inboxAnalytics.total * 100 : 0}%`}}/></div></div>)}</div></div><div className="rounded-xl border border-gray-200 bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">Agent performance</h3><p className="mt-1 text-xs text-gray-500">Current conversation ownership and status by active teammate. Archived chats are excluded.</p></div><span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">{agentPerformance.length} agents</span></div>{agentPerformance.length ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead><tr className="border-b text-xs text-gray-500"><th className="pb-2 font-medium">Agent</th><th className="pb-2 text-right font-medium">Assigned</th><th className="pb-2 text-right font-medium">Open</th><th className="pb-2 text-right font-medium">Pending</th><th className="pb-2 text-right font-medium">Resolved</th></tr></thead><tbody>{agentPerformance.map(agent => <tr key={agent.uid} className="border-b last:border-0"><td className="py-3 font-medium text-gray-800">{agent.name}</td><td className="py-3 text-right tabular-nums">{agent.total}</td><td className="py-3 text-right tabular-nums">{agent.open}</td><td className="py-3 text-right tabular-nums">{agent.pending}</td><td className="py-3 text-right tabular-nums">{agent.resolved}</td></tr>)}</tbody></table></div> : <p className="py-6 text-center text-sm text-gray-500">No active teammates found.</p>}<p className="mt-3 text-[11px] text-gray-400">These are live counts of conversations currently assigned to each agent, not historical totals or response-time scores.</p></div><div className="rounded-xl border border-gray-200 bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Historical agent activity</h3><p className="mt-1 text-xs text-gray-500">Assignment, resolution and first human reply activity recorded in this workspace.</p></div><select aria-label="Historical performance period" value={agentHistoryDays} onChange={e => setAgentHistoryDays(Number(e.target.value) as 7 | 30 | 90)} className="rounded-lg border bg-white px-3 py-2 text-xs"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></div>{agentHistoryLoading ? <p className="py-6 text-center text-sm text-gray-500">Loading historical activity...</p> : agentHistoryError ? <p role="alert" className="py-4 text-sm text-red-700">{agentHistoryError}</p> : agentHistory.length ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm"><thead><tr className="border-b text-xs text-gray-500"><th className="pb-2 font-medium">Team member</th><th className="pb-2 text-right font-medium">Assigned</th><th className="pb-2 text-right font-medium">Resolved actions</th><th className="pb-2 text-right font-medium">Avg. first reply</th><th className="pb-2 text-right font-medium">SLA met</th><th className="pb-2 text-right font-medium">Breaches</th></tr></thead><tbody>{agentHistory.map(item => <tr key={item.uid} className="border-b last:border-0"><td className="py-3 font-medium text-gray-800">{teamMembers.find(member => member.uid === item.uid)?.displayName || teamMembers.find(member => member.uid === item.uid)?.email || item.email || "Former team member"}</td><td className="py-3 text-right tabular-nums">{item.assignedCount}</td><td className="py-3 text-right tabular-nums">{item.resolvedCount}</td><td className="py-3 text-right tabular-nums">{item.averageResponseMs == null ? "—" : item.averageResponseMs < 60000 ? "<1 min" : item.averageResponseMs < 3600000 ? Math.round(item.averageResponseMs / 60000) + " min" : (item.averageResponseMs / 3600000).toFixed(1) + " hr"}</td><td className="py-3 text-right tabular-nums">{item.slaMetPercent == null ? "—" : item.slaMetPercent + "%"}</td><td className="py-3 text-right tabular-nums">{item.slaBreachCount ?? 0}</td></tr>)}</tbody></table></div> : <p className="py-6 text-center text-sm text-gray-500">No assignment or resolution actions were recorded in this period.</p>}<p className="mt-3 text-[11px] text-gray-400">Assigned = assignment actions; Resolved actions = status changes to Resolved. Avg. first reply = average time from a customer message to the first agent reply (text, template or media; automated greetings are excluded). SLA target = {slaTargetMinutes} minutes; met = reply within target, breach = reply after target.. Response tracking starts with this release; earlier replies and template/media replies are not included.</p></div></section> : view === "members" && organization ? <OrganizationMembers organizationId={organization.id} actorRole={organization.role} /> : view === "settings" ? <section className="flex-1 space-y-5 overflow-y-auto bg-white p-4"><div><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Connection status</h2><button type="button" disabled={healthChecking || !whatsappConnections.length} onClick={() => void checkConnectionHealth()} className="rounded-lg border px-3 py-2 text-xs font-medium text-[#075e54] disabled:opacity-50">{healthChecking ? "Checking..." : "Check WhatsApp numbers"}</button></div><p className="mt-2 text-sm">WhatsApp primary: <strong className={connectionStatus?.whatsapp?.connected ? "text-green-700" : "text-red-600"}>{connectionStatus?.whatsapp?.connected ? "Connected" : connectionStatus?.whatsapp?.error?.message || "Checking..."}</strong></p><p className="text-sm">Firestore: <strong>{connectionStatus?.firestore?.connected ? "Connected" : "Not confirmed"}</strong></p>{whatsappConnections.length > 0 && <div className="mt-3 space-y-2">{whatsappConnections.map(connection => { const result = healthResults.find(item => item.phoneNumberId === connection.phoneNumberId); return <div key={connection.phoneNumberId} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{connection.displayPhoneNumber || connection.verifiedName || connection.phoneNumberId}</p><span className={`text-xs font-medium ${result?.status === "healthy" ? "text-green-700" : result?.status === "attention" ? "text-amber-700" : "text-gray-500"}`}>{result?.status === "healthy" ? "Healthy" : result?.status === "attention" ? "Attention required" : "Not checked"}</span></div>{result?.error && <p className="mt-1 text-xs text-amber-700">{result.error}</p>}<p className="mt-1 break-all text-[11px] text-gray-400">ID: {connection.phoneNumberId}</p></div>; })}</div>}{healthCheckedAt && <p className="mt-2 text-xs text-gray-400">Last checked: {new Date(healthCheckedAt).toLocaleString()}</p>}</div><div className="max-w-2xl border-t pt-4"><h2 className="font-semibold">SLA alerts</h2><p className="my-2 text-sm text-gray-500">Notify the assigned agent when a customer message has not received a first reply within the selected target.</p>{organization && ["owner", "admin"].includes(organization.role) ? <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={slaEnabled} onChange={e => setSlaEnabled(e.target.checked)}/> Enable SLA overdue alerts</label><label className="mt-3 block text-sm">First-response target<select value={slaTargetMinutes} onChange={e => setSlaTargetMinutes(Number(e.target.value))} className="mt-1 block w-full max-w-xs rounded-lg border p-2"><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option><option value={120}>120 minutes</option></select></label><button disabled={settingsSaving} onClick={() => void saveSlaSettings()} className="mt-2 rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{settingsSaving ? "Saving..." : "Save SLA settings"}</button></> : <p className="text-sm text-gray-500">Only workspace owners and admins can change SLA settings.</p>}</div><div className="max-w-2xl border-t pt-4"><h2 className="font-semibold">Greeting message</h2><p className="my-2 text-sm text-gray-500">Send a greeting to a customer on their first inbound message.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={greetingEnabled} onChange={e => setGreetingEnabled(e.target.checked)}/> Enable greeting message</label><textarea value={greetingText} onChange={e => setGreetingText(e.target.value)} maxLength={1024} rows={4} placeholder="Write your greeting..." className="mt-3 w-full rounded-lg border p-3 text-sm"/><button disabled={settingsSaving || (greetingEnabled && !greetingText.trim())} onClick={() => void saveGreeting()} className="mt-2 rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{settingsSaving ? "Saving..." : "Save greeting"}</button></div></section> : view === "contacts" ? <section className="flex-1 overflow-y-auto bg-white p-4"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">Customer CRM</h2><p className="text-xs text-gray-500">{contacts.length} saved contacts · workspace-only records</p></div></div><form onSubmit={addContact} className="mb-5 grid gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3 sm:grid-cols-2"><p className="text-sm font-semibold text-[#075e54] sm:col-span-2">{editingContactId ? "Edit customer" : "Add customer"}</p><input required maxLength={100} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Customer name" className="rounded-lg border bg-white p-2 text-sm"/><input required value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="+919876543210" className="rounded-lg border bg-white p-2 text-sm"/><input type="email" maxLength={254} value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="Email (optional)" className="rounded-lg border bg-white p-2 text-sm sm:col-span-2"/><textarea maxLength={1000} rows={2} value={contactNotes} onChange={e => setContactNotes(e.target.value)} placeholder="Customer notes (optional)" className="rounded-lg border bg-white p-2 text-sm sm:col-span-2"/><div className="flex gap-2 sm:col-span-2"><button disabled={contactSaving} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{contactSaving ? "Saving..." : editingContactId ? "Update customer" : "Add customer"}</button>{editingContactId && <button type="button" onClick={resetContactForm} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>}</div></form><input value={contactSearch} onChange={e => setContactSearch(e.target.value)} placeholder="Search name, phone, email, notes or tags..." className="mb-3 w-full rounded-full border px-3 py-2 text-sm"/><div className="mb-3 flex flex-wrap items-center gap-2"><button type="button" onClick={exportVisibleContacts} disabled={!visibleContacts.length} className="rounded-lg border px-3 py-2 text-xs text-[#075e54] disabled:opacity-40">Export visible CSV ({visibleContacts.length})</button><label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={visibleContacts.length > 0 && visibleContacts.every(contact => selectedContactIds.includes(contact.id))} onChange={e => setSelectedContactIds(e.target.checked ? [...new Set([...selectedContactIds, ...visibleContacts.map(contact => contact.id)])] : selectedContactIds.filter(id => !visibleContacts.some(contact => contact.id === id)))}/>Select visible</label>{selectedContactIds.length > 0 && <><span className="text-xs text-gray-500">{selectedContactIds.length} selected</span><input value={bulkTagValue} onChange={e => setBulkTagValue(e.target.value)} placeholder="Add tags (comma separated)" className="min-w-[170px] flex-1 rounded-lg border p-2 text-xs"/><button type="button" disabled={bulkSaving || !bulkTagValue.trim()} onClick={() => void applyBulkTags()} className="rounded-lg bg-[#075e54] px-3 py-2 text-xs text-white disabled:opacity-50">{bulkSaving ? "Applying..." : "Apply tags"}</button><button type="button" disabled={bulkSaving} onClick={() => void deleteSelectedContacts()} className="rounded-lg border border-red-200 px-3 py-2 text-xs text-red-600 disabled:opacity-50">{bulkSaving ? "Working..." : "Delete selected"}</button><button type="button" onClick={() => setSelectedContactIds([])} className="rounded-lg border px-3 py-2 text-xs">Clear</button></>}</div><div className="mb-3 flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-gray-500">Customer segments:</span><button type="button" onClick={() => setContactTagFilter("all")} className={`rounded-full border px-3 py-1.5 text-xs ${contactTagFilter === "all" ? "border-[#075e54] bg-[#d9fdd3] text-[#075e54]" : "bg-white text-gray-600"}`}>All ({contacts.length})</button>{contactSegments.map(tag => <button key={tag} type="button" onClick={() => setContactTagFilter(tag)} className={`rounded-full border px-3 py-1.5 text-xs ${contactTagFilter.toLowerCase() === tag.toLowerCase() ? "border-[#075e54] bg-[#d9fdd3] text-[#075e54]" : "bg-white text-gray-600"}`}>{tag} ({contacts.filter(contact => (contact.tags || []).some(item => item.toLowerCase() === tag.toLowerCase())).length})</button>)}</div>{visibleContacts.map(contact => <div key={contact.id} className="flex items-start justify-between gap-3 border-b py-3"><input aria-label={`Select ${contact.name}`} type="checkbox" className="mt-1" checked={selectedContactIds.includes(contact.id)} onChange={e => setSelectedContactIds(current => e.target.checked ? [...current, contact.id] : current.filter(id => id !== contact.id))}/><div className="min-w-0 flex-1"><p className="font-medium">{contact.name}</p><p className="text-sm text-gray-500">{contact.phone}</p>{contact.email && <p className="text-xs text-gray-500">{contact.email}</p>}{contact.notes && <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600">{contact.notes}</p>}{(contact.tags || []).length > 0 && <div className="mt-2 flex flex-wrap gap-1">{contact.tags?.map(tag => <span key={tag} className="rounded-full bg-[#e7f5ec] px-2 py-0.5 text-[10px] text-[#075e54]">{tag}</span>)}</div>}<p className="mt-1 text-[11px] text-gray-400">{contact.source === "whatsapp" ? "WhatsApp customer" : "Saved contact"}</p></div><div className="flex shrink-0 gap-3"><button onClick={() => startEditContact(contact)} className="text-sm text-[#075e54]">Edit</button><button onClick={async () => { if (organization && confirm("Delete this contact?")) { try { await deleteTenantContact(organization.id, contact.id); if (editingContactId === contact.id) resetContactForm(); await refreshResources(); } catch (e) { setError(e instanceof Error ? e.message : "Contact could not be deleted."); } } }} className="text-sm text-red-600">Delete</button></div></div>)}{!visibleContacts.length && <p className="text-sm text-gray-500">{contacts.length ? "No contacts match your search." : "No saved contacts yet."}</p>}</section> : view === "templates" ? <section className="flex-1 space-y-4 overflow-y-auto bg-white p-4"><div><h2 className="font-semibold">WhatsApp message templates</h2><p className="mt-1 text-sm text-gray-500">View templates and their approval status from Meta. Sending templates is a separate next step.</p></div><div className="grid gap-3 rounded-xl border bg-gray-50 p-3 sm:grid-cols-2"><label className="text-xs font-medium text-gray-600">Connected WhatsApp number<select value={selectedPhoneNumberId} onChange={e => setSelectedPhoneNumberId(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Select number</option>{whatsappConnections.map(item => <option key={item.phoneNumberId} value={item.phoneNumberId}>{item.displayPhoneNumber || item.verifiedName || item.phoneNumberId}</option>)}</select></label><label className="text-xs font-medium text-gray-600">WhatsApp Business Account ID (WABA ID)<input value={templateWabaId} onChange={e => setTemplateWabaId(e.target.value.replace(/\D/g, "").slice(0, 32))} inputMode="numeric" placeholder="Enter Meta WABA ID" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label><div className="sm:col-span-2"><button type="button" disabled={templatesLoading || !selectedPhoneNumberId || !/^\d{5,32}$/.test(templateWabaId.trim())} onClick={() => void loadTemplates()} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{templatesLoading ? "Loading templates..." : "Load templates from Meta"}</button></div></div><div className="space-y-2">{templates.map(template => { const body = template.components.find(component => component.type === "BODY"); return <article key={template.id} className="rounded-xl border p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{template.name}</h3><p className="mt-1 text-xs text-gray-500">{template.language} · {template.category}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${template.status === "APPROVED" ? "bg-green-50 text-green-700" : template.status === "REJECTED" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{template.status}</span></div>{body?.text && <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700">{body.text}</p>}</article>; })}{!templates.length && <p className="rounded-lg border border-dashed p-5 text-center text-sm text-gray-500">{templatesLoading ? "Loading..." : "No templates loaded. Enter your WABA ID and load templates from Meta."}</p>}</div><form onSubmit={submitTemplateMessage} className="space-y-3 rounded-xl border border-[#d5e8e3] bg-[#f7fbfa] p-3"><h3 className="font-semibold text-[#075e54]">Send an approved template</h3><label className="block text-xs font-medium text-gray-600">Customer conversation<select required value={templateRecipient} onChange={e => setTemplateRecipient(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Choose customer</option>{chats.filter(chat => !chat.archived).map(chat => <option key={chat.id} value={chat.customerPhone || chat.id}>{chat.customerName || chat.customerPhone || chat.id}</option>)}</select></label><label className="block text-xs font-medium text-gray-600">Approved template<select required value={templateChoice} onChange={e => { setTemplateChoice(e.target.value); setTemplateVariablesText(""); setTemplateHeaderVariablesText(""); setTemplateButtonVariablesText(""); setTemplateHeaderFile(null); }} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Choose approved template</option>{templates.filter(item => item.status === "APPROVED").map(item => <option key={item.id} value={item.name + "::" + item.language}>{item.name} ({item.language})</option>)}</select></label>{templateChoice && (() => { const [name, language] = templateChoice.split("::"); const item = templates.find(template => template.name === name && template.language === language); const count = (value: string | undefined) => { const indexes = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1])); return indexes.length ? Math.max(...indexes) : 0; }; const header = item?.components.find(component => component.type === "HEADER"); const body = item?.components.find(component => component.type === "BODY"); const buttons = item?.components.flatMap(component => component.type === "BUTTONS" && Array.isArray(component.buttons) ? component.buttons.map((button, index) => ({ ...button, index })) : []).filter(button => button.type === "URL" && String(button.url || "").includes("{{")) || []; const bodyCount = count(body?.text); const headerCount = header?.format === "TEXT" ? count(header.text) : 0; const footer = item?.components.find(component => component.type === "FOOTER")?.text; const templateButtons = item?.components.flatMap(component => component.type === "BUTTONS" && Array.isArray(component.buttons) ? component.buttons : []) || []; return <div className="space-y-2">{header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format || "") && <label className="block text-xs font-medium text-gray-600">{header.format} header file<input required type="file" accept={header.format === "IMAGE" ? "image/jpeg,image/png" : header.format === "VIDEO" ? "video/mp4" : "application/pdf"} onChange={e => setTemplateHeaderFile(e.target.files?.[0] || null)} className="mt-1 block w-full text-sm"/><span className="text-[11px] text-gray-500">File is uploaded to Meta for sending; Joy Inbox stores only file details, not the file bytes.</span></label>}{footer && <p className="rounded-lg bg-gray-50 p-2 text-xs text-gray-500">Footer: {footer}</p>}{templateButtons.length > 0 && <div className="rounded-lg bg-gray-50 p-2 text-xs text-gray-600"><p className="mb-1 font-medium">Template buttons</p>{templateButtons.map((button,index) => <p key={index}>{button.text || button.type} {button.type === "URL" ? "(URL)" : ""}</p>)}</div>}{headerCount > 0 && <label className="block text-xs font-medium text-gray-600">Header text variables ({headerCount})<textarea required value={templateHeaderVariablesText} onChange={e => setTemplateHeaderVariablesText(e.target.value)} rows={Math.min(4, headerCount)} placeholder="One value per line" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label>}{bodyCount > 0 && <label className="block text-xs font-medium text-gray-600">Body variables ({bodyCount})<textarea required value={templateVariablesText} onChange={e => setTemplateVariablesText(e.target.value)} rows={Math.min(5, bodyCount)} placeholder="One value per line" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label>}{buttons.length > 0 && <label className="block text-xs font-medium text-gray-600">Dynamic URL button values ({buttons.length})<textarea required value={templateButtonVariablesText} onChange={e => setTemplateButtonVariablesText(e.target.value)} rows={Math.min(4, buttons.length)} placeholder="One URL suffix per line" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label>}{!headerCount && !bodyCount && !buttons.length && <p className="text-xs text-gray-500">This template has no text variables.</p>}</div>; })()}<button type="submit" disabled={templateSending || deliveryUnknown || !templateRecipient || !templateChoice || !/^\d{5,32}$/.test(templateWabaId.trim())} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{templateSending ? "Sending..." : "Send template"}</button><p className="text-[11px] text-gray-500">Only Meta-approved templates can be sent. Meta's 24-hour messaging rules and template policy still apply.</p></form></section> : view === "replies" ? <section className="flex-1 overflow-y-auto bg-white p-4"><h2 className="mb-3 font-semibold">Saved Quick Replies</h2><form onSubmit={addReply} className="mb-4 grid gap-2"><p className="text-sm font-medium text-[#075e54]">{editingReplyId ? "Edit Quick Reply" : "Create Quick Reply"}</p><input required maxLength={60} value={replyTitle} onChange={e => setReplyTitle(e.target.value)} placeholder="Reply title" className="rounded-lg border p-2 text-sm"/><input maxLength={30} value={replyShortcut} onChange={e => setReplyShortcut(e.target.value)} placeholder="Shortcut e.g. greeting" className="rounded-lg border p-2 text-sm"/><textarea maxLength={4096} value={replyMessage} onChange={e => setReplyMessage(e.target.value)} placeholder="Saved message" className="rounded-lg border p-2 text-sm"/><label className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm text-gray-600"><Paperclip size={16}/><span>{replyImage ? replyImage.name : "Attach saved image (JPEG/PNG, max 3 MB)"}</span><input type="file" accept="image/jpeg,image/png" className="hidden" onChange={e => setReplyImage(e.target.files?.[0] || null)}/></label>{replyImage && <button type="button" onClick={() => setReplyImage(null)} className="justify-self-start text-xs text-red-600">Remove selected image</button>}<div className="flex gap-2"><button className="rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white">{editingReplyId ? "Update Quick Reply" : "Save Quick Reply"}</button>{editingReplyId && <button type="button" onClick={resetReplyForm} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>}</div></form>{replies.map(reply => <div key={reply.id} className="flex items-start justify-between gap-3 border-b py-3"><div><p className="font-medium">{reply.title} <span className="text-xs text-gray-400">/{reply.shortcut}</span> {reply.hasImage && <span className="text-xs text-[#075e54]">· Image attached</span>}</p><p className="whitespace-pre-wrap text-sm text-gray-600">{reply.message}</p>{quickReplyImageUrls[reply.id] && <img src={quickReplyImageUrls[reply.id]} alt={reply.title + " saved image"} loading="lazy" className="mt-2 max-h-40 max-w-48 rounded-lg border object-contain"/>}</div><div className="flex gap-3"><button onClick={() => startEditReply(reply)} className="text-sm text-[#075e54]">Edit</button>{reply.hasImage && <button onClick={async () => { if (organization && confirm("Remove the saved image from this Quick Reply?")) { try { await removeTenantQuickReplyImage(organization.id, reply.id); await refreshResources(); } catch (e) { setError(e instanceof Error ? e.message : "Image could not be removed."); } } }} className="text-sm text-amber-700">Remove image</button>}<button onClick={async () => { if (organization && confirm("Delete this Quick Reply?")) { await deleteTenantQuickReply(organization.id, reply.id); if (editingReplyId === reply.id) resetReplyForm(); await refreshResources(); } }} className="text-sm text-red-600">Delete</button></div></div>)}{!replies.length && <p className="text-sm text-gray-500">No Quick Replies saved yet.</p>}</section> : <div className="flex min-h-0 flex-1">
      <aside className={`w-full max-w-sm overflow-y-auto border-r border-gray-200 bg-white ${selected ? "hidden md:block" : "block"}`}>
        <div className="flex items-center justify-between border-b p-4"><h2 className="font-semibold">{showArchived ? "Archived chats" : "Chats"}</h2><button onClick={() => setShowArchived(value => !value)} className="mr-2 text-xs text-[#075e54]">{showArchived ? "Inbox" : "Archived"}</button><button onClick={() => setError("")} title="Clear error"><RefreshCw size={16}/></button></div>
        <div className="border-b px-3 py-2"><input value={chatSearch} onChange={e => setChatSearch(e.target.value)} placeholder="Search chats by name, number or message..." className="w-full rounded-full border px-3 py-2 text-sm outline-none focus:border-[#075e54]"/><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[10px] text-gray-500">From<input type="date" value={chatDateFrom} max={chatDateTo || undefined} onChange={e => setChatDateFrom(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"/></label><label className="text-[10px] text-gray-500">To<input type="date" value={chatDateTo} min={chatDateFrom || undefined} onChange={e => setChatDateTo(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"/></label></div></div>
        {!showArchived && <div className="flex gap-2 overflow-x-auto border-b px-3 py-2">{([{id:"all",label:"All"},{id:"unread",label:"Unread"},{id:"unassigned",label:"Unassigned"},{id:"mine",label:"My Chats"},{id:"open",label:"Open"},{id:"pending",label:"Pending"},{id:"resolved",label:"Resolved"},{id:"sla_overdue",label:`SLA overdue (${inboxAnalytics.slaOverdue})`}] as const).map(filter => <button key={filter.id} type="button" onClick={() => setChatFilter(filter.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${chatFilter === filter.id ? "bg-[#075e54] text-white" : "bg-gray-100 text-gray-600"}`}>{filter.label}</button>)}<select aria-label="Filter conversations by assigned teammate" value={assignedAgentFilter} onChange={event => setAssignedAgentFilter(event.target.value)} className="max-w-48 rounded-full border bg-white px-3 py-1.5 text-xs text-gray-700"><option value="all">All teammates</option><option value="unassigned">Unassigned only</option>{teamMembers.map(member => <option key={member.uid} value={member.uid}>{member.displayName || member.email || member.uid}</option>)}</select></div>}
        {!showArchived && <div className="border-b bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" aria-label="Select all visible conversations" checked={visibleChats.length > 0 && visibleChats.every(chat => selectedChatIds.includes(chat.id))} onChange={event => setSelectedChatIds(event.target.checked ? Array.from(new Set([...selectedChatIds, ...visibleChats.map(chat => chat.id)])) : selectedChatIds.filter(id => !visibleChats.some(chat => chat.id === id)))} />Select visible ({selectedChatIds.length} selected)</label>
            <select aria-label="Assign selected conversations to" value={bulkAssignmentTarget} onChange={event => setBulkAssignmentTarget(event.target.value)} className="min-w-0 flex-1 rounded-lg border bg-white px-2 py-2 text-xs"><option value="">Choose teammate...</option>{teamMembers.map(member => <option key={member.uid} value={member.uid}>{member.displayName || member.email || member.uid}</option>)}</select>
            <button type="button" disabled={!selectedChatIds.length || !bulkAssignmentTarget || bulkAssignmentSaving} onClick={() => void bulkAssignChats()} className="rounded-lg bg-[#075e54] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{bulkAssignmentSaving ? "Assigning..." : "Bulk assign"}</button>
            <button type="button" disabled={!selectedChatIds.length || bulkAssignmentSaving} onClick={() => setSelectedChatIds([])} className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50">Clear</button>
          </div>
          {bulkAssignmentResult && <p role="status" className="mt-2 text-xs text-gray-600">{bulkAssignmentResult}</p>}
        </div>}
        {visibleChats.length ? visibleChats.map((chat) => <div key={chat.id} role="button" tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(chat.id); } }} onClick={() => setSelected(chat.id)} className={`flex w-full cursor-pointer items-start gap-2 border-b border-gray-100 p-4 text-left hover:bg-gray-50 ${selected === chat.id ? "bg-[#effaf3]" : ""}`}><input type="checkbox" aria-label={`Select conversation ${chat.customerPhone || chat.id}`} checked={selectedChatIds.includes(chat.id)} onClick={event => event.stopPropagation()} onChange={event => setSelectedChatIds(ids => event.target.checked ? [...ids, chat.id] : ids.filter(id => id !== chat.id))} className="mt-1 shrink-0" /><div className="min-w-0 flex-1">
          <div className="flex justify-between gap-2"><span className="flex min-w-0 items-center gap-1 truncate font-medium">{chat.pinned && <span title="Pinned" className="text-[#075e54]">📌</span>}{chat.customerName || contacts.find(contact => contact.phone.replace(/[^0-9]/g, "") === (chat.customerPhone || chat.id).replace(/[^0-9]/g, ""))?.name || chat.customerPhone || chat.id}</span><span className="flex shrink-0 items-center gap-2 text-xs text-gray-400">{Number(chat.unreadCount || 0) > 0 && <span className="rounded-full bg-[#25d366] px-2 py-0.5 font-semibold text-white">{chat.unreadCount}</span>}{timeLabel(chat.lastMessageAt)}</span></div>
          <p className="mt-1 truncate text-sm text-gray-500">{chat.lastMessage || "No message preview"}</p>{slaState(chat, slaClock, slaTargetMinutes) && <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${slaState(chat, slaClock, slaTargetMinutes)?.overdue ? "bg-red-100 text-red-700" : "bg-amber-50 text-amber-700"}`}>{slaState(chat, slaClock, slaTargetMinutes)?.label}</span>}<div className="mt-1 flex flex-wrap gap-2 text-[11px] text-gray-500"><span>{chat.assigneeName || (chat.assignedTo ? teamMembers.find(member => member.uid === chat.assignedTo)?.displayName || "Assigned" : "Unassigned")}</span><span className="capitalize">· {chat.status || "open"}</span></div><div className="mt-2 flex gap-3 text-xs text-gray-500"><span onClick={(e) => { e.stopPropagation(); void chatAction("pin", chat); }} className="cursor-pointer">{(chat as TenantChat & { pinned?: boolean }).pinned ? "Unpin" : "Pin"}</span><span onClick={(e) => { e.stopPropagation(); void chatAction("archive", chat); }} className="cursor-pointer">{(chat as TenantChat & { archived?: boolean }).archived ? "Unarchive" : "Archive"}</span><span onClick={(e) => { e.stopPropagation(); void chatAction("read", chat); }} className="cursor-pointer">Read</span><span onClick={(e) => { e.stopPropagation(); void chatAction("delete", chat); }} className="cursor-pointer text-red-600">Delete</span></div>
        </div></div>) : <p className="p-6 text-sm text-gray-500">No conversations yet. New WhatsApp messages will appear here.</p>}
      </aside>
      <section className={`flex min-w-0 flex-1 flex-col ${selected ? "flex" : "hidden md:flex"}`}>
        {currentChat ? <>
          <div className="flex items-center justify-between gap-3 border-b bg-white p-3"><div className="flex min-w-0 items-center gap-3"><button className="md:hidden" onClick={() => setSelected("")}>←</button><div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#d9fdd3] font-semibold text-[#075e54]">{(currentChat.customerName || currentChat.customerPhone || selected).slice(0,1).toUpperCase()}</div><div className="min-w-0"><p className="truncate font-semibold">{currentChat.customerName || currentChat.customerPhone || selected}</p><p className="truncate text-xs text-gray-500">{currentChat.customerPhone || selected}</p>{slaState(currentChat, slaClock, slaTargetMinutes) && <p className={`text-xs font-semibold ${slaState(currentChat, slaClock, slaTargetMinutes)?.overdue ? "text-red-600" : "text-amber-700"}`}>{slaState(currentChat, slaClock, slaTargetMinutes)?.label} · {slaTargetMinutes}-minute first reply target</p>}</div></div>{whatsappConnections.length > 0 && <select aria-label="Send from WhatsApp number" value={selectedPhoneNumberId} onChange={e => setSelectedPhoneNumberId(e.target.value)} className="max-w-40 rounded-lg border bg-white px-2 py-2 text-xs text-gray-700">{whatsappConnections.map(connection => <option key={connection.phoneNumberId} value={connection.phoneNumberId}>{connection.displayPhoneNumber || connection.verifiedName || connection.phoneNumberId}</option>)}</select>}<div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-gray-500">Assign<select aria-label="Assign conversation" disabled={assignmentSaving || organization?.role === "agent"} value={currentChat.assignedTo || ""} onChange={e => void updateAssignment({ assignedTo: e.target.value || null })} className="ml-1 max-w-36 rounded-lg border bg-white px-2 py-2 text-xs text-gray-700"><option value="">Unassigned</option>{teamMembers.map(member => <option key={member.uid} value={member.uid}>{member.displayName || member.email || member.uid} ({member.role})</option>)}</select></label>
            <label className="text-[11px] text-gray-500">Transfer to<select aria-label="Transfer conversation to" disabled={assignmentSaving || organization?.role === "agent"} value={transferTarget} onChange={e => setTransferTarget(e.target.value)} className="ml-1 max-w-36 rounded-lg border bg-white px-2 py-2 text-xs text-gray-700"><option value="">Choose teammate</option>{teamMembers.filter(member => member.uid !== currentChat.assignedTo).map(member => <option key={member.uid} value={member.uid}>{member.displayName || member.email || member.uid} ({member.role})</option>)}</select></label><button type="button" disabled={assignmentSaving || organization?.role === "agent" || !transferTarget} onClick={() => { void updateAssignment({ assignedTo: transferTarget }); setTransferTarget(""); }} className="rounded-lg border border-[#075e54] px-3 py-2 text-xs font-medium text-[#075e54] disabled:opacity-40">Transfer</button>
            <label className="text-[11px] text-gray-500">Status<select aria-label="Conversation status" disabled={assignmentSaving} value={currentChat.status || "open"} onChange={e => void updateAssignment({ status: e.target.value as "open" | "pending" | "resolved" })} className="ml-1 rounded-lg border bg-white px-2 py-2 text-xs text-gray-700"><option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option></select></label>
          </div>
          <button type="button" onClick={() => setShowCustomerInfo(value => !value)} className={`shrink-0 rounded-full border px-3 py-2 text-xs ${showCustomerInfo ? "border-[#075e54] bg-[#d9fdd3] text-[#075e54]" : "text-gray-600"}`}>Customer info</button><button type="button" onClick={() => { const next = !showAssignmentHistory; setShowAssignmentHistory(next); if (next) void loadAssignmentHistory(); }} className={`shrink-0 rounded-full border px-3 py-2 text-xs ${showAssignmentHistory ? "border-[#075e54] bg-[#d9fdd3] text-[#075e54]" : "text-gray-600"}`}>Assignment history</button></div>
          {showAssignmentHistory && <aside className="border-b bg-white p-4">
            <div className="mb-3 flex items-center justify-between"><div><h3 className="font-semibold">Conversation activity</h3><p className="text-xs text-gray-500">Assignment, transfer and status changes</p></div><button type="button" onClick={() => void loadAssignmentHistory()} disabled={assignmentHistoryLoading} className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50">Refresh</button></div>
            {assignmentHistoryLoading ? <p className="py-3 text-sm text-gray-500">Loading activity...</p> : assignmentHistoryError ? <div><p role="alert" className="mb-2 text-sm text-red-700">{assignmentHistoryError}</p><button type="button" onClick={() => void loadAssignmentHistory()} className="rounded-lg border px-3 py-1.5 text-xs">Retry</button></div> : assignmentHistory.length ? <div className="max-h-56 divide-y overflow-y-auto">{assignmentHistory.map(event => {
              const actor = event.actorEmail || teamMembers.find(member => member.uid === event.actorUid)?.displayName || event.actorUid || "Unknown";
              const target = event.targetEmail || teamMembers.find(member => member.uid === (event.targetUid || event.details?.assignedTo))?.displayName || event.targetUid || event.details?.assignedTo || "Unassigned";
              const rawDate = event.createdAt && typeof event.createdAt === "object" && "toDate" in event.createdAt && typeof event.createdAt.toDate === "function" ? event.createdAt.toDate() : event.createdAt ? new Date(String(event.createdAt)) : null;
              const when = rawDate && !Number.isNaN(rawDate.getTime()) ? rawDate.toLocaleString() : "Time unavailable";
              const description = event.action === "chat.assigned" ? (event.details?.assignedTo ? `assigned this conversation to ${target}` : "unassigned this conversation") : `changed status to ${event.details?.status || "unknown"}`;
              return <div key={event.id} className="py-2"><p className="text-sm"><span className="font-medium">{actor}</span> {description}</p><p className="mt-0.5 text-xs text-gray-500">{event.actorRole || "member"} · {when}</p></div>;
            })}</div> : <p className="py-3 text-sm text-gray-500">No assignment or status changes recorded for this conversation yet.</p>}
          </aside>}
          {showCustomerInfo && <aside className="border-b bg-white p-4"><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">Customer profile</h3><span className="text-xs text-gray-400">{currentContact ? "Saved contact" : "Not saved yet"}</span></div><div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Messages</p><p className="mt-1 text-sm font-semibold text-gray-800">{messages.length}</p></div><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Unread</p><p className="mt-1 text-sm font-semibold text-gray-800">{currentChat.unreadCount || 0}</p></div><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Assigned to</p><p className="mt-1 truncate text-xs font-semibold text-gray-800">{teamMembers.find(member => member.uid === currentChat.assignedTo)?.displayName || teamMembers.find(member => member.uid === currentChat.assignedTo)?.email || (currentChat.assignedTo ? "Team member" : "Unassigned")}</p></div><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Status</p><p className="mt-1 text-xs font-semibold capitalize text-gray-800">{currentChat.status || "open"}</p></div></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-gray-500">Customer name<input maxLength={100} value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer name" className="mt-1 w-full rounded-lg border p-2 text-sm text-gray-800"/></label><label className="text-xs text-gray-500">WhatsApp number<input readOnly value={currentChat.customerPhone || selected} className="mt-1 w-full rounded-lg border bg-gray-50 p-2 text-sm text-gray-800"/></label><label className="text-xs text-gray-500">Email<input type="email" maxLength={254} value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} placeholder="Customer email" className="mt-1 w-full rounded-lg border p-2 text-sm text-gray-800"/></label><label className="text-xs text-gray-500">Notes<textarea maxLength={1000} rows={2} value={customerNotes} onChange={e => setCustomerNotes(e.target.value)} placeholder="Add customer notes..." className="mt-1 w-full rounded-lg border p-2 text-sm text-gray-800"/></label><label className="text-xs text-gray-500 sm:col-span-2">Customer tags<input maxLength={650} value={customerTags} onChange={e => setCustomerTags(e.target.value)} placeholder="VIP, Follow-up, New lead (comma separated)" className="mt-1 w-full rounded-lg border p-2 text-sm text-gray-800"/><span className="mt-1 block text-[10px] text-gray-400">Up to 20 tags · 30 characters each</span></label></div>{(currentContact?.tags || []).length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{currentContact?.tags?.map(tag => <span key={tag} className="rounded-full bg-[#e7f5ec] px-2.5 py-1 text-[11px] font-medium text-[#075e54]">{tag}</span>)}</div>}<div className="mt-3 flex justify-end"><button disabled={customerSaving} onClick={() => void saveCustomerInfo()} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{customerSaving ? "Saving..." : "Save customer details"}</button></div></aside>}{currentChat && <section className="border-b bg-white p-3"><div className="mb-2 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Internal team notes</h3><p className="text-[10px] text-gray-500">Private to this workspace — never sent to the customer</p></div><span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700">Internal</span></div>{internalNotesLoading ? <p className="py-2 text-xs text-gray-400">Loading notes...</p> : internalNotes.length ? <div className="mb-3 max-h-36 space-y-2 overflow-y-auto">{internalNotes.map(note => <article key={note.id} className="rounded-lg bg-amber-50/70 p-2"><p className="whitespace-pre-wrap break-words text-xs text-gray-800">{note.text}</p><p className="mt-1 text-[10px] text-gray-500">{note.authorName} · {new Date(note.createdAt).toLocaleString()}</p></article>)}</div> : <p className="mb-3 text-xs text-gray-400">No internal notes yet.</p>}<form onSubmit={event => void saveInternalNote(event)} className="flex gap-2"><textarea value={internalNoteDraft} onChange={event => setInternalNoteDraft(event.target.value)} maxLength={2000} rows={2} placeholder="Add a private note for your team..." className="min-w-0 flex-1 resize-y rounded-lg border p-2 text-xs outline-none focus:border-[#075e54]"/><button type="submit" disabled={internalNoteSaving || !internalNoteDraft.trim()} className="self-end rounded-lg bg-[#075e54] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{internalNoteSaving ? "Saving..." : "Add note"}</button></form></section>}<div className="flex-1 space-y-3 overflow-y-auto p-4">
            <div className="sticky top-0 z-10 space-y-2 bg-[#eef2f3]"><div className="flex gap-2"><input value={messageSearch} onChange={e => setMessageSearch(e.target.value)} placeholder="Search messages, file names or type..." className="min-w-0 flex-1 rounded-full border bg-white px-3 py-2 text-sm outline-none focus:border-[#075e54]"/><button type="button" onClick={() => setSavedOnly(value => !value)} className={`shrink-0 rounded-full border px-3 text-xs ${savedOnly ? "border-[#075e54] bg-[#d9fdd3] text-[#075e54]" : "bg-white text-gray-600"}`}>{savedOnly ? "All messages" : "Saved"}</button></div><div className="grid grid-cols-2 gap-2"><label className="text-[10px] text-gray-500">Messages from<input type="date" value={messageDateFrom} max={messageDateTo || undefined} onChange={e => setMessageDateFrom(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"/></label><label className="text-[10px] text-gray-500">Messages to<input type="date" value={messageDateTo} min={messageDateFrom || undefined} onChange={e => setMessageDateTo(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-xs"/></label></div></div>{hasOlderMessages && !messageSearch.trim() && <button type="button" disabled={loadingOlderMessages} onClick={() => void loadOlderMessages()} className="w-full rounded-lg border bg-white px-3 py-2 text-xs font-medium text-[#075e54] disabled:opacity-50">{loadingOlderMessages ? "Loading older messages..." : "Load older messages"}</button>}
            {visibleMessages.map((message) => <div key={message.id} id={"message-" + message.id} className={`flex ${message.direction === "outgoing" ? "justify-end" : "justify-start"}`}><div className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${message.direction === "outgoing" ? "bg-[#d9fdd3]" : "bg-white"}`}>{mediaUrls[message.id] ? <div className="mb-2">{message.type === "image" ? <img src={mediaUrls[message.id]} alt={message.mediaFilename || "WhatsApp image"} className="max-h-64 max-w-full rounded-lg object-contain"/> : message.type === "video" ? <video src={mediaUrls[message.id]} controls className="max-h-64 max-w-full rounded-lg"/> : message.type === "audio" ? <audio src={mediaUrls[message.id]} controls className="max-w-full"/> : <a href={mediaUrls[message.id]} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-[#075e54] underline"><FileText size={18}/>{message.mediaFilename || "Open attachment"}</a>}</div> : message.mediaId ? <p className="mb-2 text-xs text-gray-500">Loading attachment or preview unavailable</p> : null}<p className="whitespace-pre-wrap break-words text-sm">{message.text || (message.mediaId ? "" : `[${message.type || "Message"}]`)}</p>{message.interactive && <div className="mt-2 space-y-1.5 rounded-lg border border-[#075e54]/20 bg-white/70 p-2">{message.interactive.header && <p className="text-[10px] font-semibold text-gray-600">{message.interactive.header}</p>}{message.interactive.type === "button" ? <div className="flex flex-wrap gap-1">{message.interactive.buttons?.map(button => <span key={button.id} className="rounded-full border border-[#075e54]/30 px-2 py-1 text-[10px] text-[#075e54]">{button.title}</span>)}</div> : message.interactive.sections?.map(section => <div key={section.title}><p className="text-[10px] font-semibold text-gray-600">{section.title}</p>{section.rows.map(row => <div key={row.id} className="border-t border-gray-100 py-1"><p className="text-xs font-medium">{row.title}</p>{row.description && <p className="text-[10px] text-gray-500">{row.description}</p>}</div>)}</div>)}{message.interactive.footer && <p className="text-[10px] text-gray-500">{message.interactive.footer}</p>}</div>}{message.interactiveReplyId && <p className="mt-1 text-[10px] text-[#075e54]">Selected option: {message.interactiveReplyTitle || message.interactiveReplyId}</p>}<div className="mt-1 flex gap-3"><button onClick={() => void toggleMessagePin(message)} className="text-[10px] text-gray-500">{(message as TenantMessage & { pinned?: boolean }).pinned ? "Unpin" : "Pin"}</button><button onClick={() => void toggleMessageSaved(message)} className="text-[10px] text-gray-500">{(message as TenantMessage & { saved?: boolean }).saved ? "★ Saved" : "☆ Save"}</button></div>{message.deliveryError && <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-left"><p className="text-xs font-semibold text-red-700">{message.deliveryError.title || "Message delivery failed"}</p><p className="mt-1 text-xs text-red-700">{message.deliveryError.details || message.deliveryError.message || "WhatsApp could not deliver this message."}</p>{message.deliveryError.code && <p className="mt-1 text-[10px] text-red-500">Error code: {message.deliveryError.code}</p>}{message.direction === "outgoing" && message.status === "failed" && message.type === "text" && <div className="mt-2 flex items-center gap-2">{retriedMessageIds.includes(message.id) ? <span className="text-xs font-medium text-green-700">Retry submitted as a new message</span> : <button type="button" disabled={retryingMessageIds.includes(message.id)} onClick={() => void retryFailedText(message)} className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50">{retryingMessageIds.includes(message.id) ? "Retrying..." : "Retry message"}</button>}</div>}{message.direction === "outgoing" && message.status === "failed" && message.type !== "text" && <>{message.type === "template" ? <div className="mt-2 flex items-center gap-2">{retriedMessageIds.includes(message.id) ? <span className="text-xs font-medium text-green-700">Template retry submitted as a new message</span> : <button type="button" disabled={retryingMessageIds.includes(message.id)} onClick={() => void retryFailedTemplate(message)} className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50">{retryingMessageIds.includes(message.id) ? "Retrying..." : "Retry template"}</button>}</div> : <p className="mt-2 text-[10px] text-gray-500">For safety, attach this media again to retry it.</p>}</>}</div>}<p className="mt-1 text-right text-[10px] text-gray-400">{timeLabel(message.timestamp)} {message.status || ""}</p></div></div>)}
          </div>
          {interactiveBuilderOpen && <section className="border-t bg-white p-3"><div className="mb-2 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Interactive WhatsApp message</h3><p className="text-[10px] text-gray-500">Buttons and lists are supported within WhatsApp's active messaging window.</p></div><button type="button" onClick={() => setInteractiveBuilderOpen(false)} className="rounded-lg border px-2 py-1 text-xs text-gray-600">Close</button></div><div className="grid gap-2 sm:grid-cols-2"><select value={interactiveType} onChange={event => setInteractiveType(event.target.value as "button" | "list" | "cta_url")} className="rounded-lg border p-2 text-xs"><option value="button">Reply buttons (up to 3)</option><option value="list">List menu (up to 10 rows)</option><option value="cta_url">Payment / catalog link</option></select><input value={interactiveHeader} onChange={event => setInteractiveHeader(event.target.value)} maxLength={60} placeholder="Optional header (60 chars)" className="rounded-lg border p-2 text-xs"/><textarea value={interactiveBody} onChange={event => setInteractiveBody(event.target.value)} maxLength={1024} rows={2} placeholder="Message body (required, max 1024 chars)" className="rounded-lg border p-2 text-xs sm:col-span-2"/><input value={interactiveFooter} onChange={event => setInteractiveFooter(event.target.value)} maxLength={60} placeholder="Optional footer (60 chars)" className="rounded-lg border p-2 text-xs sm:col-span-2"/>{interactiveType === "cta_url" ? <><input value={interactiveDisplayText} onChange={event => setInteractiveDisplayText(event.target.value)} maxLength={20} placeholder="Link button text (max 20)" className="rounded-lg border p-2 text-xs sm:col-span-2"/><input value={interactiveUrl} onChange={event => setInteractiveUrl(event.target.value)} type="url" placeholder="https://payment-or-catalog-link" className="rounded-lg border p-2 text-xs sm:col-span-2"/></> : <textarea value={interactiveOptions} onChange={event => setInteractiveOptions(event.target.value)} rows={3} placeholder={interactiveType === "button" ? "One button title per line (max 3)" : "One row per line: Title | optional description (max 10)"} className="rounded-lg border p-2 text-xs sm:col-span-2"/>}<div className="flex items-center justify-between gap-2 sm:col-span-2"><p className="text-[10px] text-gray-500">{interactiveType === "button" ? "Button titles: up to 20 characters each." : interactiveType === "list" ? "Row titles: up to 24 characters; descriptions: up to 72." : "Use a secure HTTPS payment or catalog URL."}</p><button type="button" onClick={() => void sendInteractiveMessage()} disabled={interactiveSending || !interactiveBody.trim() || (interactiveType === "cta_url" ? (!interactiveDisplayText.trim() || !interactiveUrl.trim()) : !interactiveOptions.trim())} className="rounded-lg bg-[#075e54] px-4 py-2 text-xs font-medium text-white disabled:opacity-50">{interactiveSending ? "Sending..." : "Send interactive"}</button></div></div></section>}
          <form onSubmit={event => { if (attachment) { event.preventDefault(); void sendAttachment(); } else void submit(event); }} className="relative flex gap-2 border-t bg-white p-3"><button type="button" onClick={() => setInteractiveBuilderOpen(value => !value)} className="shrink-0 rounded-full border border-[#075e54]/30 px-2.5 text-[10px] font-semibold text-[#075e54]">{interactiveBuilderOpen ? "Close" : "Interactive"}</button><label className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-gray-100 text-gray-600" title="Attach image, video, audio or document"><Paperclip size={18}/><input type="file" className="hidden" accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/aac,audio/amr,audio/mpeg,audio/mp4,audio/ogg,application/pdf,text/plain,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={e => setAttachment(e.target.files?.[0] || null)}/></label><div className="relative min-w-0 flex-1"><input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={attachment ? 1024 : 4096} placeholder={attachment ? attachment.name + " · optional caption" : "Type a message"} className="w-full rounded-full border border-gray-200 px-4 py-3 text-sm outline-none focus:border-[#075e54]"/>{matchingReplies.length > 0 && <div className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border bg-white p-2 shadow-lg">{matchingReplies.map(reply => <button type="button" key={reply.id} onClick={() => void chooseQuickReply(reply)} className="block w-full rounded-lg p-2 text-left hover:bg-gray-50"><span className="block text-sm font-medium">{reply.title} <span className="text-xs text-gray-400">/{reply.shortcut}</span></span><span className="block truncate text-xs text-gray-500">{reply.hasImage ? "Tap to send saved image" : reply.message}</span></button>)}</div>}</div><button disabled={sending || deliveryUnknown || (!draft.trim() && !attachment)} className="grid h-11 w-11 place-items-center rounded-full bg-[#075e54] text-white disabled:opacity-50"><Send size={18}/></button></form>
        </> : <div className="grid flex-1 place-items-center text-center text-sm text-gray-500"><div><MessageCircle className="mx-auto mb-2 opacity-40" size={36}/><p>Select a conversation to start</p></div></div>}
      </section>
    </div>)}
    {error && <div role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">{error}{deliveryUnknown && <div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-xs">Sending is paused to prevent a duplicate.</span><button type="button" onClick={() => { setDeliveryUnknown(false); setError(""); }} className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700">I checked WhatsApp — allow sending</button></div>}</div>}
  </main>;
}
