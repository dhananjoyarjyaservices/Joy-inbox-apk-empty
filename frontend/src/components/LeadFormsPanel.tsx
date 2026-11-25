import { useCallback, useEffect, useState } from "react";
import { Copy, Plus, RefreshCw, Trash2, ExternalLink, FileText, Pencil } from "lucide-react";
import { deleteCrmLeadForm, listCrmLeadForms, listCrmLeadFormSubmissions, saveCrmLeadForm, type CrmLeadForm, type CrmLeadFormField, type CrmLeadFormSubmission } from "../services/crm";

type Props = { organizationId: string };

const defaultFields: CrmLeadFormField[] = [
  { key: "full_name", label: "Full name", type: "text", required: true, options: [] },
  { key: "email", label: "Email address", type: "email", required: true, options: [] },
  { key: "phone", label: "Phone number", type: "phone", required: false, options: [] },
  { key: "message", label: "How can we help?", type: "textarea", required: false, options: [] }
];

export default function LeadFormsPanel({ organizationId }: Props) {
  const [forms, setForms] = useState<CrmLeadForm[]>([]);
  const [name, setName] = useState("Website enquiry");
  const [description, setDescription] = useState("Tell us how we can help.");
  const [fields, setFields] = useState<CrmLeadFormField[]>(defaultFields);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedFormId, setSelectedFormId] = useState("");
  const [submissions, setSubmissions] = useState<CrmLeadFormSubmission[]>([]);
  const [responsesLoading, setResponsesLoading] = useState(false);
  const [editingFormId, setEditingFormId] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setForms(await listCrmLeadForms(organizationId)); }
    catch (e) { setError(e instanceof Error ? e.message : "Lead forms could not be loaded."); }
    finally { setLoading(false); }
  }, [organizationId]);
  useEffect(() => { void refresh(); }, [refresh]);

  function updateField(index: number, patch: Partial<CrmLeadFormField>) {
    setFields(current => current.map((field, i) => i === index ? { ...field, ...patch } : field));
  }
  async function createForm(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const saved = await saveCrmLeadForm(organizationId, {
        name, description, fields, submitButton: "Send enquiry",
        successMessage: "Thanks! Your enquiry has been received.",
        consentRequired: true, consentText: "I agree to be contacted about my enquiry.",
        createLead: true, enabled: true
      }, editingFormId || undefined);
      setForms(current => editingFormId ? current.map(item => item.id === saved.id ? saved : item) : [saved, ...current]);
      setNotice(editingFormId ? "Form updated." : "Form created. Copy its public link to share it.");
      setEditingFormId("");
      setName("Website enquiry");
      setDescription("Tell us how we can help.");
      setFields(defaultFields);
    } catch (e) { setError(e instanceof Error ? e.message : "Lead form could not be created."); }
    finally { setSaving(false); }
  }
  async function toggle(form: CrmLeadForm) {
    setSaving(true); setError("");
    try {
      const { id, ...data } = form;
      const saved = await saveCrmLeadForm(organizationId, { ...data, enabled: !form.enabled }, id);
      setForms(current => current.map(item => item.id === form.id ? saved : item));
    } catch (e) { setError(e instanceof Error ? e.message : "Form could not be updated."); }
    finally { setSaving(false); }
  }
  async function remove(form: CrmLeadForm) {
    if (!window.confirm(`Disable public form "${form.name}"? Existing submissions will be kept.`)) return;
    setSaving(true); setError("");
    try { await deleteCrmLeadForm(organizationId, form.id); setForms(current => current.map(item => item.id === form.id ? { ...item, enabled: false } : item)); }
    catch (e) { setError(e instanceof Error ? e.message : "Form could not be disabled."); }
    finally { setSaving(false); }
  }
  function editForm(form: CrmLeadForm) {
    setEditingFormId(form.id); setName(form.name); setDescription(form.description);
    setFields(form.fields.map(field => ({ ...field, options: [...field.options] })));
    setNotice(""); setError("");
  }
  async function viewResponses(form: CrmLeadForm) {
    setSelectedFormId(form.id); setResponsesLoading(true); setError("");
    try { setSubmissions(await listCrmLeadFormSubmissions(organizationId, form.id)); }
    catch (e) { setError(e instanceof Error ? e.message : "Form responses could not be loaded."); }
    finally { setResponsesLoading(false); }
  }
  async function copyLink(form: CrmLeadForm) {
    const link = `${window.location.origin}${import.meta.env.BASE_URL}form/${form.id}`;
    try { await navigator.clipboard.writeText(link); setNotice("Public form link copied."); }
    catch { setNotice(link); }
  }

  return <section className="mb-5 rounded-xl border bg-white p-4">
    <div className="mb-3 flex items-center justify-between gap-2">
      <div><h3 className="text-sm font-semibold">Lead capture forms</h3><p className="text-[11px] text-gray-500">Create shareable forms. Every valid submission can create a CRM lead.</p></div>
      <button type="button" onClick={() => void refresh()} disabled={loading || saving} className="rounded-lg border p-2 text-[#075e54]" aria-label="Refresh forms"><RefreshCw size={14}/></button>
    </div>
    {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    {notice && <p role="status" className="mb-3 break-all rounded-lg bg-emerald-50 p-2 text-xs text-emerald-800">{notice}</p>}
    <div className="mb-4 grid gap-2">
      {loading ? <p className="text-xs text-gray-400">Loading forms...</p> : forms.length ? forms.map(form => <article key={form.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
        <div className="min-w-0"><p className="truncate text-sm font-medium">{form.name}</p><p className="text-[10px] text-gray-500">{form.fields.length} fields · {form.createLead ? "Creates CRM leads" : "Stores submissions only"} · {form.enabled ? "Published" : "Disabled"}</p></div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void copyLink(form)} disabled={saving || !form.enabled} className="flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] text-[#075e54]" title="Copy public form link"><Copy size={12}/> Copy link</button>
          <button type="button" onClick={() => editForm(form)} disabled={saving} className="rounded-md border p-1.5 text-gray-500" title="Edit form"><Pencil size={13}/></button>
          <button type="button" onClick={() => void viewResponses(form)} disabled={saving || responsesLoading} className="flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] text-gray-600" title="View submissions"><FileText size={12}/> Responses</button>
          <a href={`${import.meta.env.BASE_URL}form/${form.id}`} target="_blank" rel="noreferrer" className="rounded-md border p-1.5 text-gray-500" aria-label="Preview form"><ExternalLink size={13}/></a>
          <button type="button" onClick={() => void toggle(form)} disabled={saving} className="rounded-md border px-2 py-1.5 text-[11px]">{form.enabled ? "Disable" : "Publish"}</button>
          <button type="button" onClick={() => void remove(form)} disabled={saving || !form.enabled} className="rounded-md border p-1.5 text-red-600" aria-label="Disable form"><Trash2 size={13}/></button>
        </div>
      </article>) : <p className="rounded-lg border border-dashed p-3 text-center text-xs text-gray-400">No lead forms yet.</p>}
    </div>
    {selectedFormId && <section className="mb-4 rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between"><p className="text-xs font-semibold">Recent form responses</p><button type="button" onClick={() => { setSelectedFormId(""); setSubmissions([]); }} className="text-xs text-gray-500">Close</button></div>
      {responsesLoading ? <p className="text-xs text-gray-400">Loading responses...</p> : submissions.length ? <div className="max-h-72 space-y-2 overflow-y-auto">{submissions.map(item => <article key={item.id} className="rounded-md bg-gray-50 p-2"><div className="mb-1 flex justify-between gap-2"><span className="text-[10px] text-gray-500">{new Date(typeof item.submittedAt === "string" ? item.submittedAt : (item.submittedAt as { _seconds?: number })?._seconds ? (item.submittedAt as { _seconds: number })._seconds * 1000 : Date.now()).toLocaleString()}</span><span className="text-[10px] text-emerald-700">{item.status}</span></div><dl className="grid gap-1 sm:grid-cols-2">{Object.entries(item.values || {}).map(([key, value]) => <div key={key} className="text-xs"><dt className="inline text-gray-500">{key}: </dt><dd className="inline break-words text-gray-800">{value}</dd></div>)}</dl>{item.leadId && <p className="mt-1 text-[10px] text-gray-500">CRM lead: {item.leadId}</p>}</article>)}</div> : <p className="text-xs text-gray-400">No submissions yet.</p>}
    </section>}
    <form onSubmit={event => void createForm(event)} className="rounded-lg bg-gray-50 p-3">
      <p className="mb-2 text-xs font-semibold">{editingFormId ? "Edit form" : "Create a form"}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-gray-600">Form name<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required className="mt-1 w-full rounded-md border bg-white p-2 text-sm"/></label>
        <label className="text-[11px] text-gray-600">Description<input value={description} onChange={e => setDescription(e.target.value)} maxLength={300} className="mt-1 w-full rounded-md border bg-white p-2 text-sm"/></label>
      </div>
      <div className="mt-3 space-y-2">
        {fields.map((field, index) => <div key={field.key} className="grid gap-2 rounded-md border bg-white p-2 sm:grid-cols-[1fr_130px_auto]">
          <label className="text-[10px] text-gray-500">Field label<input value={field.label} onChange={e => updateField(index, { label: e.target.value })} maxLength={80} required className="mt-1 w-full rounded border p-1.5 text-xs"/></label>
          <label className="text-[10px] text-gray-500">Field type<select value={field.type} onChange={e => updateField(index, { type: e.target.value as CrmLeadFormField["type"], options: [] })} className="mt-1 w-full rounded border bg-white p-1.5 text-xs"><option value="text">Text</option><option value="email">Email</option><option value="phone">Phone</option><option value="textarea">Long text</option><option value="select">Select</option></select></label>
          <div className="flex items-center justify-between gap-2"><label className="flex items-center gap-1 text-[10px] text-gray-600"><input type="checkbox" checked={field.required} onChange={e => updateField(index, { required: e.target.checked })}/> Required</label><button type="button" disabled={fields.length <= 1} onClick={() => setFields(current => current.filter((_, i) => i !== index))} className="text-xs text-red-600 disabled:opacity-30">Remove</button></div>
          {field.type === "select" && <label className="text-[10px] text-gray-500 sm:col-span-3">Options (comma separated)<input value={field.options.join(", ")} onChange={e => updateField(index, { options: e.target.value.split(",").map(v => v.trim()).filter(Boolean) })} className="mt-1 w-full rounded border p-1.5 text-xs"/></label>}
        </div>)}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button type="button" disabled={fields.length >= 10} onClick={() => setFields(current => [...current, { key: `field_${Date.now()}`, label: "New field", type: "text", required: false, options: [] }])} className="flex items-center gap-1 rounded-md border bg-white px-2 py-1.5 text-xs text-[#075e54] disabled:opacity-40"><Plus size={13}/> Add field</button>
        <button type="submit" disabled={saving || !name.trim() || fields.length < 1} className="rounded-md bg-[#075e54] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? "Saving..." : editingFormId ? "Save changes" : "Create form"}</button>
        {editingFormId && <button type="button" onClick={() => { setEditingFormId(""); setName("Website enquiry"); setDescription("Tell us how we can help."); setFields(defaultFields); }} className="rounded-md border bg-white px-3 py-2 text-xs">Cancel edit</button>}
      </div>
      <p className="mt-2 text-[10px] text-gray-500">Consent is required by default. Form submissions are rate-limited and stored in your workspace; CRM lead creation is enabled.</p>
    </form>
  </section>;
}
