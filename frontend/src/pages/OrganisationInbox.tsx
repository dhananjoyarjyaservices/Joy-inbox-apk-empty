import { useEffect, useMemo, useState, type FormEvent, type ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { ArrowLeft, MessageCircle, Send, RefreshCw, UserRoundCheck, StickyNote, Zap, Plus, X, Paperclip, Megaphone } from "lucide-react";
import { db } from "../firebase/config";
import {
  sendOrganisationWhatsAppText,
  getOrganisationNotes,
  addOrganisationNote,
  assignOrganisationChat,
  type OrganisationNote,
  getOrganisationQuickReplies,
  saveOrganisationQuickReply,
  type OrganisationQuickReply,
  updateOrganisationChatTags,
  updateOrganisationChatStatus,
  sendOrganisationWhatsAppMedia,
  sendOrganisationWhatsAppTemplate,
  sendOrganisationInteractive,
  listMembers,
  type OrganisationMember,
} from "../services/organisations";
import { useAuth } from "../context/AuthContext";

type ChatRow = {
  id: string;
  customerPhone: string;
  customerName: string;
  lastMessage: string;
  lastMessageAt?: { toDate?: () => Date } | Date | null;
  unreadCount?: number;
  status?: "open" | "pending" | "resolved";
  tags?: string[];
  assignedToEmail?: string | null;
  assignedToUid?: string | null;
};

type MessageRow = {
  id: string;
  text: string;
  type: string;
  direction: "incoming" | "outgoing";
  timestamp?: { toDate?: () => Date } | Date | null;
  status?: string;
  sender?: string;
};

function toDate(value: MessageRow["timestamp"] | ChatRow["lastMessageAt"]) {
  if (!value) return null;
  const date = typeof value === "object" && "toDate" in value && typeof value.toDate === "function"
    ? value.toDate()
    : value instanceof Date ? value : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export default function OrganisationInbox() {
  const { orgId = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<OrganisationNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [quickReplies, setQuickReplies] = useState<OrganisationQuickReply[]>([]);
  const [showQuickReplyForm, setShowQuickReplyForm] = useState(false);
  const [quickReplyTitle, setQuickReplyTitle] = useState("");
  const [quickReplyShortcut, setQuickReplyShortcut] = useState("");
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [teamMembers, setTeamMembers] = useState<OrganisationMember[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("en_US");
  const [templateParameters, setTemplateParameters] = useState("");
  const [interactiveKind, setInteractiveKind] = useState<"button" | "list">("button");
  const [interactiveBody, setInteractiveBody] = useState("");
  const [interactiveButton1, setInteractiveButton1] = useState("Yes");
  const [interactiveButton2, setInteractiveButton2] = useState("No");
  const [interactiveList1, setInteractiveList1] = useState("Option 1");
  const [interactiveList2, setInteractiveList2] = useState("Option 2");
  const [structuredMode, setStructuredMode] = useState<"template" | "interactive" | "">("");
  const [sendingStructured, setSendingStructured] = useState(false);

  const selectedChat = useMemo(() => chats.find((chat) => chat.id === selectedChatId) || null, [chats, selectedChatId]);
  const filteredChats = useMemo(() => { const term = chatSearch.trim().toLowerCase(); return term ? chats.filter((chat) => [chat.customerName, chat.customerPhone, chat.lastMessage, ...(chat.tags || [])].some((value) => String(value || "").toLowerCase().includes(term))) : chats; }, [chats, chatSearch]);
  const currentMemberRole = teamMembers.find((member) => member.uid === user?.uid)?.role || "agent";

  useEffect(() => {
    if (!orgId) return;
    const chatsQuery = query(
      collection(db, "organisations", orgId, "chats"),
      orderBy("lastMessageAt", "desc"),
      limit(100),
    );
    return onSnapshot(chatsQuery, (snapshot) => {
      const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as ChatRow));
      setChats(rows);
      setSelectedChatId((current) => rows.some((row) => row.id === current) ? current : (rows[0]?.id || ""));
      setLoading(false);
      setError("");
    }, (reason) => {
      setError(reason.code === "permission-denied"
        ? "Aap is organisation ke inbox ko access nahi kar sakte. Membership aur Firestore rules check karein."
        : reason.message || "Inbox load nahi hua.");
      setLoading(false);
    });
  }, [orgId]);

  useEffect(() => {
    if (!orgId) { setTeamMembers([]); return; }
    let active = true;
    listMembers(orgId).then((rows) => { if (active) setTeamMembers(rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Team members load nahi hue."); });
    return () => { active = false; };
  }, [orgId]);

  useEffect(() => {
    if (!orgId) { setQuickReplies([]); return; }
    let active = true;
    getOrganisationQuickReplies(orgId)
      .then((rows) => { if (active) setQuickReplies(rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Quick replies load nahi hue."); });
    return () => { active = false; };
  }, [orgId]);

  useEffect(() => {
    if (!orgId || !selectedChatId) {
      setMessages([]);
      return;
    }
    const messagesQuery = query(
      collection(db, "organisations", orgId, "chats", selectedChatId, "messages"),
      orderBy("timestamp", "asc"),
      limit(200),
    );
    return onSnapshot(messagesQuery, (snapshot) => {
      setMessages(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as MessageRow)));
    }, (reason) => setError(reason.message || "Messages load nahi hue."));
  }, [orgId, selectedChatId]);

  useEffect(() => {
    if (!orgId || !selectedChatId) { setNotes([]); return; }
    let active = true;
    getOrganisationNotes(orgId, selectedChatId)
      .then((rows) => { if (active) setNotes(rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Internal notes load nahi hue."); });
    return () => { active = false; };
  }, [orgId, selectedChatId]);

  async function handleAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedChat || !noteDraft.trim()) return;
    setSavingNote(true);
    try {
      await addOrganisationNote(orgId, selectedChat.id, noteDraft.trim());
      setNotes(await getOrganisationNotes(orgId, selectedChat.id));
      setNoteDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Internal note save nahi hua.");
    } finally { setSavingNote(false); }
  }

  async function handleStatusChange(status: "open" | "pending" | "resolved") {
    if (!selectedChat) return;
    setChangingStatus(true);
    try { await updateOrganisationChatStatus(orgId, selectedChat.id, status); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Status update nahi hua."); }
    finally { setChangingStatus(false); }
  }

  async function handleSaveTags() {
    if (!selectedChat) return;
    const tags = [...new Set(tagDraft.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    setSavingTags(true);
    try { await updateOrganisationChatTags(orgId, selectedChat.id, tags); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Tags save nahi hue. Manager permission required ho sakti hai."); }
    finally { setSavingTags(false); }
  }


  async function handleSendTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedChat) return;
    setSendingStructured(true); setError("");
    try {
      await sendOrganisationWhatsAppTemplate(orgId, {
        to: selectedChat.customerPhone || selectedChat.id,
        name: templateName.trim(),
        language: templateLanguage.trim(),
        bodyParameters: templateParameters.split("|").map((value) => value.trim()).filter(Boolean),
      });
      setStructuredMode(""); setTemplateName(""); setTemplateParameters("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Template send nahi hua."); }
    finally { setSendingStructured(false); }
  }

  async function handleSendInteractive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedChat) return;
    setSendingStructured(true); setError("");
    try {
      const details = interactiveKind === "button" ? {
        to: selectedChat.customerPhone || selectedChat.id,
        kind: "button" as const,
        body: interactiveBody.trim(),
        buttons: [
          { id: "choice_yes", title: interactiveButton1.trim() },
          { id: "choice_no", title: interactiveButton2.trim() },
        ],
      } : {
        to: selectedChat.customerPhone || selectedChat.id,
        kind: "list" as const,
        body: interactiveBody.trim(),
        buttonText: "View options",
        sections: [{ title: "Options", rows: [
          { id: "option_one", title: interactiveList1.trim() },
          { id: "option_two", title: interactiveList2.trim() },
        ] }],
      };
      await sendOrganisationInteractive(orgId, details);
      setStructuredMode(""); setInteractiveBody("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Interactive message send nahi hua."); }
    finally { setSendingStructured(false); }
  }

  async function handleAssignMember(uid: string) {
    if (!selectedChat) return;
    setAssigning(true);
    try { await assignOrganisationChat(orgId, selectedChat.id, uid || null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Team assignment update nahi hua."); }
    finally { setAssigning(false); }
  }

  async function handleAssignToMe() {
    if (!selectedChat || !user) return;
    setAssigning(true);
    try {
      await assignOrganisationChat(orgId, selectedChat.id, user.uid);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Assignment update nahi hua.");
    } finally { setAssigning(false); }
  }

  const quickReplyMatches = draft.startsWith("/")
    ? quickReplies.filter((reply) => {
        const term = draft.slice(1).toLowerCase();
        return reply.shortcut.includes(term) || reply.title.toLowerCase().includes(term);
      }).slice(0, 8)
    : [];

  async function handleSaveQuickReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    setSavingQuickReply(true);
    setError("");
    try {
      const result = await saveOrganisationQuickReply(orgId, {
        shortcut: quickReplyShortcut.trim().replace(/^\/+/, "").toLowerCase(),
        title: quickReplyTitle.trim(),
        text: draft.trim(),
      });
      setQuickReplies((current) => [...current.filter((item) => item.id !== result.quickReply.id), result.quickReply].sort((a, b) => a.shortcut.localeCompare(b.shortcut)));
      setShowQuickReplyForm(false);
      setQuickReplyTitle("");
      setQuickReplyShortcut("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Quick reply save nahi hua. Manager permission required ho sakti hai.");
    } finally { setSavingQuickReply(false); }
  }

  function insertQuickReply(reply: OrganisationQuickReply) {
    setDraft(reply.text);
  }

  async function handleMediaSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedChat) return;
    if (file.size > 3 * 1024 * 1024) {
      setError("File size 3 MB se kam hona chahiye.");
      return;
    }
    const type = file.type.startsWith("image/") ? "image"
      : file.type.startsWith("video/") ? "video"
        : file.type.startsWith("audio/") ? "audio" : "document";
    setUploadingMedia(true);
    setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const fileBase64 = btoa(binary);
      await sendOrganisationWhatsAppMedia(orgId, {
        to: selectedChat.customerPhone || selectedChat.id,
        type,
        mimeType: file.type,
        filename: file.name,
        caption: draft.trim(),
        fileBase64,
      });
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Media message send nahi hua.");
    } finally { setUploadingMedia(false); }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedChat || !draft.trim()) return;
    setSending(true);
    setError("");
    const text = draft.trim();
    try {
      await sendOrganisationWhatsAppText(orgId, selectedChat.customerPhone || selectedChat.id, text);
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Message send nahi hua.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="flex h-screen flex-col bg-[#e9edef]">
      <header className="flex items-center gap-3 bg-[#075e54] px-4 py-3 text-white">
        <button onClick={() => navigate("/setup")} aria-label="Back to business setup" className="rounded-lg p-2 hover:bg-white/10"><ArrowLeft size={19} /></button>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15"><MessageCircle size={21} /></div>
        <div className="min-w-0 flex-1"><h1 className="font-semibold">Joy Inbox</h1><p className="text-xs text-white/75">Organisation shared inbox</p></div><button onClick={() => navigate(`/org/${orgId}/campaigns`)} className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/20" aria-label="Open broadcast campaigns"><Megaphone size={16}/> Campaigns</button>
      </header>

      {error && <div role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_1fr]">
        <aside className={`min-h-0 overflow-y-auto bg-white ${selectedChat ? "hidden md:block" : "block"}`}>
          <div className="border-b border-gray-100 px-4 py-3"><div className="mb-2 flex items-center justify-between"><h2 className="font-semibold text-gray-800">Chats</h2><button onClick={() => setError("")} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Clear error"><RefreshCw size={16} /></button></div><input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Search name, number, message or tag" className="h-9 w-full rounded-lg border border-gray-200 px-3 text-xs outline-none focus:border-[#075e54]" /></div>
          {loading ? <p className="p-4 text-sm text-gray-500">Loading chats...</p> : chats.length === 0 ? <p className="p-4 text-sm text-gray-500">Abhi koi message nahi aaya. Meta webhook subscription configure karne ke baad incoming chats yahan dikhenge.</p> : filteredChats.length === 0 ? <p className="p-4 text-sm text-gray-500">No matching conversations.</p> : filteredChats.map((chat) => (
            <button key={chat.id} onClick={() => setSelectedChatId(chat.id)} className={`w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 ${selectedChatId === chat.id ? "bg-[#f0f2f5]" : "bg-white"}`}>
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-gray-900">{chat.customerName || chat.customerPhone}</span><span className="text-[11px] text-gray-400">{toDate(chat.lastMessageAt)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) || ""}</span></div>
              <p className="mt-1 truncate text-sm text-gray-500">{chat.lastMessage || chat.customerPhone}</p>
            </button>
          ))}
        </aside>

        <section className={`flex min-h-0 flex-col ${selectedChat ? "flex" : "hidden md:flex"}`}>
          {selectedChat ? <>
            <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
              <button onClick={() => setSelectedChatId("")} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 md:hidden" aria-label="Back to chats"><ArrowLeft size={18} /></button>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d9fdd3] font-semibold text-[#075e54]">{(selectedChat.customerName || selectedChat.customerPhone || "?").slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1"><h2 className="truncate font-semibold text-gray-900">{selectedChat.customerName || selectedChat.customerPhone}</h2><p className="text-xs text-gray-500">{selectedChat.customerPhone}</p></div>
              <button type="button" onClick={handleAssignToMe} disabled={assigning || !user} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-2 text-xs font-medium text-gray-600 disabled:opacity-50"><UserRoundCheck size={14} /> {assigning ? "Assigning" : "Assign to me"}</button>
              <select aria-label="Assign conversation to team member" value={selectedChat.assignedToUid || ""} disabled={assigning} onChange={(event) => handleAssignMember(event.target.value)} className="max-w-[140px] rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-700"><option value="">Unassigned</option>{teamMembers.map((member) => <option key={member.uid} value={member.uid} disabled={currentMemberRole === "agent" && member.uid !== user?.uid}>{member.email || member.uid}</option>)}</select>
              <select aria-label="Conversation status" value={selectedChat.status || "open"} disabled={changingStatus} onChange={(event) => handleStatusChange(event.target.value as "open" | "pending" | "resolved")} className="max-w-[112px] rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-700">
                <option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option>
              </select>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-6">
              {messages.map((message) => <div key={message.id} className={`flex ${message.direction === "outgoing" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 shadow-sm sm:max-w-[70%] ${message.direction === "outgoing" ? "bg-[#d9fdd3]" : "bg-white"}`}>
                  <p className="whitespace-pre-wrap break-words text-sm text-gray-800">{message.text || (message.type + " message")}</p>
                  <p className="mt-1 text-right text-[10px] text-gray-500">{toDate(message.timestamp)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) || ""}{message.direction === "outgoing" && message.status ? " · " + message.status : ""}</p>
                </div>
              </div>)}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 bg-white px-3 py-2">
              <button type="button" onClick={() => setStructuredMode(structuredMode === "template" ? "" : "template")} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700">Approved template</button>
              <button type="button" onClick={() => setStructuredMode(structuredMode === "interactive" ? "" : "interactive")} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700">Buttons / list</button>
            </div>
            {structuredMode === "template" && <form onSubmit={handleSendTemplate} className="grid grid-cols-1 gap-2 border-t border-gray-200 bg-white p-3 sm:grid-cols-4">
              <input required value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Approved template name" className="h-9 rounded-lg border border-gray-200 px-3 text-xs" />
              <input required value={templateLanguage} onChange={(event) => setTemplateLanguage(event.target.value)} placeholder="Language e.g. en_US" className="h-9 rounded-lg border border-gray-200 px-3 text-xs" />
              <input value={templateParameters} onChange={(event) => setTemplateParameters(event.target.value)} placeholder="Body variables separated by |" className="h-9 rounded-lg border border-gray-200 px-3 text-xs" />
              <button disabled={sendingStructured} className="rounded-lg bg-[#075e54] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{sendingStructured ? "Sending..." : "Send template"}</button>
              <p className="text-[11px] text-gray-400 sm:col-span-4">Use only a template already approved in WhatsApp Manager. Enter body variables in order, separated by |.</p>
            </form>}
            {structuredMode === "interactive" && <form onSubmit={handleSendInteractive} className="grid grid-cols-1 gap-2 border-t border-gray-200 bg-white p-3 sm:grid-cols-3">
              <select value={interactiveKind} onChange={(event) => setInteractiveKind(event.target.value as "button" | "list")} className="h-9 rounded-lg border border-gray-200 px-3 text-xs"><option value="button">Reply buttons (max 3)</option><option value="list">List menu (max 10 rows)</option></select>
              <input required value={interactiveBody} onChange={(event) => setInteractiveBody(event.target.value)} maxLength={1024} placeholder="Message body" className="h-9 rounded-lg border border-gray-200 px-3 text-xs sm:col-span-2" />
              {interactiveKind === "button" ? <>
                <input required value={interactiveButton1} onChange={(event) => setInteractiveButton1(event.target.value)} maxLength={20} placeholder="Button 1 title" className="h-9 rounded-lg border border-gray-200 px-3 text-xs" />
                <input required value={interactiveButton2} onChange={(event) => setInteractiveButton2(event.target.value)} maxLength={20} placeholder="Button 2 title" className="h-9 rounded-lg border border-gray-200 px-3 text-xs" />
              </> : <>
                <input required value={interactiveList1} onChange={(event) => setInteractiveList1(event.target.value)} maxLength={24} placeholder="List option 1" className="h-9 rounded-lg border border-gray-200 px-3 text-xs" />
                <input required value={interactiveList2} onChange={(event) => setInteractiveList2(event.target.value)} maxLength={24} placeholder="List option 2" className="h-9 rounded-lg border border-gray-200 px-3 text-xs" />
              </>}
              <button disabled={sendingStructured} className="rounded-lg bg-[#075e54] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{sendingStructured ? "Sending..." : "Send interactive"}</button>
            </form>}
            <div className="flex items-center gap-2 border-t border-gray-200 bg-white px-3 py-2">
              <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Tags separated by commas" className="h-8 min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-xs" />
              <button type="button" onClick={handleSaveTags} disabled={savingTags} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 disabled:opacity-50">{savingTags ? "Saving" : "Save tags"}</button>
            </div>
            <div className="max-h-36 overflow-y-auto border-t border-gray-200 bg-white px-3 py-2">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-600"><StickyNote size={14} /> Internal notes (team only)</div>
              {notes.map((note) => <div key={note.id} className="mb-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-gray-700"><p>{note.content}</p><p className="mt-1 text-[10px] text-gray-400">{note.authorEmail || note.authorUid}</p></div>)}
              <form onSubmit={handleAddNote} className="flex gap-2">
                <input value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} maxLength={2000} placeholder="Add an internal note..." className="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-xs outline-none focus:border-amber-400" />
                <button disabled={savingNote || !noteDraft.trim()} className="rounded-lg bg-amber-500 px-3 text-xs font-semibold text-white disabled:opacity-50">{savingNote ? "Saving" : "Add note"}</button>
              </form>
            </div>
            {quickReplyMatches.length > 0 && <div className="border-t border-gray-200 bg-white px-3 py-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Quick replies · select to insert</p>
              {quickReplyMatches.map((reply) => <button key={reply.id} type="button" onClick={() => insertQuickReply(reply)} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-gray-50"><span className="min-w-0"><span className="block truncate text-sm font-medium text-gray-800">{reply.title}</span><span className="block truncate text-xs text-gray-400">/{reply.shortcut} · {reply.text}</span></span><Zap size={15} className="shrink-0 text-[#075e54]" /></button>)}
            </div>}
            {showQuickReplyForm && <form onSubmit={handleSaveQuickReply} className="border-t border-gray-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold text-gray-800">Save current message as quick reply</p><button type="button" onClick={() => setShowQuickReplyForm(false)} aria-label="Close quick reply form"><X size={16} /></button></div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input required value={quickReplyShortcut} onChange={(event) => setQuickReplyShortcut(event.target.value)} placeholder="Shortcut (e.g. greeting)" className="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-xs" />
                <input required value={quickReplyTitle} onChange={(event) => setQuickReplyTitle(event.target.value)} placeholder="Reply title" className="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-xs" />
                <button disabled={savingQuickReply || !draft.trim()} className="rounded-lg bg-[#075e54] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{savingQuickReply ? "Saving" : "Save"}</button>
              </div>
              <p className="mt-2 text-[11px] text-gray-400">Only organisation owner/admin/manager can create shared quick replies.</p>
            </form>}
            <div className="flex items-center gap-2 border-t border-gray-200 bg-[#f0f2f5] p-3">
              <button type="button" onClick={() => { setQuickReplyTitle(""); setQuickReplyShortcut(""); setShowQuickReplyForm(true); }} disabled={!draft.trim()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#075e54] hover:bg-white disabled:opacity-40" aria-label="Save as quick reply"><Plus size={19} /></button>
              <label className={`flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#075e54] hover:bg-white ${uploadingMedia ? "opacity-40" : ""}`} title="Attach image, video, audio or document">
                <Paperclip size={19} />
                <input type="file" className="hidden" disabled={uploadingMedia} accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/aac,audio/amr,audio/mpeg,audio/mp4,audio/ogg,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={handleMediaSelect} />
              </label>
              <form onSubmit={handleSend} className="flex min-w-0 flex-1 items-center gap-2">
                <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4096} placeholder={uploadingMedia ? "Uploading media..." : "Type a message · use / for quick replies"} className="h-11 min-w-0 flex-1 rounded-full border-0 bg-white px-4 text-sm outline-none" />
                <button disabled={sending || uploadingMedia || !draft.trim()} aria-label="Send WhatsApp message" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#075e54] text-white disabled:opacity-50"><Send size={18} /></button>
              </form>
            </div>
          </> : <div className="flex flex-1 items-center justify-center text-center text-sm text-gray-500">Select a chat to view messages</div>}
        </section>
      </div>
    </main>
  );
}
