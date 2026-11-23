import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Bot, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  getOrganisationAutomation,
  saveOrganisationAutomation,
  type OrganisationAutomationSettings,
} from "../services/organisations";

const emptySettings: OrganisationAutomationSettings = {
  greetingEnabled: false, greetingText: "",
  awayEnabled: false, awayText: "",
  keywordRules: [],
};

export default function Automation() {
  const { orgId = "" } = useParams();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<OrganisationAutomationSettings>(emptySettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setError("");
    const value = await getOrganisationAutomation(orgId);
    setSettings({ ...emptySettings, ...value, keywordRules: value.keywordRules || [] });
  }

  useEffect(() => {
    let active = true;
    getOrganisationAutomation(orgId)
      .then((value) => { if (active) setSettings({ ...emptySettings, ...value, keywordRules: value.keywordRules || [] }); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Automation settings could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [orgId]);

  function updateRule(index: number, field: "keyword" | "reply" | "enabled", value: string | boolean) {
    setSettings((old) => ({ ...old, keywordRules: old.keywordRules.map((rule, i) => i === index ? { ...rule, [field]: value } : rule) }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await saveOrganisationAutomation(orgId, settings);
      setSettings(result.settings);
      setNotice("Automation settings saved. New incoming messages will use these rules.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save automation settings."); }
    finally { setSaving(false); }
  }

  return (
    <main className="min-h-screen bg-[#f4f7f6] px-4 py-6 text-gray-900">
      <div className="mx-auto max-w-4xl">
        <button onClick={() => navigate(`/org/${orgId}/inbox`)} className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-[#075e54]"><ArrowLeft size={16}/> Back to inbox</button>
        <header className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-[#dff2eb] p-3 text-[#075e54]"><Bot size={24}/></div>
          <div><h1 className="text-2xl font-bold">Automation</h1><p className="text-sm text-gray-500">Automatic replies for this organisation's WhatsApp number.</p></div>
        </header>
        {error && <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {notice && <p className="mb-4 rounded-xl bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
        {loading ? <div className="rounded-2xl bg-white p-6 text-sm text-gray-500">Loading automation settings...</div> :
        <form onSubmit={save} className="space-y-5">
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">Greeting message</h2><p className="text-xs text-gray-500">Sent once when a customer first messages your connected number.</p></div><input type="checkbox" checked={settings.greetingEnabled} onChange={e=>setSettings(old=>({...old,greetingEnabled:e.target.checked}))} className="h-5 w-5 accent-[#075e54]"/></div>
            <textarea value={settings.greetingText} onChange={e=>setSettings(old=>({...old,greetingText:e.target.value}))} maxLength={1024} rows={3} placeholder="Hi! Thanks for contacting us. How can we help?" className="mt-3 w-full rounded-xl border border-gray-200 p-3 text-sm"/>
          </section>
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">Away message</h2><p className="text-xs text-gray-500">When enabled, this reply takes priority over greeting and keyword rules.</p></div><input type="checkbox" checked={settings.awayEnabled} onChange={e=>setSettings(old=>({...old,awayEnabled:e.target.checked}))} className="h-5 w-5 accent-[#075e54]"/></div>
            <textarea value={settings.awayText} onChange={e=>setSettings(old=>({...old,awayText:e.target.value}))} maxLength={1024} rows={3} placeholder="We are currently away. We will reply as soon as possible." className="mt-3 w-full rounded-xl border border-gray-200 p-3 text-sm"/>
          </section>
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3"><div><h2 className="font-semibold">Keyword auto replies</h2><p className="text-xs text-gray-500">First matching keyword in an incoming text message triggers one reply.</p></div><button type="button" disabled={settings.keywordRules.length>=20} onClick={()=>setSettings(old=>({...old,keywordRules:[...old.keywordRules,{keyword:"",reply:"",enabled:true}]}))} className="inline-flex items-center gap-1 rounded-lg border border-[#075e54] px-3 py-2 text-xs font-semibold text-[#075e54] disabled:opacity-40"><Plus size={14}/> Add rule</button></div>
            {settings.keywordRules.length===0 ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">No keyword rules added.</p> : <div className="space-y-3">{settings.keywordRules.map((rule,index)=><div key={index} className="rounded-xl border border-gray-200 p-3">
              <div className="mb-2 flex items-center justify-between"><label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={rule.enabled} onChange={e=>updateRule(index,"enabled",e.target.checked)} className="accent-[#075e54]"/> Enabled</label><button type="button" onClick={()=>setSettings(old=>({...old,keywordRules:old.keywordRules.filter((_,i)=>i!==index)}))} className="text-red-600"><Trash2 size={16}/></button></div>
              <input value={rule.keyword} onChange={e=>updateRule(index,"keyword",e.target.value)} maxLength={60} placeholder="Keyword e.g. price" className="mb-2 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"/>
              <textarea value={rule.reply} onChange={e=>updateRule(index,"reply",e.target.value)} maxLength={1024} rows={2} placeholder="Automatic reply..." className="w-full rounded-lg border border-gray-200 p-3 text-sm"/>
            </div>)}</div>}
          </section>
          <div className="flex flex-wrap gap-3"><button disabled={saving} className="rounded-xl bg-[#075e54] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Saving..." : "Save automation"}</button><button type="button" onClick={()=>refresh().catch(e=>setError(e.message))} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm"><RefreshCw size={15}/> Reload</button></div>
        </form>}
        <p className="mt-5 text-xs leading-5 text-gray-500">Automatic replies are sent only to incoming customer messages received by the connected organisation number. Outgoing messages do not trigger these rules. WhatsApp's customer-service window and messaging policies still apply.</p>
      </div>
    </main>
  );
}
