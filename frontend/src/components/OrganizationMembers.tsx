import { useCallback, useEffect, useState, type FormEvent } from "react";
import { UserPlus, RefreshCw, Shield, Trash2 } from "lucide-react";
import { addOrganizationMember, listOrganizationMembers, removeOrganizationMember, updateOrganizationMemberRole, type OrganizationMember } from "../services/organizationMembers";

type Props = { organizationId: string; actorRole: "owner" | "admin" | "agent" };
export default function OrganizationMembers({ organizationId, actorRole }: Props) {
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "agent">("agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canManage = actorRole === "owner" || actorRole === "admin";

  const refresh = useCallback(async () => {
    setError("");
    try {
      const page = await listOrganizationMembers(organizationId, { limit: 25 });
      setMembers(page.members);
      setNextCursor(page.nextCursor);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Members could not be loaded."); }
  }, [organizationId]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); setError("");
    try {
      const page = await listOrganizationMembers(organizationId, { limit: 25, cursor: nextCursor });
      setMembers(current => {
        const seen = new Set(current.map(member => member.uid));
        return [...current, ...page.members.filter(member => !seen.has(member.uid))];
      });
      setNextCursor(page.nextCursor);
    } catch (e) { setError(e instanceof Error ? e.message : "More members could not be loaded."); }
    finally { setLoadingMore(false); }
  }


  async function add(event: FormEvent) {
    event.preventDefault();
    if (!canManage || busy) return;
    setBusy(true); setError("");
    try {
      await addOrganizationMember(organizationId, email.trim(), role);
      setEmail(""); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Member could not be added."); }
    finally { setBusy(false); }
  }
  async function changeRole(member: OrganizationMember, nextRole: "admin" | "agent") {
    if (!canManage || member.role === "owner" || busy) return;
    setBusy(true); setError("");
    try { await updateOrganizationMemberRole(organizationId, member.uid, nextRole); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Role could not be changed."); }
    finally { setBusy(false); }
  }
  async function remove(member: OrganizationMember) {
    if (!canManage || member.role === "owner" || busy || !window.confirm(`Remove ${member.email || member.uid} from this workspace?`)) return;
    setBusy(true); setError("");
    try { await removeOrganizationMember(organizationId, member.uid); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Member could not be removed."); }
    finally { setBusy(false); }
  }

  return <section className="flex-1 overflow-y-auto bg-white p-4">
    <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Workspace members</h2><p className="text-sm text-gray-500">Manage who can access this business inbox.</p></div><button onClick={() => void refresh()} className="rounded-lg border p-2" aria-label="Refresh members"><RefreshCw size={17}/></button></div>
    {canManage && <form onSubmit={add} className="mb-5 grid gap-2 rounded-xl border bg-gray-50 p-3 sm:grid-cols-[1fr_140px_auto]">
      <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Existing Joy Inbox account email" className="min-w-0 rounded-lg border bg-white px-3 py-2 text-sm"/>
      <select value={role} onChange={e => setRole(e.target.value as "admin" | "agent")} className="rounded-lg border bg-white px-3 py-2 text-sm">
        <option value="agent">Agent</option>{actorRole === "owner" && <option value="admin">Admin</option>}
      </select>
      <button disabled={busy} className="flex items-center justify-center gap-2 rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50"><UserPlus size={16}/> Add member</button>
    </form>}
    <p className="mb-3 text-xs text-gray-500">Members must already have a Joy Inbox account. This does not send an email invitation.</p>
    {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="divide-y">{members.filter(m => m.status === "active").map(member => <div key={member.uid} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0"><p className="truncate font-medium">{member.displayName || member.email || member.uid}</p><p className="truncate text-xs text-gray-500">{member.email}</p></div>
      <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs capitalize"><Shield size={13}/>{member.role}</span>
        {canManage && member.role !== "owner" && <><select aria-label={`Role for ${member.email}`} disabled={busy || (member.role === "admin" && actorRole !== "owner")} value={member.role} onChange={e => void changeRole(member, e.target.value as "admin" | "agent")} className="rounded-lg border px-2 py-1.5 text-xs"><option value="agent">Agent</option>{actorRole === "owner" && <option value="admin">Admin</option>}</select><button disabled={busy} onClick={() => void remove(member)} className="rounded-lg p-2 text-red-600 hover:bg-red-50" aria-label={`Remove ${member.email}`}><Trash2 size={16}/></button></>}
      </div>
    </div>)}</div>
    {!members.some(m => m.status === "active") && !error && <p className="py-8 text-center text-sm text-gray-500">No active members found.</p>}
    {nextCursor && <div className="flex justify-center py-4"><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">{loadingMore ? "Loading..." : "Load more members"}</button></div>}
  </section>;
}
