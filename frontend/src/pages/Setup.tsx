import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Building2, LogOut, MessageCircle, RefreshCw } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import { connectWhatsApp, disconnectWhatsApp, checkWhatsAppConnectionHealth, createOrganization, listOrganizations, listWhatsAppConnections, acceptOrganizationInvitation, type Organization, type WhatsAppConnection } from "../services/organizations";
import { getActiveOrganizationId, setActiveOrganizationId } from "../services/activeOrganization";

export default function Setup() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const invitationHandled = useRef(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState(() => getActiveOrganizationId());
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [connections, setConnections] = useState<WhatsAppConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResults, setHealthResults] = useState<Record<string, { status: "healthy" | "attention"; checkedAt: string; error?: string }>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setLoading(true); setError("");
    try {
      const items = await listOrganizations();
      setOrganizations(items);
      setOrganizationId((current) => { const selected = items.some((item) => item.id === current) ? current : items[0]?.id || ""; setActiveOrganizationId(selected); return selected; });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load organizations."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const fragmentParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    // Accept older query-string links too, but new links keep the token in the
    // fragment so it is not sent to hosting/CDN logs or Referer headers.
    const inviteOrganizationId = fragmentParams.get("organizationId") || searchParams.get("organizationId") || "";
    const inviteToken = fragmentParams.get("invite") || searchParams.get("invite") || "";
    if (!user || !inviteOrganizationId || !inviteToken || invitationHandled.current) return;
    invitationHandled.current = true;
    setSearchParams({}, { replace: true });
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    setBusy(true); setError(""); setNotice("");
    void acceptOrganizationInvitation(inviteOrganizationId, inviteToken)
      .then(async () => {
        await refresh();
        setActiveOrganizationId(inviteOrganizationId);
        setOrganizationId(inviteOrganizationId);
        setNotice("Invitation accepted. Your workspace access is ready.");
        navigate("/inbox", { replace: true });
      })
      .catch(e => setError(e instanceof Error ? e.message : "Invitation could not be accepted. Sign in with the invited verified email address."))
      .finally(() => setBusy(false));
  }, [user, searchParams, setSearchParams, navigate]);

  useEffect(() => {
    if (!organizationId) { setConnections([]); return; }
    let active = true;
    setConnectionsLoading(true);
    listWhatsAppConnections(organizationId)
      .then(items => { if (active) setConnections(items); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "WhatsApp numbers could not load."); })
      .finally(() => { if (active) setConnectionsLoading(false); });
    return () => { active = false; };
  }, [organizationId]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const organization = await createOrganization(name);
      setName(""); setOrganizations((items) => [organization, ...items]); setOrganizationId(organization.id); setActiveOrganizationId(organization.id);
      setNotice("Business workspace created.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create workspace."); }
    finally { setBusy(false); }
  }
  async function handleHealthCheck() {
    if (!organizationId || healthChecking || busy) return;
    setHealthChecking(true); setError(""); setNotice("");
    try {
      const results = await checkWhatsAppConnectionHealth(organizationId);
      setHealthResults(Object.fromEntries(results.map((item) => [item.phoneNumberId, {
        status: item.status, checkedAt: item.checkedAt, ...(item.error ? { error: item.error } : {})
      }])));
      const healthy = results.filter((item) => item.status === "healthy").length;
      setNotice(`Health check complete: ${healthy} of ${results.length} connected number(s) healthy.`);
    } catch (e) { setError(e instanceof Error ? e.message : "WhatsApp health check failed."); }
    finally { setHealthChecking(false); }
  }

  async function handleDisconnect(connection: WhatsAppConnection) {
    if (!organizationId || busy) return;
    const label = connection.displayPhoneNumber || connection.phoneNumberId;
    if (!confirm(`Disconnect ${label} from this workspace? Existing chats and messages will remain saved.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await disconnectWhatsApp(organizationId, connection.phoneNumberId);
      setConnections(await listWhatsAppConnections(organizationId));
      setNotice(`${label} disconnected. Existing chat history was kept.`);
    } catch (e) { setError(e instanceof Error ? e.message : "WhatsApp number could not be disconnected."); }
    finally { setBusy(false); }
  }

  async function handleConnect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await connectWhatsApp(organizationId, phoneNumberId.trim(), accessToken.trim());
      setAccessToken(""); setNotice("WhatsApp number verified and connected.");
      setConnections(await listWhatsAppConnections(organizationId));
    } catch (e) { setError(e instanceof Error ? e.message : "WhatsApp connection failed."); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-[#eef2f3] px-4 py-8">
    <div className="mx-auto max-w-2xl">
      <header className="mb-7 flex items-center justify-between rounded-2xl bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3"><div className="rounded-xl bg-[#075e54] p-3 text-white"><MessageCircle /></div><div><h1 className="text-xl font-bold text-[#075e54]">JOY INBOX</h1><p className="text-xs text-gray-500">{user?.email || "Business setup"}</p></div></div>
        <button onClick={() => void logout()} className="flex items-center gap-2 text-sm text-gray-600"><LogOut size={17}/> Sign out</button>
      </header>
      <section className="mb-5 rounded-2xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2"><Building2 className="text-[#075e54]"/><h2 className="text-lg font-semibold">Your business workspaces</h2><button onClick={() => void refresh()} className="ml-auto text-gray-500"><RefreshCw size={17}/></button></div>
        {loading ? <p className="text-sm text-gray-500">Loading workspaces...</p> : organizations.length ? <div className="space-y-2">{organizations.map((org) => <button key={org.id} onClick={() => { setOrganizationId(org.id); setActiveOrganizationId(org.id); }} className={`w-full rounded-xl border p-3 text-left ${organizationId === org.id ? "border-[#075e54] bg-[#effaf3]" : "border-gray-200"}`}><span className="block font-medium">{org.name}</span><span className="text-xs text-gray-500">{org.role} · {org.status}</span></button>)}</div> : <p className="text-sm text-gray-500">No workspace yet. Create your business workspace below.</p>}
        <form onSubmit={handleCreate} className="mt-5 flex gap-2"><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name" className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-3 text-sm"/><button disabled={busy} className="rounded-xl bg-[#075e54] px-4 text-sm font-semibold text-white disabled:opacity-60">Create</button></form>
      </section>
      <section className="mb-5 rounded-2xl bg-white p-6 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Connected WhatsApp numbers</h2><div className="flex items-center gap-2"><span className="rounded-full bg-[#effaf3] px-3 py-1 text-xs font-medium text-[#075e54]">{connections.filter(connection => connection.connected).length} connected</span><button type="button" disabled={!connections.some(connection => connection.connected) || healthChecking || busy} onClick={() => void handleHealthCheck()} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-[#075e54] disabled:opacity-50">{healthChecking ? "Checking..." : "Check status"}</button></div></div>
        {connectionsLoading ? <p className="text-sm text-gray-500">Loading connected numbers...</p> : connections.length ? <div className="space-y-2">{connections.map(connection => <div key={connection.phoneNumberId} className="rounded-xl border border-gray-200 p-3"><div className="flex items-center justify-between gap-3"><p className="font-medium">{connection.displayPhoneNumber || "WhatsApp number"}</p><div className="flex items-center gap-2"><span className={`text-xs ${connection.connected ? "text-green-700" : "text-gray-500"}`}>{connection.connected ? "Connected" : "Disconnected"}</span>{connection.connected && <button type="button" disabled={busy} onClick={() => void handleDisconnect(connection)} className="text-xs font-medium text-red-600 disabled:opacity-50">Disconnect</button>}</div></div><p className="mt-1 text-sm text-gray-600">{connection.verifiedName || "Business name not provided"}</p><p className="mt-1 break-all text-xs text-gray-400">Phone Number ID: {connection.phoneNumberId}</p>{connection.connected && healthResults[connection.phoneNumberId] && <div className="mt-2 rounded-lg bg-gray-50 p-2"><p className={`text-xs font-medium ${healthResults[connection.phoneNumberId].status === "healthy" ? "text-green-700" : "text-amber-700"}`}>{healthResults[connection.phoneNumberId].status === "healthy" ? "Healthy · Meta verified" : "Attention required"}</p>{healthResults[connection.phoneNumberId].error && <p className="mt-1 text-xs text-amber-700">{healthResults[connection.phoneNumberId].error}</p>}<p className="mt-1 text-[11px] text-gray-400">Checked: {new Date(healthResults[connection.phoneNumberId].checkedAt).toLocaleString()}</p></div>}</div>)}</div> : <p className="text-sm text-gray-500">No WhatsApp numbers connected to this workspace yet.</p>}
      </section>
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold">Connect WhatsApp Cloud API</h2><p className="mb-4 text-sm text-gray-500">Select a workspace, then enter its Meta Phone Number ID and permanent access token. The token is stored encrypted on the server.</p>
        <form onSubmit={handleConnect} className="space-y-3">
          <select required value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setActiveOrganizationId(e.target.value); }} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm"><option value="">Select workspace</option>{organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select>
          <input required value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="Meta Phone Number ID" className="w-full rounded-xl border border-gray-200 px-3 py-3 text-sm"/>
          <input required type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="Meta access token" className="w-full rounded-xl border border-gray-200 px-3 py-3 text-sm"/>
          <button disabled={busy || !organizationId} className="w-full rounded-xl bg-[#075e54] py-3 font-semibold text-white disabled:opacity-60">{busy ? "Please wait..." : "Verify and connect number"}</button>
        </form>
      </section>
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-4 rounded-xl bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
      <p className="mt-5 text-center text-xs text-gray-500">Workspace setup is available. The tenant chat dashboard is still under development.</p>
    </div>
  </main>;
}
