import { useEffect, useState, type FormEvent } from "react";
import {
  createOrganizationApiKey,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  listOrganizationWebhooks,
  createOrganizationWebhook,
  revokeOrganizationWebhook,
  rotateOrganizationWebhookSecret,
  listOrganizationWebhookDeliveries,
  replayOrganizationWebhookDelivery,
  getOrganizationApiUsage,
  type OrganizationApiUsage,
  type OrganizationApiKey,
  type OrganizationWebhook,
  type OrganizationWebhookDelivery
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
  const [apiUsage, setApiUsage] = useState<OrganizationApiUsage | null>(null);
  const [usageDays, setUsageDays] = useState(30);
  const [webhooks, setWebhooks] = useState<OrganizationWebhook[]>([]);
  const [deliveries, setDeliveries] = useState<OrganizationWebhookDelivery[]>([]);
  const [replayingDeliveryId, setReplayingDeliveryId] = useState("");
  const [webhookName, setWebhookName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>(["contact.upserted"]);
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [name, setName] = useState("");
  const [readContacts, setReadContacts] = useState(true);
  const [writeContacts, setWriteContacts] = useState(false);
  const [readLeads, setReadLeads] = useState(false);
  const [writeLeads, setWriteLeads] = useState(false);
  const [writeMessages, setWriteMessages] = useState(false);
  const [readTemplates, setReadTemplates] = useState(false);
  const [readCampaigns, setReadCampaigns] = useState(false);
  const [writeCampaigns, setWriteCampaigns] = useState(false);
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
    try {
      const [apiKeys, subscriptions, deliveryHistory, usage] = await Promise.all([
        listOrganizationApiKeys(organizationId),
        listOrganizationWebhooks(organizationId),
        listOrganizationWebhookDeliveries(organizationId),
        getOrganizationApiUsage(organizationId, usageDays)
      ]);
      setKeys(apiKeys);
      setWebhooks(subscriptions);
      setDeliveries(deliveryHistory);
      setApiUsage(usage);
    } catch (e) { setError(e instanceof Error ? e.message : "Developer settings could not be loaded."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [organizationId, usageDays]);

  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true); setError(""); setNotice(""); setNewKey(""); setCopied(false);
    try {
      const result = await createOrganizationApiKey({
        organizationId,
        name,
        scopes: [ ...(readContacts ? ["contacts:read"] : []), ...(writeContacts ? ["contacts:write"] : []), ...(readLeads ? ["leads:read"] : []), ...(writeLeads ? ["leads:write"] : []), ...(writeMessages ? ["messages:write"] : []), ...(readTemplates ? ["templates:read"] : []), ...(readCampaigns ? ["campaigns:read"] : []), ...(writeCampaigns ? ["campaigns:write"] : []) ],
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

  async function createWebhook(event: FormEvent) {
    event.preventDefault();
    if (!organizationId) return;
    setWebhookSaving(true); setError(""); setNotice(""); setWebhookSecret(""); setWebhookCopied(false);
    try {
      const result = await createOrganizationWebhook({
        organizationId,
        name: webhookName,
        url: webhookUrl,
        events: webhookEvents
      });
      setWebhookSecret(result.secret);
      setWebhookName("");
      setWebhookUrl("");
      setNotice("Webhook created. Copy its signing secret now; it will not be shown again.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Webhook could not be created."); }
    finally { setWebhookSaving(false); }
  }

  async function rotateWebhookSecret(webhook: OrganizationWebhook) {
    if (!confirm(`Rotate the signing secret for “${webhook.name}”? The old secret will stop working immediately.`)) return;
    setWebhookSaving(true); setError(""); setNotice(""); setWebhookSecret(""); setWebhookCopied(false);
    try {
      const result = await rotateOrganizationWebhookSecret(organizationId, webhook.id);
      setWebhookSecret(result.secret);
      setNotice("Webhook signing secret rotated. Copy the new secret and update your receiving endpoint now.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Webhook secret could not be rotated."); }
    finally { setWebhookSaving(false); }
  }

  async function replayDelivery(delivery: OrganizationWebhookDelivery) {
    if (!confirm(`Replay failed ${delivery.event} webhook delivery?`)) return;
    setReplayingDeliveryId(delivery.id); setError(""); setNotice("");
    try {
      await replayOrganizationWebhookDelivery(organizationId, delivery.id);
      setNotice("Webhook delivery queued for replay.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Webhook delivery could not be replayed."); }
    finally { setReplayingDeliveryId(""); }
  }

  async function revokeWebhook(webhook: OrganizationWebhook) {
    if (!confirm(`Disable the webhook “${webhook.name}”? No further events will be delivered.`)) return;
    setError(""); setNotice("");
    try {
      await revokeOrganizationWebhook(organizationId, webhook.id);
      setWebhooks(current => current.map(item => item.id === webhook.id ? { ...item, status: "revoked" } : item));
      setNotice("Webhook disabled.");
    } catch (e) { setError(e instanceof Error ? e.message : "Webhook could not be disabled."); }
  }

  async function copyWebhookSecret() {
    try {
      await navigator.clipboard.writeText(webhookSecret);
      setWebhookCopied(true);
    } catch { setError("Clipboard access is unavailable. Select and copy the signing secret manually."); }
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
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={readLeads} onChange={event => setReadLeads(event.target.checked)}/> Read CRM leads</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={writeLeads} onChange={event => setWriteLeads(event.target.checked)}/> Create/update/delete CRM leads</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={writeMessages} onChange={event => setWriteMessages(event.target.checked)}/> Send WhatsApp text messages</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={readTemplates} onChange={event => setReadTemplates(event.target.checked)}/> Read approved WhatsApp templates</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={readCampaigns} onChange={event => setReadCampaigns(event.target.checked)}/> Read campaign reports (no recipient details)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={writeCampaigns} onChange={event => setWriteCampaigns(event.target.checked)}/> Create campaign drafts only (cannot send)</label>
          </div>
          <label className="block text-sm text-gray-600">Key expires after
            <select value={expiryDays} onChange={event => setExpiryDays(Number(event.target.value))} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm">
              <option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>365 days</option>
            </select>
          </label>
          <button disabled={saving || !organizationId || (!readContacts && !writeContacts && !readLeads && !writeLeads && !writeMessages && !readTemplates && !readCampaigns && !writeCampaigns)} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Creating..." : "Create API key"}</button>
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
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="font-semibold">API usage analytics</h3><p className="mt-1 text-xs text-gray-500">Daily requests and rate-limited attempts across this workspace's API keys.</p></div>
            <select aria-label="API usage period" value={usageDays} onChange={event => setUsageDays(Number(event.target.value))} className="rounded-lg border bg-white px-3 py-2 text-xs">
              <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-gray-50 p-3"><p className="text-xs text-gray-500">API requests</p><p className="mt-1 text-2xl font-semibold tabular-nums">{apiUsage?.totals.requests.toLocaleString() ?? "—"}</p></div>
            <div className="rounded-lg bg-gray-50 p-3"><p className="text-xs text-gray-500">Rate limited</p><p className="mt-1 text-2xl font-semibold tabular-nums">{apiUsage?.totals.rateLimited.toLocaleString() ?? "—"}</p></div>
          </div>
          {apiUsage?.daily.length ? <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">{apiUsage.daily.map(item => <div key={item.keyId + item.date} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-xs last:border-0"><div><p className="font-medium">{item.date.slice(0, 4)}-{item.date.slice(4, 6)}-{item.date.slice(6, 8)}</p><p className="font-mono text-[10px] text-gray-400">Key {item.keyId.slice(0, 12)}…</p></div><div className="text-right"><p className="font-semibold tabular-nums">{item.requests.toLocaleString()} requests</p><p className="text-gray-500 tabular-nums">{item.rateLimited.toLocaleString()} rate limited</p></div></div>)}</div> : <p className="mt-3 text-xs text-gray-500">{loading ? "Loading usage..." : "No API usage recorded for this period yet."}</p>}
          <button type="button" onClick={() => void refresh()} disabled={loading} className="mt-3 rounded-lg border px-3 py-1.5 text-xs text-[#075e54]">{loading ? "Refreshing..." : "Refresh usage"}</button>
        </div>
        <div className="rounded-xl border bg-white p-4 space-y-3">
          <div><h3 className="font-semibold">Outbound webhooks</h3><p className="mt-1 text-xs text-gray-500">Send signed contact, message and CRM lead events to your HTTPS endpoint. Delivery is queued, retried and can be replayed after terminal failure.</p></div>
          {webhookSecret && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3"><p className="text-sm font-semibold text-amber-900">Copy the signing secret now</p><p className="mt-1 text-xs text-amber-800">Store this secret securely. Joy Inbox will not show it again.</p><div className="mt-2 flex flex-wrap gap-2"><input readOnly value={webhookSecret} className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white p-2 font-mono text-xs"/><button type="button" onClick={() => void copyWebhookSecret()} className="rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white">{webhookCopied ? "Copied" : "Copy secret"}</button></div></div>}
          <form onSubmit={createWebhook} className="grid gap-2 sm:grid-cols-2">
            <input required minLength={2} maxLength={80} value={webhookName} onChange={event => setWebhookName(event.target.value)} placeholder="Webhook name" className="rounded-lg border p-2 text-sm"/>
            <input required type="url" value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} placeholder="https://your-domain.com/webhooks/joy" className="rounded-lg border p-2 text-sm"/>
            <div className="sm:col-span-2"><p className="mb-2 text-xs font-medium text-gray-600">Events</p><div className="grid gap-2 sm:grid-cols-2">{[["contact.upserted", "Contact created or updated"], ["lead.created", "CRM lead created"], ["lead.updated", "CRM lead updated"], ["lead.deleted", "CRM lead deleted"], ["message.received", "Incoming WhatsApp message"], ["message.sent", "Outgoing message accepted"], ["message.delivered", "Message delivered"], ["message.read", "Message read"], ["message.failed", "Message failed"]].map(([eventName, label]) => <label key={eventName} className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={webhookEvents.includes(eventName)} onChange={event => setWebhookEvents(current => event.target.checked ? [...current, eventName] : current.filter(item => item !== eventName))}/><span><code>{eventName}</code> · {label}</span></label>)}</div></div>
            <button disabled={webhookSaving || !organizationId || !webhookEvents.length} className="justify-self-start rounded-lg bg-[#075e54] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{webhookSaving ? "Creating..." : "Create webhook"}</button>
          </form>
          <div className="space-y-2">{webhooks.length ? webhooks.map(webhook => <article key={webhook.id} className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{webhook.name}</strong><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${webhook.status === "active" ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>{webhook.status}</span></div><p className="mt-1 break-all text-xs text-gray-500">{webhook.url}</p><p className="mt-1 text-[11px] text-gray-500">Events: {webhook.events.join(", ")} · Last delivery: {displayDate(webhook.lastDeliveryAt)}</p>{webhook.status === "active" && <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void rotateWebhookSecret(webhook)} disabled={webhookSaving} className="rounded-lg border px-3 py-1.5 text-xs text-[#075e54] disabled:opacity-50">Rotate secret</button><button type="button" onClick={() => void revokeWebhook(webhook)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600">Disable webhook</button></div>}</article>) : <p className="text-xs text-gray-500">No webhook subscriptions created.</p>}</div>
          <div className="mt-4 border-t pt-4">
            <div className="mb-2 flex items-center justify-between gap-2"><h4 className="text-sm font-semibold">Delivery history</h4><button type="button" onClick={() => void refresh()} disabled={loading} className="text-xs font-medium text-[#075e54]">Refresh</button></div>
            {deliveries.length ? <div className="max-h-80 space-y-2 overflow-y-auto">{deliveries.map(delivery => <article key={delivery.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="font-mono text-xs">{delivery.event}</strong><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${delivery.status === "delivered" ? "bg-green-50 text-green-700" : delivery.status === "failed" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{delivery.status}</span></div>
              <p className="mt-1 text-[10px] text-gray-500">Attempts: {delivery.attempts} · HTTP: {delivery.responseStatus ?? "—"} · Created: {displayDate(delivery.createdAt)}</p>
              {delivery.lastError && <p className="mt-1 break-words text-xs text-red-600">{delivery.lastError}</p>}
              {delivery.status === "failed" && <button type="button" onClick={() => void replayDelivery(delivery)} disabled={Boolean(replayingDeliveryId)} className="mt-2 rounded-md border border-[#075e54] px-3 py-1.5 text-xs font-semibold text-[#075e54] disabled:opacity-50">{replayingDeliveryId === delivery.id ? "Queueing..." : "Replay delivery"}</button>}
            </article>)}</div> : <p className="text-xs text-gray-500">No webhook deliveries recorded yet.</p>}
          </div>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <h3 className="font-semibold">Available API endpoints</h3>
          <p className="mt-1 text-xs text-gray-500">Version 1 · All requests use HTTPS and a workspace-scoped bearer key.</p>
          <div className="mt-3 space-y-3 text-sm">
            <div><p className="font-mono text-xs font-semibold text-green-700">GET /public/v1/contacts</p><p className="text-xs text-gray-500">Requires <code>contacts:read</code>. Optional query: <code>limit</code> (1–100).</p></div>
            <div><p className="font-mono text-xs font-semibold text-blue-700">POST /public/v1/contacts</p><p className="text-xs text-gray-500">Requires <code>contacts:write</code>. JSON body: name, phone, email, notes, source and tags.</p></div>
            <div><p className="font-mono text-xs font-semibold text-blue-700">POST /public/v1/messages</p><p className="text-xs text-gray-500">Requires <code>messages:write</code> and an <code>Idempotency-Key</code>. Sends WhatsApp text to a connected number.</p></div>
            <div><p className="font-mono text-xs font-semibold text-green-700">GET /public/v1/templates</p><p className="text-xs text-gray-500">Requires <code>templates:read</code>. Supply connected <code>phoneNumberId</code> and <code>wabaId</code>.</p></div>
            <div><p className="font-mono text-xs font-semibold text-green-700">GET /public/v1/campaigns</p><p className="text-xs text-gray-500">Requires <code>campaigns:read</code>. Returns paginated campaign delivery summaries, never recipient phone numbers.</p></div>
            <div><p className="font-mono text-xs font-semibold text-green-700">GET /public/v1/leads</p><p className="text-xs text-gray-500">Requires <code>leads:read</code>. Optional query: <code>limit</code> (1–100).</p></div>
            <div><p className="font-mono text-xs font-semibold text-blue-700">POST /public/v1/leads</p><p className="text-xs text-gray-500">Requires <code>leads:write</code>. Creates a lead after validating its stage, contact, owner and custom fields.</p></div>
            <div><p className="font-mono text-xs font-semibold text-amber-700">PUT /public/v1/leads · DELETE /public/v1/leads</p><p className="text-xs text-gray-500">Requires <code>leads:write</code>. Supply <code>resourceId</code>; PUT also requires a complete <code>data</code> object.</p></div>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-950 p-3 text-xs text-gray-100"><code>{`curl -H "Authorization: Bearer YOUR_JOY_API_KEY" \\\n  YOUR_API_BASE_URL/public/v1/contacts?limit=50`}</code></pre>
          <p className="mt-2 text-[11px] text-gray-500">Workspace ID is derived from the API key, never accepted from the request. Keys cannot access another workspace. Each key is limited to 60 requests per minute. Message sending requires an idempotency key; contacts, leads and campaign reports support cursor pagination. Campaign report access does not expose recipient personal data.</p>
        </div>
      </div>
    </section>
  );
}
