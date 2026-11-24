import { useEffect, useState, type FormEvent } from "react";
import {
  createOrganizationApiKey,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  type OrganizationApiKey
} from "../services/organizations";

function displayDate(value: unknown) {
  if (!value) return "—";
  const date = typeof (value as { toDate?: () => Date }).toDate === "function"
    ? (value as { toDate: () => Date }).toDate()
    : new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function DeveloperPanel({ organizationId }: { organizationId: string }) {
  const [keys, setKeys] = useState<OrganizationApiKey[]>([]);
  const [name, setName] = useState("");
  const [readContacts, setReadContacts] = useState(true);
  const [writeContacts, setWriteContacts] = useState(false);
  const [expiryDays, setExpiryDays] = useState(90);
  const [newKey, setNewKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    if (!organizationId) return;
    setLoading(true);
    try { setKeys(await listOrganizationApiKeys(organizationId)); }
    catch (e) { setError(e instanceof Error ? e.message : "API keys could not be loaded."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [organizationId]);

  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true); setError(""); setNotice(""); setNewKey(""); setCopied(false);
    try {
      const result = await createOrganizationApiKey({
        organizationId,
        name,
        scopes: [ ...(readContacts ? ["contacts:read"] : []), ...(writeContacts ? ["contacts:write"] : []) ],
        expiryDays
      });
      setNewKey(result.apiKey.apiKey);
      setName("");
      setNotice("API key created. Copy it now; the full key is shown only once.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "API key could not be created."); }
    finally { setSaving(false); }
  }

  async function revoke(key: OrganizationApiKey) {
    if (!confirm(`Revoke the API key “${key.name}”? Integrations using it will stop working immediately.`)) return;
    setError(""); setNotice("");
    try {
      await revokeOrganizationApiKey(organizationId, key.id);
      setKeys(current => current.map(item => item.id === key.id ? { ...item, status: "revoked" } : item));
      setNotice("API key revoked.");
    } catch (e) { setError(e instanceof Error ? e.message : "API key could not be revoked."); }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setError("Clipboard access is unavailable. Select and copy the key manually.");
    }
  }

  return (
    <section className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Developer API</h2>
          <p className="mt-1 text-sm text-gray-500">Create scoped keys for your own systems and integrations. Keys are shown once and stored only as SHA-256 hashes.</p>
        </div>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
        {newKey && <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Copy your new API key now</p>
          <p className="mt-1 text-xs text-amber-800">Joy Inbox will not display the full secret again. Store it in your server's secret manager, not in browser code or a public repository.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input readOnly value={newKey} className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white p-2 font-mono text-xs"/>
            <button type="button" onClick={() => void copyKey()} className="rounded-lg bg-amber-900 px-4 py-2 text-xs font-semibold text-white">{copied ? "Copied" : "Copy key"}</button>
          </div>
        </div>}
        <form onSubmit={createKey} className="space-y-3 rounded-xl border bg-white p-4">
          <h3 className="font-semibold">Create API key</h3>
          <label className="block text-sm text-gray-600">Key name
            <input required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Website CRM sync" className="mt-1 w-full rounded-lg border p-2 text-sm"/>
          </label>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-600">Permissions</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={readContacts} onChange={event => setReadContacts(event.target.checked)}/> Read contacts</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={writeContacts} onChange={event => setWriteContacts(event.target.checked)}/> Create/update contacts</label>
          </div>
          <label className="block text-sm text-gray-600">Key expires after
            <select value={expiryDays} onChange={event => setExpiryDays(Number(event.target.value))} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm">
              <option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>365 days</option>
            </select>
          </label>
          <button disabled={saving || !organizationId || (!readContacts && !writeContacts)} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Creating..." : "Create API key"}</button>
        </form>
        <div className="rounded-xl border bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">API keys</h3><button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54]">{loading ? "Refreshing..." : "Refresh"}</button></div>
          {keys.length ? <div className="space-y-2">{keys.map(key => <article key={key.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{key.name}</strong><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${key.status === "active" ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>{key.status}</span></div>
            <p className="mt-1 font-mono text-xs text-gray-500">{key.keyPrefix}••••••••</p>
            <p className="mt-1 text-[11px] text-gray-500">Permissions: {key.scopes.join(", ")} · Expires: {displayDate(key.expiresAt)}</p>
            <p className="mt-1 text-[11px] text-gray-400">Created: {displayDate(key.createdAt)} · Last used: {displayDate(key.lastUsedAt)}</p>
            {key.status === "active" && <button type="button" onClick={() => void revoke(key)} className="mt-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600">Revoke key</button>}
          </article>)}</div> : <p className="text-sm text-gray-500">{loading ? "Loading API keys..." : "No API keys created for this workspace."}</p>}
        </div>
        <div className="rounded-xl border bg-white p-4">
          <h3 className="font-semibold">Available API endpoints</h3>
          <p className="mt-1 text-xs text-gray-500">Version 1 · All requests use HTTPS and a workspace-scoped bearer key.</p>
          <div className="mt-3 space-y-3 text-sm">
            <div><p className="font-mono text-xs font-semibold text-green-700">GET /public/v1/contacts</p><p className="text-xs text-gray-500">Requires <code>contacts:read</code>. Optional query: <code>limit</code> (1–100).</p></div>
            <div><p className="font-mono text-xs font-semibold text-blue-700">POST /public/v1/contacts</p><p className="text-xs text-gray-500">Requires <code>contacts:write</code>. JSON body: name, phone, email, notes, source and tags.</p></div>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-950 p-3 text-xs text-gray-100"><code>{`curl -H "Authorization: Bearer YOUR_JOY_API_KEY" \\\n  YOUR_API_BASE_URL/public/v1/contacts?limit=50`}</code></pre>
          <p className="mt-2 text-[11px] text-gray-500">Workspace ID is derived from the API key, never accepted from the request. Keys cannot access another workspace. Rate limits and additional CRM/message scopes are being added before public launch.</p>
        </div>
      </div>
    </section>
  );
}
