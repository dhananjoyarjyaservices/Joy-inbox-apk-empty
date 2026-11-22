import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, MessageCircle, Send, Settings, RefreshCw, Paperclip, FileText } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import { getActiveOrganizationId } from "../services/activeOrganization";
import { listOrganizations, sendTenantText, type Organization } from "../services/organizations";
import OrganizationMembers from "../components/OrganizationMembers";
import { listenToTenantChats, listenToTenantMessages } from "../services/tenantChats";
import { sendTenantMedia, fetchTenantMedia } from "../services/tenantMedia";
import { listTenantContacts, saveTenantContact, deleteTenantContact, listTenantQuickReplies, saveTenantQuickReply, uploadTenantQuickReplyImage, deleteTenantQuickReply, updateTenantChatState, updateTenantMessageState, deleteTenantChat, getTenantGreeting, saveTenantGreeting, getTenantStatus, type TenantContact, type TenantQuickReply } from "../services/tenantResources";

type TenantChat = {
  id: string;
  customerPhone?: string;
  customerName?: string;
  lastMessage?: string;
  lastMessageAt?: { toDate?: () => Date } | Date | string;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean;
};
type TenantMessage = {
  id: string;
  text?: string;
  type?: string;
  direction?: string;
  timestamp?: { toDate?: () => Date } | Date | string;
  status?: string;
  mediaId?: string | null;
  mediaMimeType?: string | null;
  mediaFilename?: string | null;
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
  const [chats, setChats] = useState<TenantChat[]>([]);
  const [selected, setSelected] = useState("");
  const [notificationMessageId, setNotificationMessageId] = useState(() => new URLSearchParams(window.location.search).get("messageId") || "");
  const [messages, setMessages] = useState<TenantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"chats" | "contacts" | "replies" | "settings" | "members">("chats");
  const [showArchived, setShowArchived] = useState(false);
  const [contacts, setContacts] = useState<TenantContact[]>([]);
  const [replies, setReplies] = useState<TenantQuickReply[]>([]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [replyTitle, setReplyTitle] = useState("");
  const [replyShortcut, setReplyShortcut] = useState("");
  const [replyMessage, setReplyMessage] = useState("");
  const [replyImage, setReplyImage] = useState<File | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [greetingEnabled, setGreetingEnabled] = useState(false);
  const [greetingText, setGreetingText] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<{ whatsapp?: { connected?: boolean; error?: { message?: string } }; firestore?: { connected?: boolean } } | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

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
    Promise.all([listTenantContacts(organization.id), listTenantQuickReplies(organization.id)])
      .then(([savedContacts, savedReplies]) => { if (active) { setContacts(savedContacts); setReplies(savedReplies); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Contacts or Quick Replies could not load."); });
    return () => { active = false; };
  }, [organization]);

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

  async function refreshResources() {
    if (!organization) return;
    const [savedContacts, savedReplies] = await Promise.all([listTenantContacts(organization.id), listTenantQuickReplies(organization.id)]);
    setContacts(savedContacts); setReplies(savedReplies);
  }

  async function addContact(event: FormEvent) {
    event.preventDefault();
    if (!organization) return;
    try {
      await saveTenantContact(organization.id, { name: contactName.trim(), phone: contactPhone.trim(), email: "", notes: "", source: "local" });
      setContactName(""); setContactPhone(""); await refreshResources();
    } catch (e) { setError(e instanceof Error ? e.message : "Contact could not be saved."); }
  }

  async function addReply(event: FormEvent) {
    event.preventDefault();
    if (!organization) return;
    try {
      const saved = await saveTenantQuickReply(organization.id, { title: replyTitle.trim(), shortcut: replyShortcut.trim(), message: replyMessage.trim() });
      if (replyImage) await uploadTenantQuickReplyImage(organization.id, saved.id, replyImage);
      setReplyTitle(""); setReplyShortcut(""); setReplyMessage(""); setReplyImage(null); await refreshResources();
    } catch (e) { setError(e instanceof Error ? e.message : "Quick Reply could not be saved."); }
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

  async function toggleMessagePin(message: TenantMessage) {
    if (!organization || !selected) return;
    try { await updateTenantMessageState(organization.id, { chatId: selected, messageId: message.id, pinned: !Boolean((message as TenantMessage & { pinned?: boolean }).pinned) }); }
    catch (e) { setError(e instanceof Error ? e.message : "Message pin failed."); }
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
      await sendTenantMedia(organization.id, selected, attachment, draft.trim());
      setAttachment(null); setDraft("");
    } catch (e) { setError(e instanceof Error ? e.message : "Attachment could not be sent."); }
    finally { setSending(false); }
  }

  const visibleChats = useMemo(() => chats.filter(chat => Boolean(chat.archived) === showArchived), [chats, showArchived]);
  const currentChat = useMemo(() => chats.find((chat) => chat.id === selected), [chats, selected]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!organization || !selected || !text || sending) return;
    setSending(true); setError("");
    try { await sendTenantText(organization.id, selected, text); setDraft(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Message could not be sent."); }
    finally { setSending(false); }
  }

  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-gray-500">Loading your workspace...</div>;

  return <main className="flex h-screen flex-col bg-[#eef2f3] text-gray-900">
    <header className="flex items-center justify-between bg-[#075e54] px-4 py-3 text-white shadow">
      <div className="flex items-center gap-3"><MessageCircle/><div><h1 className="font-bold">JOY INBOX</h1><p className="text-xs text-white/75">{organization?.name || user?.email}</p></div></div>
      <div className="flex gap-3"><button onClick={() => navigate("/setup")} title="Workspace settings"><Settings size={19}/></button><button onClick={() => void logout()} title="Sign out"><LogOut size={19}/></button></div>
    </header>
    <nav className="flex gap-2 overflow-x-auto border-b bg-white px-3 py-2">{(["chats", "contacts", "replies", ...(organization?.role === "agent" ? [] : ["members" as const, "settings" as const])] as const).map((item) => <button key={item} onClick={() => setView(item)} className={`shrink-0 rounded-full px-4 py-2 text-sm capitalize ${view === item ? "bg-[#075e54] text-white" : "bg-gray-100 text-gray-700"}`}>{item === "replies" ? "Quick Replies" : item === "members" ? "Members" : item}</button>)}</nav>
    {view === "members" && organization ? <OrganizationMembers organizationId={organization.id} actorRole={organization.role} /> : view === "settings" ? <section className="flex-1 space-y-5 overflow-y-auto bg-white p-4"><div><h2 className="font-semibold">Connection status</h2><p className="mt-2 text-sm">WhatsApp: <strong className={connectionStatus?.whatsapp?.connected ? "text-green-700" : "text-red-600"}>{connectionStatus?.whatsapp?.connected ? "Connected" : connectionStatus?.whatsapp?.error?.message || "Checking..."}</strong></p><p className="text-sm">Firestore: <strong>{connectionStatus?.firestore?.connected ? "Connected" : "Not confirmed"}</strong></p></div><div className="max-w-2xl border-t pt-4"><h2 className="font-semibold">Greeting message</h2><p className="my-2 text-sm text-gray-500">Send a greeting to a customer on their first inbound message.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={greetingEnabled} onChange={e => setGreetingEnabled(e.target.checked)}/> Enable greeting message</label><textarea value={greetingText} onChange={e => setGreetingText(e.target.value)} maxLength={1024} rows={4} placeholder="Write your greeting..." className="mt-3 w-full rounded-lg border p-3 text-sm"/><button disabled={settingsSaving || (greetingEnabled && !greetingText.trim())} onClick={() => void saveGreeting()} className="mt-2 rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50">{settingsSaving ? "Saving..." : "Save greeting"}</button></div></section> : view === "contacts" ? <section className="flex-1 overflow-y-auto bg-white p-4"><h2 className="mb-3 font-semibold">Business contacts</h2><form onSubmit={addContact} className="mb-4 grid gap-2 sm:grid-cols-3"><input required value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Customer name" className="rounded-lg border p-2 text-sm"/><input required value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="+919876543210" className="rounded-lg border p-2 text-sm"/><button className="rounded-lg bg-[#075e54] p-2 text-sm text-white">Add contact</button></form>{contacts.map(contact => <div key={contact.id} className="flex items-center justify-between border-b py-3"><div><p className="font-medium">{contact.name}</p><p className="text-sm text-gray-500">{contact.phone}</p></div><button onClick={async () => { if (organization && confirm("Delete this contact?")) { await deleteTenantContact(organization.id, contact.id); await refreshResources(); } }} className="text-sm text-red-600">Delete</button></div>)}{!contacts.length && <p className="text-sm text-gray-500">No saved contacts yet.</p>}</section> : view === "replies" ? <section className="flex-1 overflow-y-auto bg-white p-4"><h2 className="mb-3 font-semibold">Saved Quick Replies</h2><form onSubmit={addReply} className="mb-4 grid gap-2"><input required maxLength={60} value={replyTitle} onChange={e => setReplyTitle(e.target.value)} placeholder="Reply title" className="rounded-lg border p-2 text-sm"/><input maxLength={30} value={replyShortcut} onChange={e => setReplyShortcut(e.target.value)} placeholder="Shortcut e.g. greeting" className="rounded-lg border p-2 text-sm"/><textarea required maxLength={4096} value={replyMessage} onChange={e => setReplyMessage(e.target.value)} placeholder="Saved message" className="rounded-lg border p-2 text-sm"/><label className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm text-gray-600"><Paperclip size={16}/><span>{replyImage ? replyImage.name : "Attach saved image (JPEG/PNG, max 3 MB)"}</span><input type="file" accept="image/jpeg,image/png" className="hidden" onChange={e => setReplyImage(e.target.files?.[0] || null)}/></label>{replyImage && <button type="button" onClick={() => setReplyImage(null)} className="justify-self-start text-xs text-red-600">Remove selected image</button>}<button className="rounded-lg bg-[#075e54] p-2 text-sm text-white">Save Quick Reply</button></form>{replies.map(reply => <div key={reply.id} className="flex items-start justify-between gap-3 border-b py-3"><div><p className="font-medium">{reply.title} <span className="text-xs text-gray-400">/{reply.shortcut}</span> {reply.hasImage && <span className="text-xs text-[#075e54]">· Image attached</span>}</p><p className="whitespace-pre-wrap text-sm text-gray-600">{reply.message}</p></div><button onClick={async () => { if (organization && confirm("Delete this Quick Reply?")) { await deleteTenantQuickReply(organization.id, reply.id); await refreshResources(); } }} className="text-sm text-red-600">Delete</button></div>)}{!replies.length && <p className="text-sm text-gray-500">No Quick Replies saved yet.</p>}</section> : <div className="flex min-h-0 flex-1">
      <aside className={`w-full max-w-sm overflow-y-auto border-r border-gray-200 bg-white ${selected ? "hidden md:block" : "block"}`}>
        <div className="flex items-center justify-between border-b p-4"><h2 className="font-semibold">{showArchived ? "Archived chats" : "Chats"}</h2><button onClick={() => setShowArchived(value => !value)} className="mr-2 text-xs text-[#075e54]">{showArchived ? "Inbox" : "Archived"}</button><button onClick={() => setError("")} title="Clear error"><RefreshCw size={16}/></button></div>
        {visibleChats.length ? visibleChats.map((chat) => <button key={chat.id} onClick={() => setSelected(chat.id)} className={`w-full border-b border-gray-100 p-4 text-left hover:bg-gray-50 ${selected === chat.id ? "bg-[#effaf3]" : ""}`}>
          <div className="flex justify-between gap-2"><span className="truncate font-medium">{chat.customerName || chat.customerPhone || chat.id}</span><span className="text-xs text-gray-400">{timeLabel(chat.lastMessageAt)}</span></div>
          <p className="mt-1 truncate text-sm text-gray-500">{chat.lastMessage || "No message preview"}</p><div className="mt-2 flex gap-3 text-xs text-gray-500"><span onClick={(e) => { e.stopPropagation(); void chatAction("pin", chat); }} className="cursor-pointer">{(chat as TenantChat & { pinned?: boolean }).pinned ? "Unpin" : "Pin"}</span><span onClick={(e) => { e.stopPropagation(); void chatAction("archive", chat); }} className="cursor-pointer">{(chat as TenantChat & { archived?: boolean }).archived ? "Unarchive" : "Archive"}</span><span onClick={(e) => { e.stopPropagation(); void chatAction("read", chat); }} className="cursor-pointer">Read</span><span onClick={(e) => { e.stopPropagation(); void chatAction("delete", chat); }} className="cursor-pointer text-red-600">Delete</span></div>
        </button>) : <p className="p-6 text-sm text-gray-500">No conversations yet. New WhatsApp messages will appear here.</p>}
      </aside>
      <section className={`flex min-w-0 flex-1 flex-col ${selected ? "flex" : "hidden md:flex"}`}>
        {currentChat ? <>
          <div className="flex items-center gap-3 border-b bg-white p-3"><button className="md:hidden" onClick={() => setSelected("")}>←</button><div className="grid h-9 w-9 place-items-center rounded-full bg-[#d9fdd3] font-semibold text-[#075e54]">{(currentChat.customerName || currentChat.customerPhone || selected).slice(0,1).toUpperCase()}</div><div><p className="font-semibold">{currentChat.customerName || currentChat.customerPhone || selected}</p><p className="text-xs text-gray-500">{currentChat.customerPhone || selected}</p></div></div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((message) => <div key={message.id} id={"message-" + message.id} className={`flex ${message.direction === "outgoing" ? "justify-end" : "justify-start"}`}><div className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${message.direction === "outgoing" ? "bg-[#d9fdd3]" : "bg-white"}`}>{mediaUrls[message.id] ? <div className="mb-2">{message.type === "image" ? <img src={mediaUrls[message.id]} alt={message.mediaFilename || "WhatsApp image"} className="max-h-64 max-w-full rounded-lg object-contain"/> : message.type === "video" ? <video src={mediaUrls[message.id]} controls className="max-h-64 max-w-full rounded-lg"/> : message.type === "audio" ? <audio src={mediaUrls[message.id]} controls className="max-w-full"/> : <a href={mediaUrls[message.id]} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-[#075e54] underline"><FileText size={18}/>{message.mediaFilename || "Open attachment"}</a>}</div> : message.mediaId ? <p className="mb-2 text-xs text-gray-500">Loading attachment or preview unavailable</p> : null}<p className="whitespace-pre-wrap break-words text-sm">{message.text || (message.mediaId ? "" : `[${message.type || "Message"}]`)}</p><button onClick={() => void toggleMessagePin(message)} className="mt-1 text-[10px] text-gray-500">{(message as TenantMessage & { pinned?: boolean }).pinned ? "Unpin message" : "Pin message"}</button><p className="mt-1 text-right text-[10px] text-gray-400">{timeLabel(message.timestamp)} {message.status || ""}</p></div></div>)}
          </div>
          <form onSubmit={event => { if (attachment) { event.preventDefault(); void sendAttachment(); } else void submit(event); }} className="relative flex gap-2 border-t bg-white p-3"><label className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-gray-100 text-gray-600" title="Attach image, video, audio or document"><Paperclip size={18}/><input type="file" className="hidden" accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/aac,audio/amr,audio/mpeg,audio/mp4,audio/ogg,application/pdf,text/plain,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={e => setAttachment(e.target.files?.[0] || null)}/></label><div className="relative min-w-0 flex-1"><input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={attachment ? 1024 : 4096} placeholder={attachment ? attachment.name + " · optional caption" : "Type a message"} className="w-full rounded-full border border-gray-200 px-4 py-3 text-sm outline-none focus:border-[#075e54]"/>{matchingReplies.length > 0 && <div className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border bg-white p-2 shadow-lg">{matchingReplies.map(reply => <button type="button" key={reply.id} onClick={() => setDraft(reply.message)} className="block w-full rounded-lg p-2 text-left hover:bg-gray-50"><span className="block text-sm font-medium">{reply.title} <span className="text-xs text-gray-400">/{reply.shortcut}</span></span><span className="block truncate text-xs text-gray-500">{reply.message}</span></button>)}</div>}</div><button disabled={sending || (!draft.trim() && !attachment)} className="grid h-11 w-11 place-items-center rounded-full bg-[#075e54] text-white disabled:opacity-50"><Send size={18}/></button></form>
        </> : <div className="grid flex-1 place-items-center text-center text-sm text-gray-500"><div><MessageCircle className="mx-auto mb-2 opacity-40" size={36}/><p>Select a conversation to start</p></div></div>}
      </section>
    </div>}
    {error && <div role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
  </main>;
}
