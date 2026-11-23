import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Users, Plus, LogOut, RefreshCw, Copy, ShieldCheck } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import {
  acceptInvitation,
  createInvitation,
  createOrganisation,
  listMembers,
  listOrganisations,
  updateOrganisationMemberRole,
  removeOrganisationMember,
  getOrganisationAuditLogs,
  type OrganisationAuditLog,
  type Organisation,
  type OrganisationMember,
  getOrganisationWhatsAppConnection,
  saveOrganisationWhatsAppConnection,
  type WhatsAppConnection,
} from "../services/organisations";

export default function Setup() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [organisations, setOrganisations] = useState<Organisation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [members, setMembers] = useState<OrganisationMember[]>([]);
  const [auditLogs, setAuditLogs] = useState<OrganisationAuditLog[]>([]);
  const [orgName, setOrgName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "manager" | "agent">("agent");
  const [joinOrgId, setJoinOrgId] = useState("");
  const [invitationId, setInvitationId] = useState("");
  const [verified, setVerified] = useState(Boolean(user?.emailVerified));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createdInvite, setCreatedInvite] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [webhookVerifyToken, setWebhookVerifyToken] = useState("");
  const [waConnection, setWaConnection] = useState<WhatsAppConnection>({ connected: false });

  const selected = useMemo(
    () => organisations.find((org) => org.id === selectedId) || null,
    [organisations, selectedId],
  );

  async function refresh() {
    setError("");
    const rows = await listOrganisations();
    setOrganisations(rows);
    setSelectedId((current) => rows.some((org) => org.id === current) ? current : (rows[0]?.id || ""));
  }

  useEffect(() => {
    let active = true;
    listOrganisations()
      .then((rows) => {
        if (!active) return;
        setOrganisations(rows);
        setSelectedId(rows[0]?.id || "");
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load organisations.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selected || !["owner", "admin", "manager"].includes(selected.role)) {
      setMembers([]);
      return;
    }
    let active = true;
    listMembers(selected.id)
      .then((rows) => { if (active) setMembers(rows); })
      .catch(() => { if (active) setMembers([]); });
    return () => { active = false; };
  }, [selected?.id, selected?.role]);

  useEffect(() => {
    if (!selected) { setWaConnection({ connected: false }); return; }
    let active = true;
    getOrganisationWhatsAppConnection(selected.id)
      .then((result) => { if (active) { setWaConnection(result); setPhoneNumberId(result.phoneNumberId || ""); setWabaId(result.wabaId || ""); } })
      .catch(() => { if (active) setWaConnection({ connected: false }); });
    return () => { active = false; };
  }, [selected?.id]);

  async function handleWhatsAppConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await saveOrganisationWhatsAppConnection(selected.id, { phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim(), accessToken: accessToken.trim() });
      setWaConnection(result.connection);
      setWebhookVerifyToken(result.connection.webhookVerifyToken || "");
      setAccessToken("");
      setNotice("Meta credentials verified and encrypted for this organisation. Webhook routing and live inbox activation are still pending.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "WhatsApp connection failed.");
    } finally { setBusy(false); }
  }


  async function handleMemberRoleChange(member: OrganisationMember, role: "admin" | "manager" | "agent") {
    if (!selected || member.uid === user?.uid || member.role === "owner") return;
    setBusy(true); setError(""); setNotice("");
    try {
      await updateOrganisationMemberRole(selected.id, member.uid, role);
      setMembers((rows) => rows.map((row) => row.uid === member.uid ? { ...row, role } : row));
      setNotice("Team member role update ho gaya.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Role update nahi hua.");
    } finally { setBusy(false); }
  }

  async function handleRemoveMember(member: OrganisationMember) {
    if (!selected || member.uid === user?.uid || member.role === "owner") return;
    if (!window.confirm("Remove " + (member.email || member.uid) + " from this organisation?")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await removeOrganisationMember(selected.id, member.uid);
      setMembers((rows) => rows.filter((row) => row.uid !== member.uid));
      setNotice("Team member access revoke kar diya gaya.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Member remove nahi hua.");
    } finally { setBusy(false); }
  }

  async function verifyEmail() {
    setBusy(true);
    setError("");
    try {
      await user?.reload();
      const isVerified = Boolean(user?.emailVerified);
      setVerified(isVerified);
      if (!isVerified) setError("Email abhi verify nahi hua. Inbox ya Spam folder check karo.");
      else setNotice("Email verified. Ab organisation create ya join kar sakte ho.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Verification status check nahi hua.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const org = await createOrganisation(orgName.trim());
      setOrganisations((rows) => [...rows, org]);
      setSelectedId(org.id);
      setOrgName("");
      setNotice(`Organisation "${org.name}" create ho gayi.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Organisation create nahi hui.");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await acceptInvitation(joinOrgId.trim(), invitationId.trim());
      await refresh();
      setNotice("Invitation accept ho gayi. Organisation membership active hai.");
      setJoinOrgId("");
      setInvitationId("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invitation accept nahi hui.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await createInvitation(selected.id, inviteEmail.trim(), inviteRole);
      setCreatedInvite(result.invitation.invitationId);
      setNotice("Invitation create ho gayi. Ab invitation ID aur organisation ID invited person ko securely bhejo.");
      setInviteEmail("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invitation create nahi hui.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <main className="min-h-screen bg-[#f0f2f5] px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold tracking-[0.18em] text-[#075e54]">JOY INBOX</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Business setup</h1>
            <p className="mt-1 text-sm text-gray-500">{user?.email || "Signed-in account"}</p>
          </div>
          <button onClick={handleLogout} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            <LogOut size={16} /> Sign out
          </button>
        </header>

        {error && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {notice && <div role="status" className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</div>}

        {!verified && (
          <section className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-1 text-amber-700" />
              <div className="flex-1">
                <h2 className="font-semibold text-amber-900">Verify your email first</h2>
                <p className="mt-1 text-sm text-amber-800">Registration ke waqt bheja gaya verification email open karo. Verify karne ke baad yahan button dabao.</p>
                <button onClick={verifyEmail} disabled={busy} className="mt-3 rounded-lg bg-[#075e54] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {busy ? "Checking..." : "I've verified my email"}
                </button>
              </div>
            </div>
          </section>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-xl bg-[#e6f4f1] p-2 text-[#075e54]"><Building2 size={21} /></div>
              <div><h2 className="font-semibold text-gray-900">Create a business</h2><p className="text-xs text-gray-500">Aap apne business ke owner banoge.</p></div>
            </div>
            <form onSubmit={handleCreate} className="space-y-3">
              <input value={orgName} onChange={(event) => setOrgName(event.target.value)} maxLength={80} required placeholder="Business / organisation name" className="h-12 w-full rounded-xl border border-gray-200 px-4 text-sm outline-none focus:border-[#075e54]" />
              <button disabled={busy || !verified} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#075e54] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"><Plus size={17} /> Create organisation</button>
            </form>
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-xl bg-blue-50 p-2 text-blue-700"><Users size={21} /></div>
              <div><h2 className="font-semibold text-gray-900">Join a business</h2><p className="text-xs text-gray-500">Admin se organisation ID aur invitation ID lo.</p></div>
            </div>
            <form onSubmit={handleJoin} className="space-y-3">
              <input value={joinOrgId} onChange={(event) => setJoinOrgId(event.target.value)} required placeholder="Organisation ID" className="h-11 w-full rounded-xl border border-gray-200 px-4 text-sm outline-none focus:border-[#075e54]" />
              <input value={invitationId} onChange={(event) => setInvitationId(event.target.value)} required placeholder="Invitation ID" className="h-11 w-full rounded-xl border border-gray-200 px-4 text-sm outline-none focus:border-[#075e54]" />
              <button disabled={busy || !verified} className="w-full rounded-xl border border-[#075e54] px-4 py-3 text-sm font-semibold text-[#075e54] disabled:opacity-50">Accept invitation</button>
            </form>
          </section>
        </div>

        <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-semibold text-gray-900">Your organisations</h2><p className="text-xs text-gray-500">Jin businesses mein aap active member ho.</p></div>
            <button onClick={() => refresh().catch((reason) => setError(reason.message))} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600"><RefreshCw size={14} /> Refresh</button>
          </div>
          {loading ? <p className="text-sm text-gray-500">Loading organisations...</p> : organisations.length === 0 ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">Abhi koi organisation nahi hai. Upar se create karo ya invitation accept karo.</p> : (
            <div className="flex flex-wrap gap-2">
              {organisations.map((org) => <button key={org.id} onClick={() => setSelectedId(org.id)} className={`rounded-xl border px-4 py-3 text-left ${selectedId === org.id ? "border-[#075e54] bg-[#eff8f5]" : "border-gray-200 bg-white"}`}><span className="block text-sm font-semibold text-gray-900">{org.name}</span><span className="mt-1 block text-xs capitalize text-gray-500">{org.role} · {org.plan || "free"} plan</span></button>)}
            </div>
          )}
        </section>

        {selected && (
          <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h2 className="font-semibold text-gray-900">{selected.name}</h2><p className="text-xs text-gray-500">Organisation ID: {selected.id}</p></div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium capitalize text-gray-700">{selected.role}</span>
                <button type="button" onClick={() => navigate(`/org/${selected.id}/inbox`)} className="rounded-xl bg-[#075e54] px-4 py-2 text-sm font-semibold text-white">Open shared inbox</button>
              </div>
            </div>
            <div className="mt-5 rounded-xl border border-gray-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h3 className="font-semibold text-gray-900">WhatsApp Cloud API</h3><p className="text-xs text-gray-500">Connect this business's own Meta number.</p></div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${waConnection.connected ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"}`}>{waConnection.connected ? "Credentials verified" : "Not connected"}</span>
              </div>
              {waConnection.connected && <p className="mt-3 text-sm text-gray-700">{waConnection.displayPhoneNumber || waConnection.phoneNumberId} · {waConnection.verifiedName}</p>}
              {["owner", "admin"].includes(selected.role) && (
                <form onSubmit={handleWhatsAppConnect} className="mt-4 space-y-3">
                  <input value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} required inputMode="numeric" placeholder="WhatsApp Phone Number ID" className="h-11 w-full rounded-xl border border-gray-200 px-3 text-sm outline-none focus:border-[#075e54]" />
                  <input value={wabaId} onChange={(event) => setWabaId(event.target.value)} required inputMode="numeric" placeholder="WhatsApp Business Account ID (WABA ID)" className="h-11 w-full rounded-xl border border-gray-200 px-3 text-sm outline-none focus:border-[#075e54]" />
                  <input value={accessToken} onChange={(event) => setAccessToken(event.target.value)} required type="password" autoComplete="new-password" placeholder="Meta System User / permanent access token" className="h-11 w-full rounded-xl border border-gray-200 px-3 text-sm outline-none focus:border-[#075e54]" />
                  <button disabled={busy} className="w-full rounded-xl bg-[#075e54] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Verifying with Meta..." : waConnection.connected ? "Update WhatsApp credentials" : "Verify and connect number"}</button>
                </form>
              )}
              {webhookVerifyToken && <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-700"><p className="font-semibold">One-time Meta webhook verify token</p><p className="mt-2 break-all font-mono">{webhookVerifyToken}</p><button type="button" onClick={() => navigator.clipboard?.writeText(webhookVerifyToken)} className="mt-2 font-semibold text-[#075e54]">Copy verify token</button><p className="mt-2 text-amber-700">Save this token now. It is shown only once and cannot be retrieved later; reconnect to rotate it.</p></div>}
              <p className="mt-3 text-xs leading-5 text-amber-700">Access token encrypted on the server and never returned to the browser. The webhook handler routes incoming messages into this organisation's own chat collection. Configure the Meta callback URL and subscribe the WABA to this app before testing.</p>
            </div>
            {["owner", "admin"].includes(selected.role) && (
              <form onSubmit={handleInvite} className="mt-5 grid gap-3 sm:grid-cols-[1fr_140px_auto]">
                <input type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="Team member email" className="h-11 rounded-xl border border-gray-200 px-3 text-sm outline-none focus:border-[#075e54]" />
                <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)} className="h-11 rounded-xl border border-gray-200 px-3 text-sm"><option value="agent">Agent</option><option value="manager">Manager</option><option value="admin">Admin</option></select>
                <button disabled={busy} className="rounded-xl bg-[#075e54] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Create invite</button>
              </form>
            )}
            {createdInvite && <div className="mt-3 rounded-xl bg-gray-50 p-3 text-xs text-gray-700"><p className="font-semibold">Share these IDs securely with the invited email owner:</p><p className="mt-2 break-all">Organisation: {selected.id}</p><p className="mt-1 break-all">Invitation: {createdInvite}</p><button onClick={() => navigator.clipboard?.writeText(`Organisation ID: ${selected.id}
Invitation ID: ${createdInvite}`)} className="mt-2 inline-flex items-center gap-2 font-semibold text-[#075e54]"><Copy size={13} /> Copy IDs</button><p className="mt-2 text-amber-700">Email delivery is not configured yet; send these IDs through a trusted channel only to the invited email address.</p></div>}

            {["owner", "admin"].includes(selected.role) && (
              <div className="mt-5 rounded-xl border border-gray-200 p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div><h3 className="font-semibold text-gray-900">Team activity log</h3><p className="text-xs text-gray-500">Latest 100 invitation and membership changes.</p></div>
                  <button type="button" onClick={() => getOrganisationAuditLogs(selected.id).then(setAuditLogs).catch((reason) => setError(reason.message))} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600">Refresh</button>
                </div>
                {auditLogs.length === 0 ? <p className="text-xs text-gray-500">No team activity recorded yet.</p> : <div className="max-h-80 space-y-3 overflow-y-auto">{auditLogs.map((entry) => {
                  const dateValue = entry.createdAt && typeof entry.createdAt === "object" && "toDate" in entry.createdAt && typeof entry.createdAt.toDate === "function" ? entry.createdAt.toDate() : new Date(entry.createdAt as string);
                  const label = entry.action === "invitation.created" ? "Invitation created" : entry.action === "invitation.accepted" ? "Invitation accepted" : entry.action === "member.role_changed" ? "Member role changed" : entry.action === "member.removed" ? "Member removed" : entry.action;
                  return <div key={entry.id} className="border-b border-gray-100 pb-2 last:border-0"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium text-gray-800">{label}</span><span className="text-xs text-gray-400">{Number.isNaN(dateValue.getTime()) ? "" : dateValue.toLocaleString()}</span></div><p className="mt-1 text-xs text-gray-600">By: {entry.actorEmail || entry.actorUid}{entry.targetEmail ? " · Target: " + entry.targetEmail : ""}</p>{entry.details?.previousRole && <p className="text-xs text-gray-500">Role: {String(entry.details.previousRole)} → {String(entry.details.newRole || "removed")}</p>}</div>;
                })}</div>}
              </div>
            )}
            <div className="mt-5"><h3 className="mb-2 text-sm font-semibold text-gray-800">Team members</h3>{members.length ? <div className="divide-y divide-gray-100">{members.map((member) => <div key={member.uid} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div className="min-w-0"><span className="block truncate text-gray-700">{member.email || member.uid}</span><span className="text-xs text-gray-400">{member.uid}</span></div><div className="flex items-center gap-2"><span className="rounded-full bg-gray-100 px-2 py-1 text-xs capitalize text-gray-600">{member.role}</span>{selected && ["owner", "admin"].includes(selected.role) && member.role !== "owner" && member.uid !== user?.uid && <><select aria-label={"Role for " + (member.email || member.uid)} value={member.role} disabled={busy || (selected.role === "admin" && member.role === "admin")} onChange={(event) => handleMemberRoleChange(member, event.target.value as "admin" | "manager" | "agent")} className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs"><option value="agent">Agent</option><option value="manager">Manager</option>{selected.role === "owner" && <option value="admin">Admin</option>}</select><button type="button" disabled={busy} onClick={() => handleRemoveMember(member)} className="rounded-lg border border-red-200 px-2 py-1 text-xs font-medium text-red-600 disabled:opacity-50">Remove</button></>}</div></div>)}</div> : <p className="text-xs text-gray-500">Member list unavailable for your role or no members found.</p>}</div>
          </section>
        )}

        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
          <strong>Development status:</strong> Organisation signup and membership setup are connected. The existing WhatsApp inbox is still on the old single-owner data model. Do not connect live customer numbers or use this as a production shared inbox until conversations, contacts, messages, webhook routing and WhatsApp credentials are tenant-scoped and security-tested.
        </div>
      </div>
    </main>
  );
}
