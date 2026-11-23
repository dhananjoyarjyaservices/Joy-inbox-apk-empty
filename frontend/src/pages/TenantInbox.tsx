import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, MessageCircle, Send, Settings, RefreshCw, Paperclip, FileText } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import { getActiveOrganizationId } from "../services/activeOrganization";
import { listOrganizations, listWhatsAppConnections, checkWhatsAppConnectionHealth, listWhatsAppTemplates, sendTenantTemplate, sendTenantText, retryTenantFailedText, type Organization, type WhatsAppConnection, type WhatsAppConnectionHealthResult, type WhatsAppTemplate } from "../services/organizations";
import OrganizationMembers from "../components/OrganizationMembers";
import { listOrganizationMembers, updateOrganizationChatAssignment, type OrganizationMember } from "../services/organizationMembers";
import { listenToTenantChats, listenToTenantMessages } from "../services/tenantChats";
import { sendTenantMedia, fetchTenantMedia } from "../services/tenantMedia";
import { listTenantContacts, saveTenantContact, deleteTenantContact, listTenantQuickReplies, saveTenantQuickReply, uploadTenantQuickReplyImage, fetchTenantQuickReplyImage, removeTenantQuickReplyImage, sendTenantQuickReplyImage, deleteTenantQuickReply, updateTenantChatState, updateTenantMessageState, deleteTenantChat, getTenantGreeting, saveTenantGreeting, getTenantStatus, type TenantContact, type TenantQuickReply } from "../services/tenantResources";

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

export default function TenantInbox() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [whatsappConnections, setWhatsappConnections] = useState<WhatsAppConnection[]>([]);
  const [teamMembers, setTeamMembers] = useState<OrganizationMember[]>([]);
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState("");
  const [chats, setChats] = useState<TenantChat[]>([]);
  const [selected, setSelected] = useState("");
  const [notificationMessageId, setNotificationMessageId] = useState(() => new URLSearchParams(window.location.search).get("messageId") || "");
  const [messages, setMessages] = useState<TenantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [retryingMessageIds, setRetryingMessageIds] = useState<string[]>([]);
  const [retriedMessageIds, setRetriedMessageIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<"chats" | "contacts" | "replies" | "templates" | "settings" | "members" | "analytics">("chats");
  const [showArchived, setShowArchived] = useState(false);
  const [chatFilter, setChatFilter] = useState<"all" | "unassigned" | "mine" | "open" | "pending" | "resolved">("all");
  const [chatSearch, setChatSearch] = useState("");
  const [messageSearch, setMessageSearch] = useState("");
  const [savedOnly, setSavedOnly] = useState(false);
  const [showCustomerInfo, setShowCustomerInfo] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [customerSaving, setCustomerSaving] = useState(false);
  const [contacts, setContacts] = useState<TenantContact[]>([]);
  const [replies, setReplies] = useState<TenantQuickReply[]>([]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactNotes, setContactNotes] = useState("");
  const [editingContactId, setEditingContactId] = useState("");
  const [contactSaving, setContactSaving] = useState(false);
  const [replyTitle, setReplyTitle] = useState("");
  const [replyShortcut, setReplyShortcut] = useState("");
  const [replyMessage, setReplyMessage] = useState("");
  const [replyImage, setReplyImage] = useState<File | null>(null);
  const [editingReplyId, setEditingReplyId] = useState("");
  const [quickReplyImageUrls, setQuickReplyImageUrls] = useState<Record<string, string>>({});
  const [attachment, setAttachment] = useState<File | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
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
  const [templateSending, setTemplateSending] = useState(false);

  useEffect(() => {
    let active = true;
    listOrganizations().then((items) => {
      if (!active) return;
      const id = getActiveOrganizationId();
      const current = items.find((item) => item.id === id) || items[0];
      if (!current) { navigate("/setup", { replace: true }); return; }
      setOrganization(current);
      setLoading(false);
    }).catch((e) => { if (active) { setError(e instanceof Error ? e.message : "Workspace could not load."); setLoading(false); } });
    return () => { active = false; };
  }, [navigate]);

  useEffect(() => {
    if (!organization) { setTeamMembers([]); return; }
    let active = true;
    listOrganizationMembers(organization.id, { limit: 100 })
      .then(page => { if (active) setTeamMembers(page.members.filter(member => member.status === "active")); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Team members could not load."); });
    return () => { active = false; };
  }, [organization?.id]);

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
    if (!organization || !selected) { setMessages([]); return; }
    return listenToTenantMessages(organization.id, selected, (items) => setMessages(items as TenantMessage[]), (e) => setError(e.message));
  }, [organization, selected]);

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
    Promise.all([greetingRequest, getTenantStatus(organization.id)])
      .then(([greeting, status]) => { if (active) { setGreetingEnabled(greeting.enabled); setGreetingText(greeting.text); setConnectionStatus(status); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Workspace settings could not load."); });
    return () => { active = false; };
  }, [organization]);

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
    if (!organization || !selectedPhoneNumberId || !templateRecipient || templateSending) return;
    const [name, language] = templateChoice.split("::");
    const chosen = templates.find(item => item.name === name && item.language === language && item.status === "APPROVED");
    if (!chosen) { setError("Select an approved template first."); return; }
    const count = (value: string) => {
      const indexes = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
      return indexes.length ? Math.max(...indexes) : 0;
    };
    const header = chosen.components.find(component => component.type === "HEADER" && component.format === "TEXT");
    const buttons = chosen.components.flatMap(component => component.type === "BUTTONS" && Array.isArray(component.buttons) ? component.buttons.map((button, index) => ({ ...button, index })) : []).filter(button => button.type === "URL" && String(button.url || "").includes("{{"));
    const bodyRequired = count(chosen.components.find(component => component.type === "BODY")?.text || "");
    const headerRequired = count(header?.text || "");
    const variables = templateVariablesText.split("\n").map(value => value.trim()).filter(Boolean);
    const headerVariables = templateHeaderVariablesText.split("\n").map(value => value.trim()).filter(Boolean);
    const buttonVariables = templateButtonVariablesText.split("\n").map(value => value.trim()).filter(Boolean);
    if (variables.length !== bodyRequired || headerVariables.length !== headerRequired || buttonVariables.length !== buttons.length) {
      setError(`Enter ${bodyRequired} body, ${headerRequired} header and ${buttons.length} URL button variable(s), one per line.`); return;
    }
    setTemplateSending(true); setError("");
    try {
      await sendTenantTemplate(organization.id, templateRecipient, selectedPhoneNumberId, templateWabaId.trim(), name, language, variables, headerVariables, buttonVariables);
      setTemplateVariablesText(""); setTemplateHeaderVariablesText(""); setTemplateButtonVariablesText("");
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Template message could not be sent."); }
    finally { setTemplateSending(false); }
  }

  async function refreshResources() {
    if (!organization) return;
    const [savedContacts, savedReplies] = await Promise.all([listTenantContacts(organization.id), listTenantQuickReplies(organization.id)]);
    setContacts(savedContacts); setReplies(savedReplies);
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
        notes: contactNotes.trim(), source: contacts.find(item => item.id === editingContactId)?.source || "local"
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
    if (!organization || !selected || !attachment || sending) return;
    setSending(true); setError("");
    try {
      await sendTenantMedia(organization.id, selected, attachment, draft.trim(), selectedPhoneNumberId || undefined);
      setAttachment(null); setDraft("");
    } catch (e) { setError(e instanceof Error ? e.message : "Attachment could not be sent."); }
    finally { setSending(false); }
  }

  const visibleChats = useMemo(() => chats.filter(chat => { const phone = (chat.customerPhone || chat.id).replace(/[^0-9]/g, ""); const contact = contacts.find(item => item.phone.replace(/[^0-9]/g, "") === phone); const searchable = `${chat.customerName || ""} ${contact?.name || ""} ${chat.customerPhone || ""} ${chat.lastMessage || ""}`.toLowerCase(); const status = chat.status || "open"; const matchesFilter = chatFilter === "all" || (chatFilter === "unassigned" && !chat.assignedTo) || (chatFilter === "mine" && Boolean(user?.uid) && chat.assignedTo === user?.uid) || status === chatFilter; return Boolean(chat.archived) === showArchived && matchesFilter && (!chatSearch.trim() || searchable.includes(chatSearch.trim().toLowerCase())); }), [chats, contacts, showArchived, chatSearch, chatFilter, user?.uid]);
  const visibleContacts = useMemo(() => contacts.filter(contact => !contactSearch.trim() || `${contact.name} ${contact.phone} ${contact.email || ""} ${contact.notes || ""}`.toLowerCase().includes(contactSearch.trim().toLowerCase())), [contacts, contactSearch]);
  const inboxAnalytics = useMemo(() => ({ total: chats.filter(chat => !chat.archived).length, unread: chats.filter(chat => !chat.archived && Number(chat.unreadCount || 0) > 0).length, unassigned: chats.filter(chat => !chat.archived && !chat.assignedTo).length, open: chats.filter(chat => !chat.archived && (chat.status || "open") === "open").length, pending: chats.filter(chat => !chat.archived && chat.status === "pending").length, resolved: chats.filter(chat => !chat.archived && chat.status === "resolved").length, archived: chats.filter(chat => Boolean(chat.archived)).length }), [chats]);
  const visibleMessages = useMemo(() => messages.filter(message => (!savedOnly || Boolean((message as TenantMessage & { saved?: boolean }).saved)) && (!messageSearch.trim() || `${message.text || ""} ${message.type || ""} ${message.mediaFilename || ""}`.toLowerCase().includes(messageSearch.trim().toLowerCase()))), [messages, messageSearch, savedOnly]);
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
        name, phone, email: customerEmail.trim(), notes: customerNotes.trim(), source: currentContact?.source || "whatsapp"
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!organization || !selected || !text || sending) return;
    setSending(true); setError("");
    try { await sendTenantText(organization.id, selected, text, selectedPhoneNumberId || undefined); setDraft(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Message could not be sent."); }
    finally { setSending(false); }
  }

  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-gray-500">Loading your workspace...</div>;

  return <main className="flex h-screen flex-col bg-[#eef2f3] text-gray-900">
    <header className="flex items-center justify-between bg-[#075e54] px-4 py-3 text-white shadow">
      <div className="flex items-center gap-3"><MessageCircle/><div><h1 className="font-bold">JOY INBOX</h1><p className="text-xs text-white/75">{organization?.name || user?.email}</p></div></div>
      <div className="flex gap-3"><button onClick={() => navigate("/setup")} title="Workspace settings"><Settings size={19}/></button><button onClick={() => void logout()} title="Sign out"><LogOut size={19}/></button></div>
    </header>
    <nav className="flex gap-2 overflow-x-auto border-b bg-white px-3 py-2">{(["chats", "analytics", "contacts", "replies", "templates", ...(organization?.role === "agent" ? [] : ["members" as const, "settings" as const])] as const).map((item) => <button key={item} onClick={() => setView(item)} className={`shrink-0 rounded-full px-4 py-2 text-sm capitalize ${view === item ? "bg-[#075e54] text-white" : "bg-gray-100 text-gray-700"}`}>{item === "replies" ? "Quick Replies" : item === "templates" ? "Templates" : item === "members" ? "Members" : item === "analytics" ? "Analytics" : item}</button>)}</nav>
    {view === "analytics" ? <section className="flex-1 space-y-5 overflow-y-auto p-4 md:p-6"><div><h2 className="text-lg font-semibold">Inbox analytics</h2><p className="mt-1 text-sm text-gray-500">Live overview of conversations in this workspace. Archived chats are excluded from active totals.</p></div><div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{([{label:"Active conversations",value:inboxAnalytics.total},{label:"Unread conversations",value:inboxAnalytics.unread},{label:"Unassigned",value:inboxAnalytics.unassigned},{label:"Open",value:inboxAnalytics.open},{label:"Pending",value:inboxAnalytics.pending},{label:"Resolved",value:inboxAnalytics.resolved},{label:"Archived",value:inboxAnalytics.archived}] as const).map(metric => <div key={metric.label} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><p className="text-xs font-medium text-gray-500">{metric.label}</p><p className="mt-2 text-2xl font-semibold tabular-nums text-[#075e54]">{metric.value}</p></div>)}</div><div className="rounded-xl border border-gray-200 bg-white p-4"><h3 className="font-semibold">Conversation status</h3><div className="mt-3 space-y-3">{([{label:"Open",value:inboxAnalytics.open},{label:"Pending",value:inboxAnalytics.pending},{label:"Resolved",value:inboxAnalytics.resolved}] as const).map(item => <div key={item.label}><div className="mb-1 flex justify-between text-xs text-gray-600"><span>{item.label}</span><span>{item.value}</span></div><div className="h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-[#128c7e]" style={{width:`${inboxAnalytics.total ? item.value / inboxAnalytics.total * 100 : 0}%`}}/></div></div>)}</div></div></section> : view === "members" && organization ? <OrganizationMembers organizationId={organization.id} actorRole={organization.role} /> : view === "settings" ? <section className="flex-1 space-y-5 overflow-y-auto bg-white p-4"><div><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Connection status</h2><button type="button" disabled={healthChecking || !whatsappConnections.length} onClick={() => void checkConnectionHealth()} className="rounded-lg border px-3 py-2 text-xs font-medium text-[#075e54] disabled:opacity-50">{healthChecking ? "Checking..." : "Check WhatsApp numbers"}</button></div><p className="mt-2 text-sm">WhatsApp primary: <strong className={connectionStatus?.whatsapp?.connected ? "text-green-700" : "text-red-600"}>{connectionStatus?.whatsapp?.connected ? "Connected" : connectionStatus?.whatsapp?.error?.message || "Checking..."}</strong></p><p className="text-sm">Firestore: <strong>{connectionStatus?.firestore?.connected ? "Connected" : "Not confirmed"}</strong></p>{whatsappConnections.length > 0 && <div className="mt-3 space-y-2">{whatsappConnections.map(connection => { const result = healthResults.find(item => item.phoneNumberId === connection.phoneNumberId); return <div key={connection.phoneNumberId} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{connection.displayPhoneNumber || connection.verifiedName || connection.phoneNumberId}</p><span className={`text-xs font-medium ${result?.status === "healthy" ? "text-green-700" : result?.status === "attention" ? "text-amber-700" : "text-gray-500"}`}>{result?.status === "healthy" ? "Healthy" : result?.status === "attention" ? "Attention required" : "Not checked"}</span></div>{result?.error && <p className="mt-1 text-xs text-amber-700">{result.error}</p>}<p className="mt-1 break-all text-[11px] text-gray-400">ID: {connection.phoneNumberId}</p></div>; })}</div>}{healthCheckedAt && <p className="mt-2 text-xs text-gray-400">Last checked: {new Date(healthCheckedAt).toLocaleString()}</p>}</div><div className="max-w-2xl border-t pt-4"><h2 className="font-semibold">Greeting message</h2><p className="my-2 text-sm text-gray-500">Send a greeting to a customer on their first inbound message.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={greetingEnabled} onChange={e => setGreetingEnabled(e.target.checked)}/> Enable greeting message</label><textarea value={greetingText} onChange={e => setGreetingText(e.target.value)} maxLength={1024} rows={4} placeholder="Write your greeting..." className="mt-3 w-full rounded-lg border p-3 text-sm"/><button disabled={settingsSaving || (greetingEnabled && !greetingText.trim())} onClick={() => void saveGreeting()} className="mt-2 rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{settingsSaving ? "Saving..." : "Save greeting"}</button></div></section> : view === "contacts" ? <section className="flex-1 overflow-y-auto bg-white p-4"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">Customer CRM</h2><p className="text-xs text-gray-500">{contacts.length} saved contacts · workspace-only records</p></div></div><form onSubmit={addContact} className="mb-5 grid gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3 sm:grid-cols-2"><p className="text-sm font-semibold text-[#075e54] sm:col-span-2">{editingContactId ? "Edit customer" : "Add customer"}</p><input required maxLength={100} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Customer name" className="rounded-lg border bg-white p-2 text-sm"/><input required value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="+919876543210" className="rounded-lg border bg-white p-2 text-sm"/><input type="email" maxLength={254} value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="Email (optional)" className="rounded-lg border bg-white p-2 text-sm sm:col-span-2"/><textarea maxLength={1000} rows={2} value={contactNotes} onChange={e => setContactNotes(e.target.value)} placeholder="Customer notes (optional)" className="rounded-lg border bg-white p-2 text-sm sm:col-span-2"/><div className="flex gap-2 sm:col-span-2"><button disabled={contactSaving} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{contactSaving ? "Saving..." : editingContactId ? "Update customer" : "Add customer"}</button>{editingContactId && <button type="button" onClick={resetContactForm} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>}</div></form><input value={contactSearch} onChange={e => setContactSearch(e.target.value)} placeholder="Search name, phone, email or notes..." className="mb-3 w-full rounded-full border px-3 py-2 text-sm"/>{visibleContacts.map(contact => <div key={contact.id} className="flex items-start justify-between gap-3 border-b py-3"><div className="min-w-0"><p className="font-medium">{contact.name}</p><p className="text-sm text-gray-500">{contact.phone}</p>{contact.email && <p className="text-xs text-gray-500">{contact.email}</p>}{contact.notes && <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600">{contact.notes}</p>}<p className="mt-1 text-[11px] text-gray-400">{contact.source === "whatsapp" ? "WhatsApp customer" : "Saved contact"}</p></div><div className="flex shrink-0 gap-3"><button onClick={() => startEditContact(contact)} className="text-sm text-[#075e54]">Edit</button><button onClick={async () => { if (organization && confirm("Delete this contact?")) { try { await deleteTenantContact(organization.id, contact.id); if (editingContactId === contact.id) resetContactForm(); await refreshResources(); } catch (e) { setError(e instanceof Error ? e.message : "Contact could not be deleted."); } } }} className="text-sm text-red-600">Delete</button></div></div>)}{!visibleContacts.length && <p className="text-sm text-gray-500">{contacts.length ? "No contacts match your search." : "No saved contacts yet."}</p>}</section> : view === "templates" ? <section className="flex-1 space-y-4 overflow-y-auto bg-white p-4"><div><h2 className="font-semibold">WhatsApp message templates</h2><p className="mt-1 text-sm text-gray-500">View templates and their approval status from Meta. Sending templates is a separate next step.</p></div><div className="grid gap-3 rounded-xl border bg-gray-50 p-3 sm:grid-cols-2"><label className="text-xs font-medium text-gray-600">Connected WhatsApp number<select value={selectedPhoneNumberId} onChange={e => setSelectedPhoneNumberId(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Select number</option>{whatsappConnections.map(item => <option key={item.phoneNumberId} value={item.phoneNumberId}>{item.displayPhoneNumber || item.verifiedName || item.phoneNumberId}</option>)}</select></label><label className="text-xs font-medium text-gray-600">WhatsApp Business Account ID (WABA ID)<input value={templateWabaId} onChange={e => setTemplateWabaId(e.target.value.replace(/\D/g, "").slice(0, 32))} inputMode="numeric" placeholder="Enter Meta WABA ID" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label><div className="sm:col-span-2"><button type="button" disabled={templatesLoading || !selectedPhoneNumberId || !/^\d{5,32}$/.test(templateWabaId.trim())} onClick={() => void loadTemplates()} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{templatesLoading ? "Loading templates..." : "Load templates from Meta"}</button></div></div><div className="space-y-2">{templates.map(template => { const body = template.components.find(component => component.type === "BODY"); return <article key={template.id} className="rounded-xl border p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{template.name}</h3><p className="mt-1 text-xs text-gray-500">{template.language} · {template.category}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${template.status === "APPROVED" ? "bg-green-50 text-green-700" : template.status === "REJECTED" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{template.status}</span></div>{body?.text && <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700">{body.text}</p>}</article>; })}{!templates.length && <p className="rounded-lg border border-dashed p-5 text-center text-sm text-gray-500">{templatesLoading ? "Loading..." : "No templates loaded. Enter your WABA ID and load templates from Meta."}</p>}</div><form onSubmit={submitTemplateMessage} className="space-y-3 rounded-xl border border-[#d5e8e3] bg-[#f7fbfa] p-3"><h3 className="font-semibold text-[#075e54]">Send an approved template</h3><label className="block text-xs font-medium text-gray-600">Customer conversation<select required value={templateRecipient} onChange={e => setTemplateRecipient(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Choose customer</option>{chats.filter(chat => !chat.archived).map(chat => <option key={chat.id} value={chat.customerPhone || chat.id}>{chat.customerName || chat.customerPhone || chat.id}</option>)}</select></label><label className="block text-xs font-medium text-gray-600">Approved template<select required value={templateChoice} onChange={e => { setTemplateChoice(e.target.value); setTemplateVariablesText(""); setTemplateHeaderVariablesText(""); setTemplateButtonVariablesText(""); }} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Choose approved template</option>{templates.filter(item => item.status === "APPROVED").map(item => <option key={item.id} value={item.name + "::" + item.language}>{item.name} ({item.language})</option>)}</select></label>{templateChoice && (() => { const [name, language] = templateChoice.split("::"); const item = templates.find(template => template.name === name && template.language === language); const count = (value: string) => { const indexes = [...String(value || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1])); return indexes.length ? Math.max(...indexes) : 0; }; const header = item?.components.find(component => component.type === "HEADER" && component.format === "TEXT"); const body = item?.components.find(component => component.type === "BODY"); const buttons = item?.components.flatMap(component => component.type === "BUTTONS" && Array.isArray(component.buttons) ? component.buttons.map((button, index) => ({ ...button, index })) : []).filter(button => button.type === "URL" && String(button.url || "").includes("{{")) || []; const bodyCount = count(body?.text); const headerCount = count(header?.text); return <div className="space-y-2">{headerCount > 0 && <label className="block text-xs font-medium text-gray-600">Header text variables ({headerCount})<textarea required value={templateHeaderVariablesText} onChange={e => setTemplateHeaderVariablesText(e.target.value)} rows={Math.min(4, headerCount)} placeholder="One value per line" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label>}{bodyCount > 0 && <label className="block text-xs font-medium text-gray-600">Body variables ({bodyCount})<textarea required value={templateVariablesText} onChange={e => setTemplateVariablesText(e.target.value)} rows={Math.min(5, bodyCount)} placeholder="One value per line" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label>}{buttons.length > 0 && <label className="block text-xs font-medium text-gray-600">Dynamic URL button values ({buttons.length})<textarea required value={templateButtonVariablesText} onChange={e => setTemplateButtonVariablesText(e.target.value)} rows={Math.min(4, buttons.length)} placeholder="One URL suffix per line" className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"/></label>}{!headerCount && !bodyCount && !buttons.length && <p className="text-xs text-gray-500">This template has no text variables.</p>}</div>; })()}<button type="submit" disabled={templateSending || !templateRecipient || !templateChoice || !/^\d{5,32}$/.test(templateWabaId.trim())} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{templateSending ? "Sending..." : "Send template"}</button><p className="text-[11px] text-gray-500">Only Meta-approved templates can be sent. Meta's 24-hour messaging rules and template policy still apply.</p></form></section> : view === "replies" ? <section className="flex-1 overflow-y-auto bg-white p-4"><h2 className="mb-3 font-semibold">Saved Quick Replies</h2><form onSubmit={addReply} className="mb-4 grid gap-2"><p className="text-sm font-medium text-[#075e54]">{editingReplyId ? "Edit Quick Reply" : "Create Quick Reply"}</p><input required maxLength={60} value={replyTitle} onChange={e => setReplyTitle(e.target.value)} placeholder="Reply title" className="rounded-lg border p-2 text-sm"/><input maxLength={30} value={replyShortcut} onChange={e => setReplyShortcut(e.target.value)} placeholder="Shortcut e.g. greeting" className="rounded-lg border p-2 text-sm"/><textarea maxLength={4096} value={replyMessage} onChange={e => setReplyMessage(e.target.value)} placeholder="Saved message" className="rounded-lg border p-2 text-sm"/><label className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm text-gray-600"><Paperclip size={16}/><span>{replyImage ? replyImage.name : "Attach saved image (JPEG/PNG, max 3 MB)"}</span><input type="file" accept="image/jpeg,image/png" className="hidden" onChange={e => setReplyImage(e.target.files?.[0] || null)}/></label>{replyImage && <button type="button" onClick={() => setReplyImage(null)} className="justify-self-start text-xs text-red-600">Remove selected image</button>}<div className="flex gap-2"><button className="rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white">{editingReplyId ? "Update Quick Reply" : "Save Quick Reply"}</button>{editingReplyId && <button type="button" onClick={resetReplyForm} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>}</div></form>{replies.map(reply => <div key={reply.id} className="flex items-start justify-between gap-3 border-b py-3"><div><p className="font-medium">{reply.title} <span className="text-xs text-gray-400">/{reply.shortcut}</span> {reply.hasImage && <span className="text-xs text-[#075e54]">· Image attached</span>}</p><p className="whitespace-pre-wrap text-sm text-gray-600">{reply.message}</p>{quickReplyImageUrls[reply.id] && <img src={quickReplyImageUrls[reply.id]} alt={reply.title + " saved image"} loading="lazy" className="mt-2 max-h-40 max-w-48 rounded-lg border object-contain"/>}</div><div className="flex gap-3"><button onClick={() => startEditReply(reply)} className="text-sm text-[#075e54]">Edit</button>{reply.hasImage && <button onClick={async () => { if (organization && confirm("Remove the saved image from this Quick Reply?")) { try { await removeTenantQuickReplyImage(organization.id, reply.id); await refreshResources(); } catch (e) { setError(e instanceof Error ? e.message : "Image could not be removed."); } } }} className="text-sm text-amber-700">Remove image</button>}<button onClick={async () => { if (organization && confirm("Delete this Quick Reply?")) { await deleteTenantQuickReply(organization.id, reply.id); if (editingReplyId === reply.id) resetReplyForm(); await refreshResources(); } }} className="text-sm text-red-600">Delete</button></div></div>)}{!replies.length && <p className="text-sm text-gray-500">No Quick Replies saved yet.</p>}</section> : <div className="flex min-h-0 flex-1">
      <aside className={`w-full max-w-sm overflow-y-auto border-r border-gray-200 bg-white ${selected ? "hidden md:block" : "block"}`}>
        <div className="flex items-center justify-between border-b p-4"><h2 className="font-semibold">{showArchived ? "Archived chats" : "Chats"}</h2><button onClick={() => setShowArchived(value => !value)} className="mr-2 text-xs text-[#075e54]">{showArchived ? "Inbox" : "Archived"}</button><button onClick={() => setError("")} title="Clear error"><RefreshCw size={16}/></button></div>
        <div className="border-b px-3 py-2"><input value={chatSearch} onChange={e => setChatSearch(e.target.value)} placeholder="Search chats..." className="w-full rounded-full border px-3 py-2 text-sm outline-none focus:border-[#075e54]"/></div>
        {!showArchived && <div className="flex gap-2 overflow-x-auto border-b px-3 py-2">{([{id:"all",label:"All"},{id:"unassigned",label:"Unassigned"},{id:"mine",label:"My Chats"},{id:"open",label:"Open"},{id:"pending",label:"Pending"},{id:"resolved",label:"Resolved"}] as const).map(filter => <button key={filter.id} type="button" onClick={() => setChatFilter(filter.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${chatFilter === filter.id ? "bg-[#075e54] text-white" : "bg-gray-100 text-gray-600"}`}>{filter.label}</button>)}</div>}
        {visibleChats.length ? visibleChats.map((chat) => <button key={chat.id} onClick={() => setSelected(chat.id)} className={`w-full border-b border-gray-100 p-4 text-left hover:bg-gray-50 ${selected === chat.id ? "bg-[#effaf3]" : ""}`}>
          <div className="flex justify-between gap-2"><span className="truncate font-medium">{chat.customerName || contacts.find(contact => contact.phone.replace(/[^0-9]/g, "") === (chat.customerPhone || chat.id).replace(/[^0-9]/g, ""))?.name || chat.customerPhone || chat.id}</span><span className="text-xs text-gray-400">{timeLabel(chat.lastMessageAt)}</span></div>
          <p className="mt-1 truncate text-sm text-gray-500">{chat.lastMessage || "No message preview"}</p><div className="mt-1 flex flex-wrap gap-2 text-[11px] text-gray-500"><span>{chat.assigneeName || (chat.assignedTo ? teamMembers.find(member => member.uid === chat.assignedTo)?.displayName || "Assigned" : "Unassigned")}</span><span className="capitalize">· {chat.status || "open"}</span></div><div className="mt-2 flex gap-3 text-xs text-gray-500"><span onClick={(e) => { e.stopPropagation(); void chatAction("pin", chat); }} className="cursor-pointer">{(chat as TenantChat & { pinned?: boolean }).pinned ? "Unpin" : "Pin"}</span><span onClick={(e) => { e.stopPropagation(); void chatAction("archive", chat); }} className="cursor-pointer">{(chat as TenantChat & { archived?: boolean }).archived ? "Unarchive" : "Archive"}</span><span onClick={(e) => { e.stopPropagation(); void chatAction("read", chat); }} className="cursor-pointer">Read</span><span onClick={(e) => { e.stopPropagation(); void chatAction("delete", chat); }} className="cursor-pointer text-red-600">Delete</span></div>
        </button>) : <p className="p-6 text-sm text-gray-500">No conversations yet. New WhatsApp messages will appear here.</p>}
      </aside>
      <section className={`flex min-w-0 flex-1 flex-col ${selected ? "flex" : "hidden md:flex"}`}>
        {currentChat ? <>
          <div className="flex items-center justify-between gap-3 border-b bg-white p-3"><div className="flex min-w-0 items-center gap-3"><button className="md:hidden" onClick={() => setSelected("")}>←</button><div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#d9fdd3] font-semibold text-[#075e54]">{(currentChat.customerName || currentChat.customerPhone || selected).slice(0,1).toUpperCase()}</div><div className="min-w-0"><p className="truncate font-semibold">{currentChat.customerName || currentChat.customerPhone || selected}</p><p className="truncate text-xs text-gray-500">{currentChat.customerPhone || selected}</p></div></div>{whatsappConnections.length > 0 && <select aria-label="Send from WhatsApp number" value={selectedPhoneNumberId} onChange={e => setSelectedPhoneNumberId(e.target.value)} className="max-w-40 rounded-lg border bg-white px-2 py-2 text-xs text-gray-700">{whatsappConnections.map(connection => <option key={connection.phoneNumberId} value={connection.phoneNumberId}>{connection.displayPhoneNumber || connection.verifiedName || connection.phoneNumberId}</option>)}</select>}<div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-gray-500">Assign<select aria-label="Assign conversation" disabled={assignmentSaving || organization?.role === "agent"} value={currentChat.assignedTo || ""} onChange={e => void updateAssignment({ assignedTo: e.target.value || null })} className="ml-1 max-w-36 rounded-lg border bg-white px-2 py-2 text-xs text-gray-700"><option value="">Unassigned</option>{teamMembers.map(member => <option key={member.uid} value={member.uid}>{member.displayName || member.email || member.uid} ({member.role})</option>)}</select></label>
            <label className="text-[11px] text-gray-500">Status<select aria-label="Conversation status" disabled={assignmentSaving} value={currentChat.status || "open"} onChange={e => void updateAssignment({ status: e.target.value as "open" | "pending" | "resolved" })} className="ml-1 rounded-lg border bg-white px-2 py-2 text-xs text-gray-700"><option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option></select></label>
          </div>
          <button type="button" onClick={() => setShowCustomerInfo(value => !value)} className={`shrink-0 rounded-full border px-3 py-2 text-xs ${showCustomerInfo ? "border-[#075e54] bg-[#d9fdd3] text-[#075e54]" : "text-gray-600"}`}>Customer info</button></div>
          {showCustomerInfo && <aside className="border-b bg-white p-4"><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">Customer profile</h3><span className="text-xs text-gray-400">{currentContact ? "Saved contact" : "Not saved yet"}</span></div><div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Messages</p><p className="mt-1 text-sm font-semibold text-gray-800">{messages.length}</p></div><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Unread</p><p className="mt-1 text-sm font-semibold text-gray-800">{currentChat.unreadCount || 0}</p></div><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Assigned to</p><p className="mt-1 truncate text-xs font-semibold text-gray-800">{teamMembers.find(member => member.uid === currentChat.assignedTo)?.displayName || teamMembers.find(member => member.uid === currentChat.assignedTo)?.email || (currentChat.assignedTo ? "Team member" : "Unassigned")}</p></div><div className="rounded-lg bg-gray-50 p-2"><p className="text-[10px] uppercase tracking-wide text-gray-400">Status</p><p className="mt-1 text-xs font-semibold capitalize text-gray-800">{currentChat.status || "open"}</p></div></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-gray-500">Customer name<input maxLength={100} value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer name" className="mt-1 w-full rounded-lg border p-2 text-sm text-gray-800"/></label><label className="text-xs text-gray-500">WhatsApp number<input readOnly value={currentChat.customerPhone || selected} className="mt-1 w-full rounded-lg border bg-gray-50 p-2 text-sm text-gray-800"/></label><label className="text-xs text-gray-500">Email<input type="email" maxLength={254} value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} placeholder="Customer email" className="mt-1 w-full rounded-lg border p-2 text-sm text-gray-800"/></label><label className="text-xs text-gray-500">Notes<textarea maxLength={1000} rows={2} value={customerNotes} onChange={e => setCustomerNotes(e.target.value)} placeholder="Add customer notes..." className="mt-1 w-full rounded-lg border p-2 text-sm text-gray-800"/></label></div><div className="mt-3 flex justify-end"><button disabled={customerSaving} onClick={() => void saveCustomerInfo()} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{customerSaving ? "Saving..." : "Save customer details"}</button></div></aside>}<div className="flex-1 space-y-3 overflow-y-auto p-4">
            <div className="sticky top-0 z-10 flex gap-2 bg-[#eef2f3]"><input value={messageSearch} onChange={e => setMessageSearch(e.target.value)} placeholder="Search messages in this chat..." className="min-w-0 flex-1 rounded-full border bg-white px-3 py-2 text-sm outline-none focus:border-[#075e54]"/><button type="button" onClick={() => setSavedOnly(value => !value)} className={`shrink-0 rounded-full border px-3 text-xs ${savedOnly ? "border-[#075e54] bg-[#d9fdd3] text-[#075e54]" : "bg-white text-gray-600"}`}>{savedOnly ? "All messages" : "Saved"}</button></div>
            {visibleMessages.map((message) => <div key={message.id} id={"message-" + message.id} className={`flex ${message.direction === "outgoing" ? "justify-end" : "justify-start"}`}><div className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${message.direction === "outgoing" ? "bg-[#d9fdd3]" : "bg-white"}`}>{mediaUrls[message.id] ? <div className="mb-2">{message.type === "image" ? <img src={mediaUrls[message.id]} alt={message.mediaFilename || "WhatsApp image"} className="max-h-64 max-w-full rounded-lg object-contain"/> : message.type === "video" ? <video src={mediaUrls[message.id]} controls className="max-h-64 max-w-full rounded-lg"/> : message.type === "audio" ? <audio src={mediaUrls[message.id]} controls className="max-w-full"/> : <a href={mediaUrls[message.id]} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-[#075e54] underline"><FileText size={18}/>{message.mediaFilename || "Open attachment"}</a>}</div> : message.mediaId ? <p className="mb-2 text-xs text-gray-500">Loading attachment or preview unavailable</p> : null}<p className="whitespace-pre-wrap break-words text-sm">{message.text || (message.mediaId ? "" : `[${message.type || "Message"}]`)}</p><div className="mt-1 flex gap-3"><button onClick={() => void toggleMessagePin(message)} className="text-[10px] text-gray-500">{(message as TenantMessage & { pinned?: boolean }).pinned ? "Unpin" : "Pin"}</button><button onClick={() => void toggleMessageSaved(message)} className="text-[10px] text-gray-500">{(message as TenantMessage & { saved?: boolean }).saved ? "★ Saved" : "☆ Save"}</button></div>{message.deliveryError && <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-left"><p className="text-xs font-semibold text-red-700">{message.deliveryError.title || "Message delivery failed"}</p><p className="mt-1 text-xs text-red-700">{message.deliveryError.details || message.deliveryError.message || "WhatsApp could not deliver this message."}</p>{message.deliveryError.code && <p className="mt-1 text-[10px] text-red-500">Error code: {message.deliveryError.code}</p>}{message.direction === "outgoing" && message.status === "failed" && message.type === "text" && <div className="mt-2 flex items-center gap-2">{retriedMessageIds.includes(message.id) ? <span className="text-xs font-medium text-green-700">Retry submitted as a new message</span> : <button type="button" disabled={retryingMessageIds.includes(message.id)} onClick={() => void retryFailedText(message)} className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50">{retryingMessageIds.includes(message.id) ? "Retrying..." : "Retry message"}</button>}</div>}{message.direction === "outgoing" && message.status === "failed" && message.type !== "text" && <p className="mt-2 text-[10px] text-gray-500">For safety, attach this media again to retry it.</p>}</div>}<p className="mt-1 text-right text-[10px] text-gray-400">{timeLabel(message.timestamp)} {message.status || ""}</p></div></div>)}
          </div>
          <form onSubmit={event => { if (attachment) { event.preventDefault(); void sendAttachment(); } else void submit(event); }} className="relative flex gap-2 border-t bg-white p-3"><label className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-gray-100 text-gray-600" title="Attach image, video, audio or document"><Paperclip size={18}/><input type="file" className="hidden" accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/aac,audio/amr,audio/mpeg,audio/mp4,audio/ogg,application/pdf,text/plain,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={e => setAttachment(e.target.files?.[0] || null)}/></label><div className="relative min-w-0 flex-1"><input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={attachment ? 1024 : 4096} placeholder={attachment ? attachment.name + " · optional caption" : "Type a message"} className="w-full rounded-full border border-gray-200 px-4 py-3 text-sm outline-none focus:border-[#075e54]"/>{matchingReplies.length > 0 && <div className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border bg-white p-2 shadow-lg">{matchingReplies.map(reply => <button type="button" key={reply.id} onClick={() => void chooseQuickReply(reply)} className="block w-full rounded-lg p-2 text-left hover:bg-gray-50"><span className="block text-sm font-medium">{reply.title} <span className="text-xs text-gray-400">/{reply.shortcut}</span></span><span className="block truncate text-xs text-gray-500">{reply.hasImage ? "Tap to send saved image" : reply.message}</span></button>)}</div>}</div><button disabled={sending || (!draft.trim() && !attachment)} className="grid h-11 w-11 place-items-center rounded-full bg-[#075e54] text-white disabled:opacity-50"><Send size={18}/></button></form>
        </> : <div className="grid flex-1 place-items-center text-center text-sm text-gray-500"><div><MessageCircle className="mx-auto mb-2 opacity-40" size={36}/><p>Select a conversation to start</p></div></div>}
      </section>
    </div>}
    {error && <div role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
  </main>;
}
