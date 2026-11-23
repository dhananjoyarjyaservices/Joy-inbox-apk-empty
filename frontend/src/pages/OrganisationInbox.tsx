import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { ArrowLeft, MessageCircle, Send, RefreshCw, UserRoundCheck, StickyNote } from "lucide-react";
import { db } from "../firebase/config";
import {\n  sendOrganisationWhatsAppText,\n  getOrganisationNotes,\n  addOrganisationNote,\n  assignOrganisationChat,\n  type OrganisationNote,\n} from "../services/organisations";\nimport { useAuth } from "../context/AuthContext";

type ChatRow = {
  id: string;
  customerPhone: string;
  customerName: string;
  lastMessage: string;
  lastMessageAt?: { toDate?: () => Date } | Date | null;
  unreadCount?: number;
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
  const navigate = useNavigate();\n  const { user } = useAuth();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");\n  const [notes, setNotes] = useState<OrganisationNote[]>([]);\n  const [noteDraft, setNoteDraft] = useState("");\n  const [savingNote, setSavingNote] = useState(false);\n  const [assigning, setAssigning] = useState(false);

  const selectedChat = useMemo(() => chats.find((chat) => chat.id === selectedChatId) || null, [chats, selectedChatId]);

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

  async function handleAssignToMe() {
    if (!selectedChat || !user) return;
    setAssigning(true);
    try {
      await assignOrganisationChat(orgId, selectedChat.id, user.uid);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Assignment update nahi hua.");
    } finally { setAssigning(false); }
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
        <div><h1 className="font-semibold">Joy Inbox</h1><p className="text-xs text-white/75">Organisation shared inbox</p></div>
      </header>

      {error && <div role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_1fr]">
        <aside className={`min-h-0 overflow-y-auto bg-white ${selectedChat ? "hidden md:block" : "block"}`}>
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3"><h2 className="font-semibold text-gray-800">Chats</h2><button onClick={() => setError("")} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Clear error"><RefreshCw size={16} /></button></div>
          {loading ? <p className="p-4 text-sm text-gray-500">Loading chats...</p> : chats.length === 0 ? <p className="p-4 text-sm text-gray-500">Abhi koi message nahi aaya. Meta webhook subscription configure karne ke baad incoming chats yahan dikhenge.</p> : chats.map((chat) => (
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
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-6">
              {messages.map((message) => <div key={message.id} className={`flex ${message.direction === "outgoing" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 shadow-sm sm:max-w-[70%] ${message.direction === "outgoing" ? "bg-[#d9fdd3]" : "bg-white"}`}>
                  <p className="whitespace-pre-wrap break-words text-sm text-gray-800">{message.text || (message.type + " message")}</p>
                  <p className="mt-1 text-right text-[10px] text-gray-500">{toDate(message.timestamp)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) || ""}{message.direction === "outgoing" && message.status ? " · " + message.status : ""}</p>
                </div>
              </div>)}
            </div>
            <div className="max-h-36 overflow-y-auto border-t border-gray-200 bg-white px-3 py-2">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-600"><StickyNote size={14} /> Internal notes (team only)</div>
              {notes.map((note) => <div key={note.id} className="mb-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-gray-700"><p>{note.content}</p><p className="mt-1 text-[10px] text-gray-400">{note.authorEmail || note.authorUid}</p></div>)}
              <form onSubmit={handleAddNote} className="flex gap-2">
                <input value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} maxLength={2000} placeholder="Add an internal note..." className="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-xs outline-none focus:border-amber-400" />
                <button disabled={savingNote || !noteDraft.trim()} className="rounded-lg bg-amber-500 px-3 text-xs font-semibold text-white disabled:opacity-50">{savingNote ? "Saving" : "Add note"}</button>
              </form>
            </div>
            <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-gray-200 bg-[#f0f2f5] p-3">
              <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4096} placeholder="Type a message" className="h-11 min-w-0 flex-1 rounded-full border-0 bg-white px-4 text-sm outline-none" />
              <button disabled={sending || !draft.trim()} aria-label="Send WhatsApp message" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#075e54] text-white disabled:opacity-50"><Send size={18} /></button>
            </form>
          </> : <div className="flex flex-1 items-center justify-center text-center text-sm text-gray-500">Select a chat to view messages</div>}
        </section>
      </div>
    </main>
  );
}
