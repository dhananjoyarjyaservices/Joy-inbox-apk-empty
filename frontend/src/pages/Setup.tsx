import { useEffect, useState, type FormEvent } from "react";
import { Building2, LogOut, MessageCircle, RefreshCw } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { logout } from "../services/auth";
import { connectWhatsApp, createOrganization, listOrganizations, type Organization } from "../services/organizations";
import { getActiveOrganizationId, setActiveOrganizationId } from "../services/activeOrganization";

export default function Setup() {
  const { user } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState(() => getActiveOrganizationId());
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
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

  async function handleCreate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const organization = await createOrganization(name);
      setName(""); setOrganizations((items) => [organization, ...items]); setOrganizationId(organization.id); setActiveOrganizationId(organization.id);
      setNotice("Business workspace created.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create workspace."); }
    finally { setBusy(false); }
  }
  async function handleConnect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await connectWhatsApp(organizationId, phoneNumberId.trim(), accessToken.trim());
      setAccessToken(""); setNotice("WhatsApp number verified and connected. Your access token was not returned to the browser.");
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
