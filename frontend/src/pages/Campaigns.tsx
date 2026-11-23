import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Megaphone, RefreshCw, Users } from "lucide-react";
import {
  createOrganisationCampaign,
  listOrganisationCampaigns,
  previewOrganisationCampaign,\n  updateOrganisationContactConsent,
  type OrganisationCampaign,
} from "../services/organisations";

export default function Campaigns() {
  const { orgId = "" } = useParams();
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<OrganisationCampaign[]>([]);
  const [title, setTitle] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [parameters, setParameters] = useState("");
  const [tags, setTags] = useState("");\n  const [consentPhone, setConsentPhone] = useState("");\n  const [consentSource, setConsentSource] = useState("");\n  const [consentEvidence, setConsentEvidence] = useState("");\n  const [consentStatus, setConsentStatus] = useState<"opted_in" | "opted_out">("opted_in");
  const [preview, setPreview] = useState<Record<string, { eligibleCount: number; excludedCount: number; message: string }> >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setError("");
    setCampaigns(await listOrganisationCampaigns(orgId));
  }

  useEffect(() => { refresh().catch((e) => setError(e.message || "Campaigns could not be loaded.")); }, [orgId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await createOrganisationCampaign(orgId, {
        title, templateName, language,
        bodyParameters: parameters ? parameters.split("|").map((v) => v.trim()) : [],
        tags: tags.split(",").map((v) => v.trim()).filter(Boolean),
      });
      setTitle(""); setTemplateName(""); setParameters(""); setTags("");
      await refresh();
      setNotice("Draft campaign created. Preview the audience before any future sending.");
    } catch (e) { setError(e instanceof Error ? e.message : "Campaign could not be created."); }
    finally { setBusy(false); }
  }


  async function saveConsent(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await updateOrganisationContactConsent(orgId, consentPhone, {
        status: consentStatus, source: consentSource, evidence: consentEvidence,
      });
      setNotice(consentStatus === "opted_in"
        ? "Consent record saved. This contact may appear in eligible campaign previews."
        : "Opt-out recorded. This contact will be excluded from campaign previews.");
      setConsentPhone(""); setConsentSource(""); setConsentEvidence("");
    } catch (e) { setError(e instanceof Error ? e.message : "Consent could not be saved."); }
    finally { setBusy(false); }
  }

  async function runPreview(id: string) {
    setBusy(true); setError("");
    try {
      const result = await previewOrganisationCampaign(orgId, id);
      setPreview((old) => ({ ...old, [id]: result }));
    } catch (e) { setError(e instanceof Error ? e.message : "Audience preview failed."); }
    finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen bg-[#f4f7f6] px-4 py-6 text-gray-900">
      <div className="mx-auto max-w-5xl">
        <button onClick={() => navigate(`/org/${orgId}/inbox`)} className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-[#075e54]"><ArrowLeft size={16}/> Back to inbox</button>
        <header className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-[#dff2eb] p-3 text-[#075e54]"><Megaphone size={24}/></div>
          <div><h1 className="text-2xl font-bold">Broadcast campaigns</h1><p className="text-sm text-gray-500">Create drafts and preview opted-in contacts.</p></div>
        </header>
        {error && <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {notice && <p className="mb-4 rounded-xl bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
        <section className="mb-6 rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="mb-1 font-semibold">Create campaign draft</h2>
          <p className="mb-4 text-xs leading-5 text-gray-500">Use a template already approved in WhatsApp Manager. Contacts are included only when explicit WhatsApp opt-in is recorded.</p>
          <form onSubmit={create} className="grid gap-3 md:grid-cols-2">
            <input required maxLength={100} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Campaign name" className="h-11 rounded-xl border border-gray-200 px-3 text-sm"/>
            <input required value={templateName} onChange={e=>setTemplateName(e.target.value)} placeholder="Approved template name" className="h-11 rounded-xl border border-gray-200 px-3 text-sm"/>
            <input required value={language} onChange={e=>setLanguage(e.target.value)} placeholder="Language code (en_US)" className="h-11 rounded-xl border border-gray-200 px-3 text-sm"/>
            <input value={parameters} onChange={e=>setParameters(e.target.value)} placeholder="Template body values separated by |" className="h-11 rounded-xl border border-gray-200 px-3 text-sm"/>
            <input value={tags} onChange={e=>setTags(e.target.value)} placeholder="Required contact tags (comma separated)" className="h-11 rounded-xl border border-gray-200 px-3 text-sm md:col-span-2"/>
            <button disabled={busy} className="rounded-xl bg-[#075e54] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 md:col-span-2">{busy ? "Please wait..." : "Save campaign draft"}</button>
          </form>
        </section>
        <section className="mb-6 rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="mb-1 font-semibold">WhatsApp consent records</h2>
          <p className="mb-4 text-xs leading-5 text-gray-500">Record opt-in only when you have real customer permission. Enter the source and evidence reference. Customer STOP / UNSUBSCRIBE messages are recorded as opt-outs automatically.</p>
          <form onSubmit={saveConsent} className="grid gap-3 md:grid-cols-2">
            <input required value={consentPhone} onChange={e=>setConsentPhone(e.target.value)} placeholder="Customer phone with country code" className="h-11 rounded-xl border border-gray-200 px-3 text-sm"/>
            <select value={consentStatus} onChange={e=>setConsentStatus(e.target.value as "opted_in" | "opted_out")} className="h-11 rounded-xl border border-gray-200 px-3 text-sm"><option value="opted_in">Record opt-in</option><option value="opted_out">Record opt-out</option></select>
            <input value={consentSource} onChange={e=>setConsentSource(e.target.value)} placeholder="Source (website form, paper form, etc.)" className="h-11 rounded-xl border border-gray-200 px-3 text-sm md:col-span-2"/>
            {consentStatus === "opted_in" && <textarea required value={consentEvidence} onChange={e=>setConsentEvidence(e.target.value)} maxLength={500} rows={2} placeholder="Evidence reference / description of customer's consent" className="rounded-xl border border-gray-200 p-3 text-sm md:col-span-2"/>}
            <button disabled={busy} className="rounded-xl bg-[#075e54] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 md:col-span-2">{busy ? "Please wait..." : "Save consent record"}</button>
          </form>
        </section>
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Saved campaigns</h2><button onClick={()=>refresh().catch(e=>setError(e.message))} className="inline-flex items-center gap-2 text-sm text-[#075e54]"><RefreshCw size={15}/> Refresh</button></div>
          {campaigns.length === 0 ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">No campaigns yet. Create your first draft above.</p> : <div className="space-y-3">{campaigns.map(c => <article key={c.id} className="rounded-xl border border-gray-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{c.title}</h3><p className="mt-1 text-xs text-gray-500">{c.templateName} · {c.language} · {c.status}</p><p className="mt-1 text-xs text-gray-500">Required tags: {c.audience?.tags?.join(", ") || "None"}</p></div><button disabled={busy} onClick={()=>runPreview(c.id)} className="rounded-lg border border-[#075e54] px-3 py-2 text-xs font-semibold text-[#075e54] disabled:opacity-50"><Users size={14} className="mr-1 inline"/> Preview audience</button></div>
            {preview[c.id] && <div className="mt-3 rounded-lg bg-[#f0f7f4] p-3 text-sm"><p><strong>{preview[c.id].eligibleCount}</strong> eligible · <strong>{preview[c.id].excludedCount}</strong> excluded</p><p className="mt-1 text-xs text-gray-600">{preview[c.id].message}</p><p className="mt-1 text-xs font-semibold text-amber-700">Sending is disabled. This preview did not send messages.</p></div>}
          </article>)}</div>}
        </section>
      </div>
    </main>
  );
}
