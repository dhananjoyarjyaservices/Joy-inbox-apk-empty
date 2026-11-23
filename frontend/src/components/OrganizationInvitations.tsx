import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, RefreshCw, Send, X } from "lucide-react";
import { createOrganizationInvitation, listOrganizationInvitations, revokeOrganizationInvitation, type OrganizationInvitation } from "../services/organizations";

type Props = { organizationId: string; actorRole: "owner" | "admin" | "agent" };

export default function OrganizationInvitations({ organizationId, actorRole }: Props) {
  const [items, setItems] = useState<OrganizationInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "agent">("agent");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const canManage = actorRole === "owner" || actorRole === "admin";

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setItems(await listOrganizationInvitations(organizationId)); }
    catch (e) { setError(e instanceof Error ? e.message : "Invitations could not be loaded."); }
    finally { setLoading(false); }
  }, [organizationId]);

  useEffect(() => { setItems([]); setInviteUrl(""); setNotice(""); void refresh(); }, [refresh]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!canManage || busy) return;
    setBusy(true); setError(""); setNotice(""); setInviteUrl("");
    try {
      const result = await createOrganizationInvitation(organizationId, email.trim(), role);
      setEmail("");
      const shareUrl = result.inviteUrl || (() => {
        const url = new URL("/setup", window.location.origin);
        const fragment = new URLSearchParams();
        fragment.set("organizationId", organizationId);
        fragment.set("invite", result.token);
        url.hash = fragment.toString();
        return url.toString();
      })();
      setInviteUrl(shareUrl);
      setNotice("Invitation created. Copy and send this secure link to the invited person.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Invitation could not be created."); }
    finally { setBusy(false); }
  }

  async function revoke(emailAddress: string) {
    if (!canManage || busy || !window.confirm("Revoke the pending invitation for " + emailAddress + "?")) return;
    setBusy(true); setError(""); setNotice("");
    try { await revokeOrganizationInvitation(organizationId, emailAddress); setNotice("Invitation revoked."); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Invitation could not be revoked."); }
    finally { setBusy(false); }
  }

  async function copyLink() {
    if (!inviteUrl) return;
    try { await navigator.clipboard.writeText(inviteUrl); setNotice("Invitation link copied."); }
    catch { setError("Could not copy automatically. Select and copy the invitation link below."); }
  }

  if (!canManage) return null;
  return <section className="mb-5 rounded-xl border p-3">
    <div className="mb-3 flex items-center justify-between gap-2"><div><h3 className="font-semibold">Invite teammates</h3><p className="text-xs text-gray-500">Invite by email with a one-time link that expires in 7 days.</p></div><button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh invitations" className="rounded-lg border p-2 disabled:opacity-50"><RefreshCw size={15}/></button></div>
    <form onSubmit={invite} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]">
      <input type="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="Teammate email address" className="min-w-0 rounded-lg border px-3 py-2 text-sm"/>
      <select value={role} onChange={e => setRole(e.target.value as "admin" | "agent")} className="rounded-lg border bg-white px-3 py-2 text-sm"><option value="agent">Agent</option>{actorRole === "owner" && <option value="admin">Admin</option>}</select>
      <button disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#075e54] px-4 py-2 text-sm text-white disabled:opacity-50"><Send size={15}/> Create invite</button>
    </form>
    {inviteUrl && <div className="mt-3 rounded-lg bg-gray-50 p-3"><label className="mb-1 block text-xs font-medium">One-time invitation link</label><div className="flex gap-2"><input readOnly value={inviteUrl} className="min-w-0 flex-1 rounded border bg-white px-2 py-2 text-xs"/><button type="button" onClick={() => void copyLink()} className="inline-flex items-center gap-1 rounded border px-3 text-xs"><Copy size={14}/> Copy</button></div></div>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-2 text-sm text-green-700">{notice}</p>}
    <div className="mt-3"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Pending and recent invitations</h4>{loading ? <p className="text-xs text-gray-500">Loading invitations...</p> : items.length ? <div className="divide-y">{items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div className="min-w-0"><p className="truncate text-sm">{item.email}</p><p className="text-xs text-gray-500">{item.role} · {item.status} · expires {new Date(item.expiresAt).toLocaleDateString()}</p></div>{item.status === "pending" && <button type="button" disabled={busy} onClick={() => void revoke(item.email)} className="inline-flex items-center gap-1 rounded border px-2 py-1.5 text-xs text-red-700 disabled:opacity-50"><X size={13}/> Revoke</button>}</div>)}</div> : <p className="text-xs text-gray-500">No invitations yet.</p>}</div>
  </section>;
}
