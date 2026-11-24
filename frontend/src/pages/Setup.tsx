import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Building2, LogOut, MessageCircle, RefreshCw } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import { disconnectWhatsApp, checkWhatsAppConnectionHealth, createOrganization, listOrganizations, listWhatsAppConnections, acceptOrganizationInvitation, getWhatsAppEmbeddedSignupConfig, startWhatsAppEmbeddedSignup, completeWhatsAppEmbeddedSignup, type Organization, type WhatsAppConnection, type WhatsAppEmbeddedSignupConfig } from "../services/organizations";
import { getActiveOrganizationId, setActiveOrganizationId } from "../services/activeOrganization";

declare global {
  interface Window {
    FB?: {
      init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
      login(callback: (response: any) => void, options: Record<string, unknown>): void;
    };
    fbAsyncInit?: () => void;
  }
}

async function ensureFacebookSdk(appId: string, version: string) {
  if (window.FB) {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      try {
        if (!window.FB) throw new Error("Meta login could not be initialized. Refresh and try again.");
        window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version });
        resolve();
      } catch (error) { reject(error); }
    };
    if (!document.getElementById("facebook-jssdk")) {
      const script = document.createElement("script");
      script.id = "facebook-jssdk";
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.onerror = () => reject(new Error("Meta login SDK could not load. Check your connection and try again."));
      document.body.appendChild(script);
    }
  });
}

function runMetaEmbeddedSignup(config: WhatsAppEmbeddedSignupConfig): Promise<{ code: string; wabaId: string; phoneNumberId: string }> {
  if (!config.appId || !config.configId || !config.graphApiVersion) {
    return Promise.reject(new Error("WhatsApp self-service onboarding is not configured yet."));
  }
  return new Promise((resolve, reject) => {
    let code = "";
    let account: { wabaId: string; phoneNumberId: string } | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      if (!error && (!code || !account)) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ code, ...account! });
    };
    const timeout = window.setTimeout(() => finish(new Error("Meta signup timed out. Please start again.")), 180000);
    const onMessage = (event: MessageEvent) => {
      let hostname = "";
      try { hostname = new URL(event.origin).hostname; } catch { return; }
      if (hostname !== "facebook.com" && !hostname.endsWith(".facebook.com")) return;
      let data: any;
      try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "FINISH") {
        const wabaId = String(data.data?.waba_id || "");
        const phoneNumberId = String(data.data?.phone_number_id || "");
        if (!/^\d{5,32}$/.test(wabaId) || !/^\d{5,32}$/.test(phoneNumberId)) {
          finish(new Error("Meta did not return the selected WhatsApp number. Please try again."));
          return;
        }
        account = { wabaId, phoneNumberId };
        finish();
      } else if (data.event === "CANCEL") {
        finish(new Error("WhatsApp setup was cancelled. You can try again whenever you are ready."));
      } else if (data.event === "ERROR") {
        finish(new Error(String(data.data?.error_message || "Meta could not complete WhatsApp setup.").slice(0, 240)));
      }
    };
    window.addEventListener("message", onMessage);
    const options: Record<string, unknown> = {
      config_id: config.configId,
      response_type: "code",
      override_default_response_type: true,
      auth_type: "rerequest",
      extras: { setup: config.solutionId ? { solutionID: config.solutionId } : {} }
    };
    try {
      if (!window.FB) throw new Error("Meta login is not ready. Refresh and try again.");
      window.FB.login((response) => {
        const authorizationCode = String(response?.authResponse?.code || response?.code || "");
        if (!authorizationCode) {
          finish(new Error("Meta authorization was not completed. Please try again."));
          return;
        }
        code = authorizationCode;
        finish();
      }, options);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Meta signup could not be opened."));
    }
  });
}


export default function Setup() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const invitationHandled = useRef(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState(() => getActiveOrganizationId());
  const [embeddedConfig, setEmbeddedConfig] = useState<WhatsAppEmbeddedSignupConfig>({ enabled: false });
  const [embeddedConfigLoading, setEmbeddedConfigLoading] = useState(false);
  const [embeddedSignupBusy, setEmbeddedSignupBusy] = useState(false);
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
    if (!user.emailVerified) {
      setError("Email verify nahi hua. Pehle verification email ka link open karo, phir sign out karke dobara sign in karo. Invitation link safe rahega.");
      return;
    }
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
    if (!organizationId) { setEmbeddedConfig({ enabled: false }); return; }
    let active = true;
    setEmbeddedConfigLoading(true);
    getWhatsAppEmbeddedSignupConfig(organizationId)
      .then(config => { if (active) setEmbeddedConfig(config); })
      .catch(() => { if (active) setEmbeddedConfig({ enabled: false }); })
      .finally(() => { if (active) setEmbeddedConfigLoading(false); });
    return () => { active = false; };
  }, [organizationId]);

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

  async function handleEmbeddedSignup() {
    if (!organizationId || embeddedSignupBusy || !embeddedConfig.enabled) return;
    setEmbeddedSignupBusy(true); setError(""); setNotice("");
    try {
      const session = await startWhatsAppEmbeddedSignup(organizationId);
      await ensureFacebookSdk(embeddedConfig.appId || "", embeddedConfig.graphApiVersion || "v26.0");
      const meta = await runMetaEmbeddedSignup(embeddedConfig);
      await completeWhatsAppEmbeddedSignup({
        organizationId,
        sessionId: session.sessionId,
        code: meta.code,
        wabaId: meta.wabaId,
        phoneNumberId: meta.phoneNumberId
      });
      setConnections(await listWhatsAppConnections(organizationId));
      setNotice("WhatsApp Business is connected. Your number is ready in Joy Inbox.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "WhatsApp setup could not be completed. Please try again.");
    } finally { setEmbeddedSignupBusy(false); }
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
        <div className="mb-2 flex items-center gap-2"><MessageCircle className="text-[#075e54]"/><h2 className="text-lg font-semibold">Connect WhatsApp Business</h2></div>
        <p className="mb-5 text-sm text-gray-600">Connect securely through Meta. Joy Inbox will configure your Cloud API connection automatically—no Phone Number ID, access token or webhook URL to copy.</p>
        <button type="button" onClick={() => void handleEmbeddedSignup()} disabled={!organizationId || embeddedSignupBusy || embeddedConfigLoading || !embeddedConfig.enabled} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1877F2] py-3.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {embeddedSignupBusy ? "Connecting to Meta..." : embeddedConfigLoading ? "Preparing secure connection..." : "Continue with Facebook"}
        </button>
        {!embeddedConfigLoading && !embeddedConfig.enabled && <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Self-service WhatsApp connection is being configured by Joy Inbox. Please try again later.</div>}
        <p className="mt-3 text-xs text-gray-500">Meta will ask you to sign in, select your business, verify ownership of your phone number and approve the requested permissions. Joy Inbox never asks you to share your password or access token.</p>
      </section>
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-4 rounded-xl bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
      <p className="mt-5 text-center text-xs text-gray-500">Workspace setup is available. The tenant chat dashboard is still under development.</p>
    </div>
  </main>;
}
