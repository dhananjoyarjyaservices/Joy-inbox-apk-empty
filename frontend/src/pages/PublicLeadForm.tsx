import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, LoaderCircle } from "lucide-react";

type PublicField = { key: string; label: string; type: "text" | "email" | "phone" | "textarea" | "select"; required: boolean; options: string[] };
type PublicForm = { id: string; name: string; description: string; fields: PublicField[]; submitButton: string; successMessage: string; consentRequired: boolean; consentText: string };
const API_URL = import.meta.env.VITE_API_BASE_URL;

export default function PublicLeadForm() {
  const { formId = "" } = useParams();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      if (!API_URL) { setError("Form service is not configured."); setLoading(false); return; }
      try {
        const response = await fetch(`${API_URL.replace(/\/$/, "")}/public/v1/forms/${encodeURIComponent(formId)}`);
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "This form is unavailable.");
        if (active) {
          setForm(result.form);
          setValues(Object.fromEntries((result.form.fields || []).map((field: PublicField) => [field.key, ""])));
        }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "This form could not be loaded."); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [formId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || submitting) return;
    setSubmitting(true); setError("");
    try {
      const response = await fetch(`${API_URL.replace(/\/$/, "")}/public/v1/forms/${encodeURIComponent(formId)}/submissions`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ values, consent, website })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Your response could not be submitted.");
      setSuccess(result.successMessage || form.successMessage);
    } catch (e) { setError(e instanceof Error ? e.message : "Your response could not be submitted."); }
    finally { setSubmitting(false); }
  }

  return <main className="min-h-screen bg-[#eef2f3] px-4 py-8">
    <div className="mx-auto max-w-xl">
      <div className="mb-4 text-center"><div className="mx-auto mb-2 grid h-11 w-11 place-items-center rounded-2xl bg-[#075e54] text-lg font-bold text-white">J</div><p className="text-xs font-semibold tracking-wide text-[#075e54]">JOY INBOX</p></div>
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
        {loading ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500"><LoaderCircle className="animate-spin" size={18}/> Loading form...</div>
        : success ? <div className="py-10 text-center"><CheckCircle2 className="mx-auto mb-3 text-emerald-600" size={42}/><h1 className="text-xl font-semibold text-gray-900">Thank you!</h1><p className="mt-2 text-sm text-gray-600">{success}</p></div>
        : form ? <>
          <h1 className="text-xl font-semibold text-gray-900">{form.name}</h1>
          {form.description && <p className="mt-2 text-sm text-gray-500">{form.description}</p>}
          <form onSubmit={event => void submit(event)} className="mt-6 space-y-4">
            {form.fields.map(field => <label key={field.key} className="block text-sm font-medium text-gray-700">{field.label}{field.required && <span className="ml-1 text-red-600">*</span>}
              {field.type === "textarea" ? <textarea required={field.required} maxLength={2000} value={values[field.key] || ""} onChange={e => setValues(current => ({ ...current, [field.key]: e.target.value }))} rows={4} className="mt-1.5 w-full rounded-lg border border-gray-300 p-3 text-sm outline-none focus:border-[#075e54]"/>
              : field.type === "select" ? <select required={field.required} value={values[field.key] || ""} onChange={e => setValues(current => ({ ...current, [field.key]: e.target.value }))} className="mt-1.5 w-full rounded-lg border border-gray-300 bg-white p-3 text-sm outline-none focus:border-[#075e54]"><option value="">Select...</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select>
              : <input type={field.type === "phone" ? "tel" : field.type} required={field.required} maxLength={500} value={values[field.key] || ""} onChange={e => setValues(current => ({ ...current, [field.key]: e.target.value }))} placeholder={field.type === "phone" ? "+919876543210" : ""} className="mt-1.5 w-full rounded-lg border border-gray-300 p-3 text-sm outline-none focus:border-[#075e54]"/>}
            </label>)}
            <label className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)}/></label>
            {form.consentRequired && <label className="flex items-start gap-2 text-xs text-gray-600"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required className="mt-0.5"/><span>{form.consentText}</span></label>}
            {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
            <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#075e54] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{submitting && <LoaderCircle className="animate-spin" size={16}/>} {submitting ? "Submitting..." : form.submitButton}</button>
          </form>
        </> : <div className="py-10 text-center"><h1 className="text-lg font-semibold">Form unavailable</h1><p className="mt-2 text-sm text-gray-500">{error || "This form may have been disabled."}</p></div>}
      </section>
      <p className="mt-4 text-center text-[10px] text-gray-400">Powered by Joy Inbox</p>
    </div>
  </main>;
}
