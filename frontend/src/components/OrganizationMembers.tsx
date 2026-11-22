import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { UserPlus, RefreshCw, Shield, Trash2, Search, History } from "lucide-react";
import { addOrganizationMember, listOrganizationMembers, removeOrganizationMember, updateOrganizationMemberRole, type OrganizationMember, listOrganizationMemberAudit, type OrganizationMemberAuditEvent } from "../services/organizationMembers";

type Props = { organizationId: string; actorRole: "owner" | "admin" | "agent" };
export default function OrganizationMembers({ organizationId, actorRole }: Props) {
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "agent">("agent");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "removed" | "disabled" | "all">("active");
  const [roleFilter, setRoleFilter] = useState<"all" | "owner" | "admin" | "agent">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [auditEvents, setAuditEvents] = useState<OrganizationMemberAuditEvent[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const auditRequestId = useRef(0);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
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
  useEffect(() => {
    auditRequestId.current += 1;
    setAuditEvents([]);
    setAuditCursor(null);
    setAuditError("");
    setShowAudit(false);
    setAuditLoading(false);
  }, [organizationId]);
  const filteredMembers = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return members.filter(member => {
      const matchesSearch = !term || [member.displayName, member.email, member.uid].some(value => value.toLocaleLowerCase().includes(term));
      const matchesStatus = statusFilter === "all" || member.status === statusFilter;
      const matchesRole = roleFilter === "all" || member.role === roleFilter;
      return matchesSearch && matchesStatus && matchesRole;
    });
  }, [members, search, statusFilter, roleFilter]);

  async function loadAudit() {
    const requestId = ++auditRequestId.current;
    setAuditLoading(true);
    setAuditError("");
    try {
      const page = await listOrganizationMemberAudit(organizationId, { limit: 25 });
      if (requestId !== auditRequestId.current) return;
      setAuditEvents(page.events);
      setAuditCursor(page.nextCursor);
    } catch (e) {
      if (requestId === auditRequestId.current) setAuditError(e instanceof Error ? e.message : "Member activity could not be loaded.");
    } finally { if (requestId === auditRequestId.current) setAuditLoading(false); }
  }

  async function toggleAudit() {
    if (showAudit) { setShowAudit(false); return; }
    setShowAudit(true);
    if (auditEvents.length || auditLoading) return;
    await loadAudit();
  }
  async function loadMoreAudit() {
    if (!auditCursor || auditLoading) return;
    const requestId = ++auditRequestId.current;
    setAuditLoading(true);
    setAuditError("");
    try {
      const page = await listOrganizationMemberAudit(organizationId, { limit: 25, cursor: auditCursor });
      if (requestId !== auditRequestId.current) return;
      setAuditEvents(current => {
        const seen = new Set(current.map(event => event.id));
        return [...current, ...page.events.filter(event => !seen.has(event.id))];
      });
      setAuditCursor(page.nextCursor);
    } catch (e) {
      if (requestId === auditRequestId.current) setAuditError(e instanceof Error ? e.message : "More activity could not be loaded.");
    } finally { if (requestId === auditRequestId.current) setAuditLoading(false); }
  }
  function auditDescription(event: OrganizationMemberAuditEvent) {
    if (event.action === "member.added") return "Added " + (event.targetEmail || event.targetUid) + " as " + String(event.details.role || "member");
    if (event.action === "member.role_changed") return "Changed " + (event.targetEmail || event.targetUid) + " role to " + String(event.details.role || "updated role");
    if (event.action === "member.removed") return "Removed " + (event.targetEmail || event.targetUid);
    return event.action.replaceAll(".", " ");
  }
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
    <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Workspace members</h2><p className="text-sm text-gray-500">Manage who can access this business inbox.</p></div><div className="flex gap-2">{canManage && <button onClick={() => void toggleAudit()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs" aria-expanded={showAudit}><History size={15}/>{showAudit ? "Hide activity" : "Activity history"}</button>}<button onClick={() => void refresh()} className="rounded-lg border p-2" aria-label="Refresh members"><RefreshCw size={17}/></button></div></div>
    {showAudit && <div className="mb-5 rounded-xl border p-3"><h3 className="mb-2 text-sm font-semibold">Recent member activity</h3>{auditLoading ? <p className="py-3 text-sm text-gray-500">Loading activity...</p> : auditError ? <div className="py-3"><p role="alert" className="mb-2 text-sm text-red-700">{auditError}</p><button type="button" onClick={() => void loadAudit()} className="rounded-lg border px-3 py-2 text-xs">Retry loading activity</button></div> : auditEvents.length ? <div className="divide-y">{auditEvents.map(event => <div key={event.id} className="py-2"><p className="text-sm">{auditDescription(event)}</p><p className="text-xs text-gray-500">By {event.actorEmail || event.actorUid || "Unknown"} · {event.actorRole || "member"} · {event.createdAt && typeof event.createdAt === "object" && "toDate" in event.createdAt && typeof event.createdAt.toDate === "function" ? event.createdAt.toDate().toLocaleString() : event.createdAt ? new Date(String(event.createdAt)).toLocaleString() : "Time unavailable"}</p></div>)}{auditCursor && <div className="pt-3 text-center"><button type="button" disabled={auditLoading} onClick={() => void loadMoreAudit()} className="rounded-lg border px-4 py-2 text-xs disabled:opacity-50">{auditLoading ? "Loading..." : "Load more activity"}</button></div>}</div> : <p className="py-3 text-sm text-gray-500">No member activity recorded yet.</p>}</div>}
    {canManage && <form onSubmit={add} className="mb-5 grid gap-2 rounded-xl border bg-gray-50 p-3 sm:grid-cols-[1fr_140px_auto]">
      <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Existing Joy Inbox account email" className="min-w-0 rounded-lg border bg-white px-3 py-2 text-sm"/>
      <select value={role} onChange={e => setRole(e.target.value as "admin" | "agent")} className="rounded-lg border bg-white px-3 py-2 text-sm">
        <option value="agent">Agent</option>{actorRole === "owner" && <option value="admin">Admin</option>}
      </select>
      <button disabled={busy} className="flex items-center justify-center gap-2 rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50"><UserPlus size={16}/> Add member</button>
    </form>}
    <p className="mb-3 text-xs text-gray-500">Members must already have a Joy Inbox account. This does not send an email invitation.</p>
    {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_140px]">
      <label className="relative block"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search loaded members by name, email or ID" aria-label="Search loaded members" className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm"/></label>
      <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)} aria-label="Filter members by status" className="rounded-lg border bg-white px-3 py-2 text-sm"><option value="active">Active members</option><option value="removed">Removed members</option><option value="disabled">Disabled members</option><option value="all">All statuses</option></select>
      <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as typeof roleFilter)} aria-label="Filter members by role" className="rounded-lg border bg-white px-3 py-2 text-sm"><option value="all">All roles</option><option value="owner">Owner</option><option value="admin">Admin</option><option value="agent">Agent</option></select>
    </div>
    <p className="mb-2 text-xs text-gray-500">Showing {filteredMembers.length} of {members.length} loaded members{nextCursor ? " · Load more to search additional members" : ""}.</p>
    <div className="divide-y">{filteredMembers.map(member => <div key={member.uid} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0"><p className="truncate font-medium">{member.displayName || member.email || member.uid}</p><p className="truncate text-xs text-gray-500">{member.email || member.uid}</p></div>
      <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs capitalize"><Shield size={13}/>{member.role} · {member.status}</span>
        {canManage && member.status === "active" && member.role !== "owner" && <><select aria-label={`Role for ${member.email}`} disabled={busy || (member.role === "admin" && actorRole !== "owner")} value={member.role} onChange={e => void changeRole(member, e.target.value as "admin" | "agent")} className="rounded-lg border px-2 py-1.5 text-xs"><option value="agent">Agent</option>{actorRole === "owner" && <option value="admin">Admin</option>}</select><button disabled={busy} onClick={() => void remove(member)} className="rounded-lg p-2 text-red-600 hover:bg-red-50" aria-label={`Remove ${member.email}`}><Trash2 size={16}/></button></>}
      </div>
    </div>)}</div>
    {filteredMembers.length === 0 && !error && <p className="py-8 text-center text-sm text-gray-500">{members.length ? "No loaded members match these filters." : "No members found."}</p>}
    {nextCursor && <div className="flex justify-center py-4"><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">{loadingMore ? "Loading..." : "Load more members"}</button></div>}
  </section>;
}
