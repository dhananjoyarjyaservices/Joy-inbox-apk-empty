import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus, RefreshCw, BriefcaseBusiness, Trash2, Pencil, Upload } from "lucide-react";
import {
  listCrmFields, listCrmLeads, listCrmStages, saveCrmField, saveCrmLead, saveCrmStage, deleteCrmLead, importCrmLeads, getCrmSalesReport,
  type CrmSalesReport,
  type CrmField, type CrmLead, type CrmStage
} from "../services/crm";

import type { TenantContact } from "../services/tenantResources";
import type { OrganizationMember } from "../services/organizationMembers";

type Props = { organizationId: string; contacts: TenantContact[]; members: OrganizationMember[]; canManageSchema: boolean };

export default function CrmPanel({ organizationId, contacts, members, canManageSchema }: Props) {
  const [fields, setFields] = useState<CrmField[]>([]);
  const [stages, setStages] = useState<CrmStage[]>([]);
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [salesReport, setSalesReport] = useState<CrmSalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [source, setSource] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [contactId, setContactId] = useState("");
  const [ownerUid, setOwnerUid] = useState("");
  const [stageId, setStageId] = useState("new");
  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldType, setFieldType] = useState<CrmField["type"]>("text");
  const [fieldOptions, setFieldOptions] = useState("");
  const [stageName, setStageName] = useState("");
  const [customValues, setCustomValues] = useState<Record<string, string | number | boolean>>({});
  const [editingLeadId, setEditingLeadId] = useState("");
  const [followUpFilter, setFollowUpFilter] = useState<"all" | "overdue" | "today">("all");
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [nextFields, nextStages, nextLeads, nextReport] = await Promise.all([
        listCrmFields(organizationId), listCrmStages(organizationId), listCrmLeads(organizationId), getCrmSalesReport(organizationId)
      ]);
      setFields(nextFields); setStages(nextStages); setLeads(nextLeads); setSalesReport(nextReport);
      setCustomValues(current => {
        const next = { ...current };
        nextFields.filter(field => field.active && field.type === "boolean").forEach(field => { if (next[field.key] === undefined) next[field.key] = false; });
        return next;
      });
      setStageId(current => nextStages.some(stage => stage.id === current && stage.active) ? current : nextStages.find(stage => stage.isDefault && stage.active)?.id || nextStages.find(stage => stage.active)?.id || "");
    } catch (e) { setError(e instanceof Error ? e.message : "CRM data could not be loaded."); }
    finally { setLoading(false); }
  }, [organizationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const activeStages = useMemo(() => stages.filter(stage => stage.active).sort((a, b) => a.position - b.position), [stages]);
  const followUpCounts = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
    return {
      overdue: leads.filter(lead => lead.nextFollowUpAt && new Date(lead.nextFollowUpAt).getTime() < now.getTime()).length,
      today: leads.filter(lead => lead.nextFollowUpAt && new Date(lead.nextFollowUpAt).getTime() >= now.getTime() && new Date(lead.nextFollowUpAt).getTime() < startOfTomorrow && new Date(lead.nextFollowUpAt).getTime() >= startOfToday).length
    };
  }, [leads]);
  const visibleLeads = useMemo(() => {
    if (followUpFilter === "all") return leads;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
    return leads.filter(lead => {
      if (!lead.nextFollowUpAt) return false;
      const due = new Date(lead.nextFollowUpAt).getTime();
      return followUpFilter === "overdue" ? due < now.getTime() : due >= now.getTime() && due >= startOfToday && due < startOfTomorrow;
    });
  }, [followUpFilter, leads]);
  const grouped = useMemo(() => activeStages.map(stage => ({ stage, leads: visibleLeads.filter(lead => lead.stageId === stage.id) })), [activeStages, visibleLeads]);

  async function importCsvFile(file?: File) {
    if (!file) return;
    setImporting(true); setError(""); setImportSummary("");
    try {
      const sourceText = (await file.text()).replace(/^\\uFEFF/, "");
      const rows: string[][] = [];
      let row: string[] = [], cell = "", quoted = false;
      for (let index = 0; index < sourceText.length; index += 1) {
        const char = sourceText[index];
        if (char === '"' && quoted && sourceText[index + 1] === '"') { cell += '"'; index += 1; }
        else if (char === '"') quoted = !quoted;
        else if (char === "," && !quoted) { row.push(cell); cell = ""; }
        else if ((char === "\\n" || char === "\\r") && !quoted) {
          if (char === "\\r" && sourceText[index + 1] === "\\n") index += 1;
          row.push(cell); cell = "";
          if (row.some(value => value.trim())) rows.push(row);
          row = [];
        } else cell += char;
      }
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      if (quoted) throw new Error("CSV has an unclosed quoted field.");
      if (rows.length < 2) throw new Error("CSV must contain a header and at least one lead row.");
      const headers = rows[0].map(value => value.trim().toLowerCase().replace(/[\\s-]+/g, "_"));
      if (!headers.includes("title")) throw new Error('CSV needs a "title" column.');
      const importedRows = rows.slice(1).map(values => {
        const record: Record<string, string> = {};
        headers.forEach((header, index) => { record[header] = values[index] || ""; });
        return {
          title: record.title || "",
          stageId: record.stage_id || "new",
          contactId: record.contact_id || "",
          ownerUid: record.owner_uid || "",
          source: record.source || "",
          value: record.value ? Number(record.value) : null,
          currency: record.currency || "INR",
          nextFollowUpAt: record.next_follow_up_at || null,
          notes: record.notes || "",
          customFields: {}
        };
      });
      const result = await importCrmLeads(organizationId, importedRows);
      setImportSummary(`Imported ${result.imported} leads · ${result.failed} rows need attention${result.errors.length ? ` · First error (row ${result.errors[0].row}): ${result.errors[0].error}` : ""}`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "CSV import could not be completed."); }
    finally { setImporting(false); }
  }

  async function submitLead(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !stageId) return;
    setSaving(true); setError("");
    try {
      await saveCrmLead(organizationId, {
        title: title.trim(), contactId, stageId, ownerUid, source: source.trim(),
        value: value.trim() ? Number(value) : null, currency: "INR", notes: "", nextFollowUpAt: followUpAt ? new Date(followUpAt).toISOString() : null, customFields: customValues
      }, editingLeadId || undefined);
      setTitle(""); setValue(""); setSource(""); setContactId(""); setOwnerUid(""); setFollowUpAt(""); setCustomValues({}); setEditingLeadId("");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Lead could not be saved."); }
    finally { setSaving(false); }
  }

  function startEditLead(lead: CrmLead) {
    setEditingLeadId(lead.id);
    setTitle(lead.title);
    setValue(lead.value === null ? "" : String(lead.value));
    setSource(lead.source || "");
    setContactId(lead.contactId || "");
    setOwnerUid(lead.ownerUid || "");
    setFollowUpAt(lead.nextFollowUpAt ? (() => { const date = new Date(lead.nextFollowUpAt as string); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); })() : "");
    setStageId(lead.stageId);
    setCustomValues(lead.customFields || {});
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetLeadForm() {
    setEditingLeadId(""); setTitle(""); setValue(""); setSource(""); setContactId(""); setOwnerUid(""); setFollowUpAt(""); setCustomValues({});
  }

  async function moveLead(lead: CrmLead, nextStageId: string) {
    const nextStage = activeStages.find(stage => stage.id === nextStageId);
    if (!nextStage) return;
    setSaving(true); setError("");
    try {
      await saveCrmLead(organizationId, {
        title: lead.title, contactId: lead.contactId || "", stageId: nextStageId, ownerUid: lead.ownerUid || "",
        source: lead.source || "", value: lead.value, currency: lead.currency || "INR", notes: lead.notes || "",
        nextFollowUpAt: lead.nextFollowUpAt || null, customFields: lead.customFields || {}
      }, lead.id);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Lead stage could not be updated."); }
    finally { setSaving(false); }
  }

  async function removeLead(lead: CrmLead) {
    if (!window.confirm(`Delete lead "${lead.title}"?`)) return;
    setSaving(true); setError("");
    try { await deleteCrmLead(organizationId, lead.id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Lead could not be deleted."); }
    finally { setSaving(false); }
  }

  async function addField(event: FormEvent) {
    event.preventDefault();
    const label = fieldLabel.trim();
    if (!label) return;
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    setSaving(true); setError("");
    try {
      await saveCrmField(organizationId, {
        key, label, type: fieldType, options: fieldType === "select" ? fieldOptions.split(",").map(item => item.trim()).filter(Boolean) : [],
        required: false, active: true
      });
      setFieldLabel(""); setFieldOptions(""); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Custom field could not be saved."); }
    finally { setSaving(false); }
  }

  async function addStage(event: FormEvent) {
    event.preventDefault();
    const name = stageName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    setSaving(true); setError("");
    try {
      await saveCrmStage(organizationId, {
        id, name, position: (Math.max(0, ...stages.map(stage => stage.position)) + 10), isWon: false, isLost: false, isDefault: false, active: true
      });
      setStageName(""); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Pipeline stage could not be saved."); }
    finally { setSaving(false); }
  }

  return <section className="flex-1 overflow-y-auto bg-gray-50 p-4 md:p-6">
    <div className="mx-auto max-w-7xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-lg font-semibold"><BriefcaseBusiness size={20}/> Sales CRM</h2><p className="text-sm text-gray-500">Track leads through your workspace sales pipeline.</p></div>
        <button type="button" onClick={() => void refresh()} disabled={loading || saving} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-xs text-[#075e54]"><RefreshCw size={14}/> Refresh</button>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border bg-white px-3 py-2 text-xs text-[#075e54] opacity-100">
          <Upload size={14}/>{importing ? "Importing..." : "Import CSV"}
          <input type="file" accept=".csv,text/csv" disabled={importing || saving} className="hidden" onChange={event => { void importCsvFile(event.target.files?.[0]); event.currentTarget.value = ""; }}/>
        </label>
      </div>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {importSummary && <p role="status" className="mb-4 rounded-lg border bg-white p-3 text-xs text-gray-700">{importSummary}</p>}
      {salesReport && <section className="mb-5 rounded-xl border bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Sales performance</h3><p className="text-[10px] text-gray-500">Pipeline summary · updated {new Date(salesReport.generatedAt).toLocaleString()}</p></div><span className="text-[10px] text-gray-500">Up to 1,000 recent leads</span></div>
        {salesReport.limited && <p role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">This is a capped sample of the 1,000 most recently updated leads. Totals may be partial for larger workspaces.</p>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg bg-gray-50 p-3"><p className="text-[10px] text-gray-500">Total leads</p><strong className="text-xl tabular-nums">{salesReport.total}</strong></div>
          <div className="rounded-lg bg-gray-50 p-3"><p className="text-[10px] text-gray-500">Open pipeline (INR)</p><strong className="text-lg tabular-nums">{new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(salesReport.openValue)}</strong><p className="text-[10px] text-gray-500">{salesReport.open} open</p></div>
          <div className="rounded-lg bg-gray-50 p-3"><p className="text-[10px] text-gray-500">Won revenue (INR)</p><strong className="text-lg tabular-nums text-green-700">{new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(salesReport.wonValue)}</strong><p className="text-[10px] text-gray-500">{salesReport.won} won</p></div>
          <div className="rounded-lg bg-gray-50 p-3"><p className="text-[10px] text-gray-500">Win rate</p><strong className="text-xl tabular-nums">{salesReport.conversionRate}%</strong><p className="text-[10px] text-gray-500">{salesReport.won + salesReport.lost} closed</p></div>
        </div>
        {salesReport.byCurrency.some(item => item.currency !== "INR") && <div className="mt-4"><h4 className="mb-2 text-xs font-semibold">Revenue by currency (not converted)</h4><div className="grid gap-2 sm:grid-cols-3">{salesReport.byCurrency.map(item => <div key={item.currency} className="rounded-lg border p-3"><strong className="text-sm">{item.currency}</strong><p className="mt-1 text-[10px] text-gray-500">Open: {item.open.toLocaleString("en-IN")} · Won: {item.won.toLocaleString("en-IN")} · Lost: {item.lost.toLocaleString("en-IN")}</p><p className="mt-1 text-xs font-semibold">Won {new Intl.NumberFormat("en-IN", { style: "currency", currency: item.currency, maximumFractionDigits: 0 }).format(item.wonValue)}</p><p className="text-[10px] text-gray-500">Open {new Intl.NumberFormat("en-IN", { style: "currency", currency: item.currency, maximumFractionDigits: 0 }).format(item.openValue)}</p></div>)}</div></div>}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div><h4 className="mb-2 text-xs font-semibold">Pipeline by stage</h4>{salesReport.byStage.length ? <div className="space-y-2">{salesReport.byStage.map(stage => <div key={stage.id}><div className="mb-1 flex justify-between gap-2 text-[10px]"><span>{stage.name}</span><span>{stage.total} · {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(stage.value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-[#128c7e]" style={{ width: `${salesReport.total ? stage.total / salesReport.total * 100 : 0}%` }}/></div></div>)}</div> : <p className="text-xs text-gray-400">No pipeline data yet.</p>}</div>
          <div><h4 className="mb-2 text-xs font-semibold">Performance by owner</h4>{salesReport.byOwner.length ? <div className="space-y-2">{salesReport.byOwner.map(owner => <div key={owner.uid} className="flex items-center justify-between gap-3 border-b pb-2 text-xs"><span className="min-w-0 truncate">{owner.name}</span><span className="shrink-0 text-right tabular-nums">{owner.won}/{owner.total} won · {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(owner.wonValue)}</span></div>)}</div> : <p className="text-xs text-gray-400">No owner data yet.</p>}</div>
        </div>
        {salesReport.bySource.length > 0 && <div className="mt-4"><h4 className="mb-2 text-xs font-semibold">Lead sources</h4><div className="flex flex-wrap gap-2">{salesReport.bySource.map(source => <span key={source.source} className="rounded-full border bg-gray-50 px-3 py-1 text-[10px] text-gray-600">{source.source}: {source.total}</span>)}</div></div>}
      </section>}
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <button type="button" onClick={() => setFollowUpFilter("all")} aria-pressed={followUpFilter === "all"} className={`rounded-xl border p-3 text-left ${followUpFilter === "all" ? "border-[#075e54] bg-emerald-50" : "bg-white"}`}>
          <span className="block text-[10px] font-medium uppercase tracking-wide text-gray-500">All leads</span><strong className="mt-1 block text-xl">{leads.length}</strong>
        </button>
        <button type="button" onClick={() => setFollowUpFilter("overdue")} aria-pressed={followUpFilter === "overdue"} className={`rounded-xl border p-3 text-left ${followUpFilter === "overdue" ? "border-red-400 bg-red-50" : "bg-white"}`}>
          <span className="block text-[10px] font-medium uppercase tracking-wide text-red-600">Overdue follow-ups</span><strong className="mt-1 block text-xl text-red-700">{followUpCounts.overdue}</strong>
        </button>
        <button type="button" onClick={() => setFollowUpFilter("today")} aria-pressed={followUpFilter === "today"} className={`rounded-xl border p-3 text-left ${followUpFilter === "today" ? "border-amber-400 bg-amber-50" : "bg-white"}`}>
          <span className="block text-[10px] font-medium uppercase tracking-wide text-amber-700">Due later today</span><strong className="mt-1 block text-xl text-amber-800">{followUpCounts.today}</strong>
        </button>
      </div>
      {followUpFilter !== "all" && <div className="mb-3 flex items-center justify-between text-xs text-gray-500"><span>Showing {followUpFilter === "overdue" ? "overdue follow-ups" : "follow-ups due later today"}</span><button type="button" onClick={() => setFollowUpFilter("all")} className="font-semibold text-[#075e54]">Show all leads</button></div>}
      <form onSubmit={submitLead} className="mb-5 grid gap-2 rounded-xl border bg-white p-4 sm:grid-cols-4">
        <label className="text-xs text-gray-600 sm:col-span-2">Lead / deal name<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="Website redesign project" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label>
        <label className="text-xs text-gray-600">Deal value (₹)<input type="number" min="0" max="1000000000000" step="0.01" value={value} onChange={event => setValue(event.target.value)} placeholder="25000" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label>
        <label className="text-xs text-gray-600">Initial stage<select value={stageId} onChange={event => setStageId(event.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm">{activeStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
        <label className="text-xs text-gray-600">Linked customer<select value={contactId} onChange={event => setContactId(event.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">No contact linked</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name} · {contact.phone}</option>)}</select></label>
        <label className="text-xs text-gray-600">Lead owner<select value={ownerUid} onChange={event => setOwnerUid(event.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Unassigned</option>{members.filter(member => member.status === "active").map(member => <option key={member.uid} value={member.uid}>{member.displayName || member.email || member.uid}</option>)}</select></label>
        <label className="text-xs text-gray-600 sm:col-span-3">Lead source<input maxLength={80} value={source} onChange={event => setSource(event.target.value)} placeholder="Website, referral, advertisement..." className="mt-1 w-full rounded-lg border p-2 text-sm"/></label>
        <label className="text-xs text-gray-600">Next follow-up<input type="datetime-local" value={followUpAt} onChange={event => setFollowUpAt(event.target.value)} className="mt-1 w-full rounded-lg border p-2 text-sm"/></label>
        {fields.filter(field => field.active).map(field => <label key={field.id} className="text-xs text-gray-600">{field.label}{field.required ? " *" : ""}{field.type === "select" ? <select required={field.required} value={String(customValues[field.key] ?? "")} onChange={event => setCustomValues(current => ({ ...current, [field.key]: event.target.value }))} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Choose...</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select> : field.type === "boolean" ? <span className="mt-2 flex items-center gap-2"><input type="checkbox" checked={customValues[field.key] === true} onChange={event => setCustomValues(current => ({ ...current, [field.key]: event.target.checked }))}/><span>Yes</span></span> : <input required={field.required} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} value={String(customValues[field.key] ?? "")} onChange={event => setCustomValues(current => ({ ...current, [field.key]: field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value }))} className="mt-1 w-full rounded-lg border p-2 text-sm"/>}</label>)}
        <div className="mt-auto flex gap-2"><button disabled={saving || loading || !title.trim() || !stageId} className="rounded-lg bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"><Plus size={15} className="mr-1 inline"/> {editingLeadId ? "Save lead" : "Add lead"}</button>{editingLeadId && <button type="button" onClick={resetLeadForm} className="rounded-lg border px-3 py-2 text-xs">Cancel</button>}</div>
      </form>
      {canManageSchema && (
      <div className="mb-5 grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-2">
        <form onSubmit={addStage} className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-xs text-gray-600">Add pipeline stage<input value={stageName} onChange={event => setStageName(event.target.value)} maxLength={50} placeholder="Negotiation" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label><button disabled={saving || !stageName.trim()} className="rounded-lg border px-3 py-2 text-xs text-[#075e54]"><Plus size={14} className="mr-1 inline"/> Stage</button></form>
        <form onSubmit={addField} className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-xs text-gray-600">Add custom field<input value={fieldLabel} onChange={event => setFieldLabel(event.target.value)} maxLength={60} placeholder="Company size" className="mt-1 w-full rounded-lg border p-2 text-sm"/></label><select value={fieldType} onChange={event => setFieldType(event.target.value as CrmField["type"])} className="rounded-lg border bg-white p-2 text-xs"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / No</option><option value="select">Dropdown</option></select><button disabled={saving || !fieldLabel.trim()} className="rounded-lg border px-3 py-2 text-xs text-[#075e54]"><Plus size={14} className="mr-1 inline"/> Field</button>{fieldType === "select" && <input value={fieldOptions} onChange={event => setFieldOptions(event.target.value)} placeholder="Option A, Option B" className="w-full rounded-lg border p-2 text-xs"/>}</form>
        <div className="text-[11px] text-gray-500 md:col-span-2">Custom fields are defined and validated for CRM leads. This first pass supports up to 30 workspace fields and 20 pipeline stages. Follow-up reminders, bulk import and advanced reporting are still pending.</div>
      </div>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Pipeline board</h3><span className="text-xs text-gray-500">{leads.length} leads · {fields.filter(field => field.active).length} custom fields</span></div>
      {loading ? <p className="rounded-xl border bg-white p-5 text-sm text-gray-500">Loading CRM...</p> : <div className="grid gap-3 xl:grid-cols-5 md:grid-cols-3 sm:grid-cols-2">{grouped.map(({ stage, leads: stageLeads }) => <section key={stage.id} className="min-h-48 rounded-xl border bg-gray-100 p-3"><div className="mb-3 flex items-center justify-between gap-2"><h4 className="text-sm font-semibold">{stage.name}</h4><span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-gray-500">{stageLeads.length}</span></div><div className="space-y-2">{stageLeads.map(lead => <article key={lead.id} className="rounded-lg border bg-white p-3 shadow-sm"><div className="flex items-start justify-between gap-2"><strong className="break-words text-xs">{lead.title}</strong><div className="flex gap-2"><button type="button" title="Edit lead" onClick={() => startEditLead(lead)} disabled={saving} className="text-gray-400 hover:text-[#075e54]"><Pencil size={13}/></button><button type="button" title="Delete lead" onClick={() => void removeLead(lead)} disabled={saving} className="text-gray-400 hover:text-red-600"><Trash2 size={13}/></button></div></div>{lead.value !== null && <p className="mt-2 text-xs font-semibold text-[#075e54]">{new Intl.NumberFormat("en-IN", { style: "currency", currency: lead.currency || "INR", maximumFractionDigits: 0 }).format(lead.value)}</p>}{lead.source && <p className="mt-1 text-[10px] text-gray-500">Source: {lead.source}</p>}{lead.nextFollowUpAt && <p className={`mt-1 text-[10px] ${new Date(lead.nextFollowUpAt).getTime() < Date.now() ? "font-semibold text-red-600" : "text-amber-700"}`}>Follow-up: {new Date(lead.nextFollowUpAt).toLocaleString()}</p>}{lead.contactId && <p className="mt-1 text-[10px] text-gray-500">Customer: {contacts.find(contact => contact.id === lead.contactId)?.name || lead.contactId}</p>}{lead.ownerUid && <p className="mt-1 text-[10px] text-gray-500">Owner: {members.find(member => member.uid === lead.ownerUid)?.displayName || members.find(member => member.uid === lead.ownerUid)?.email || "Workspace member"}</p>}<label className="mt-3 block text-[10px] text-gray-500">Move to<select value={lead.stageId} onChange={event => void moveLead(lead, event.target.value)} disabled={saving} className="mt-1 w-full rounded-md border bg-white p-1.5 text-xs">{activeStages.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></article>)}</div>{!stageLeads.length && <p className="rounded-lg border border-dashed bg-white/60 p-3 text-center text-[10px] text-gray-400">No leads here</p>}</section>)}</div>}
    </div>
  </section>;
}
