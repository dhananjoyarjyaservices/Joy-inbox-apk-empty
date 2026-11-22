import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, MessageCircle, Send, Settings, RefreshCw } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import { getActiveOrganizationId } from "../services/activeOrganization";
import { listOrganizations, sendTenantText, type Organization } from "../services/organizations";
import { listenToTenantChats, listenToTenantMessages } from "../services/tenantChats";

type TenantChat = {
  id: string;
  customerPhone?: string;
  customerName?: string;
  lastMessage?: string;
  lastMessageAt?: { toDate?: () => Date } | Date | string;
  unreadCount?: number;
};
type TenantMessage = {
  id: string;
  text?: string;
  type?: string;
  direction?: string;
  timestamp?: { toDate?: () => Date } | Date | string;
  status?: string;
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
  const [messages, setMessages] = useState<TenantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

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
      setSelected((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id || "");
    }, (e) => setError(e.message));
  }, [organization]);

  useEffect(() => {
    if (!organization || !selected) { setMessages([]); return; }
    return listenToTenantMessages(organization.id, selected, (items) => setMessages(items as TenantMessage[]), (e) => setError(e.message));
  }, [organization, selected]);

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
    <div className="flex min-h-0 flex-1">
      <aside className={\`w-full max-w-sm overflow-y-auto border-r border-gray-200 bg-white \${selected ? "hidden md:block" : "block"}\`}>
        <div className="flex items-center justify-between border-b p-4"><h2 className="font-semibold">Chats</h2><button onClick={() => setError("")} title="Clear error"><RefreshCw size={16}/></button></div>
        {chats.length ? chats.map((chat) => <button key={chat.id} onClick={() => setSelected(chat.id)} className={\`w-full border-b border-gray-100 p-4 text-left hover:bg-gray-50 \${selected === chat.id ? "bg-[#effaf3]" : ""}\`}>
          <div className="flex justify-between gap-2"><span className="truncate font-medium">{chat.customerName || chat.customerPhone || chat.id}</span><span className="text-xs text-gray-400">{timeLabel(chat.lastMessageAt)}</span></div>
          <p className="mt-1 truncate text-sm text-gray-500">{chat.lastMessage || "No message preview"}</p>
        </button>) : <p className="p-6 text-sm text-gray-500">No conversations yet. New WhatsApp messages will appear here.</p>}
      </aside>
      <section className={\`flex min-w-0 flex-1 flex-col \${selected ? "flex" : "hidden md:flex"}\`}>
        {currentChat ? <>
          <div className="flex items-center gap-3 border-b bg-white p-3"><button className="md:hidden" onClick={() => setSelected("")}>←</button><div className="grid h-9 w-9 place-items-center rounded-full bg-[#d9fdd3] font-semibold text-[#075e54]">{(currentChat.customerName || currentChat.customerPhone || selected).slice(0,1).toUpperCase()}</div><div><p className="font-semibold">{currentChat.customerName || currentChat.customerPhone || selected}</p><p className="text-xs text-gray-500">{currentChat.customerPhone || selected}</p></div></div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((message) => <div key={message.id} className={\`flex \${message.direction === "outgoing" ? "justify-end" : "justify-start"}\`}><div className={\`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm \${message.direction === "outgoing" ? "bg-[#d9fdd3]" : "bg-white"}\`}><p className="whitespace-pre-wrap break-words text-sm">{message.text || \`[\${message.type || "Message"}]\`}</p><p className="mt-1 text-right text-[10px] text-gray-400">{timeLabel(message.timestamp)} {message.status || ""}</p></div></div>)}
          </div>
          <form onSubmit={submit} className="flex gap-2 border-t bg-white p-3"><input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4096} placeholder="Type a message" className="min-w-0 flex-1 rounded-full border border-gray-200 px-4 py-3 text-sm outline-none focus:border-[#075e54]"/><button disabled={sending || !draft.trim()} className="grid h-11 w-11 place-items-center rounded-full bg-[#075e54] text-white disabled:opacity-50"><Send size={18}/></button></form>
        </> : <div className="grid flex-1 place-items-center text-center text-sm text-gray-500"><div><MessageCircle className="mx-auto mb-2 opacity-40" size={36}/><p>Select a conversation to start</p></div></div>}
      </section>
    </div>
    {error && <div role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
  </main>;
}
