const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

function getInvitationBaseUrl() {
  const raw = String(process.env.APP_BASE_URL || process.env.FRONTEND_URL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return "";
    return url.origin;
  } catch {
    return "";
  }
}

async function sendOrganisationInvitationEmail({ to, organisationName, role, orgId, invitationId, expiresAt }) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.INVITATION_FROM_EMAIL || "").trim();
  const baseUrl = getInvitationBaseUrl();
  if (!apiKey || !from || !baseUrl) {
    return { sent: false, reason: "not_configured" };
  }

  const inviteUrl = new URL("/setup", baseUrl);
  inviteUrl.searchParams.set("orgId", orgId);
  inviteUrl.searchParams.set("invitationId", invitationId);
  const safeOrg = escapeHtml(organisationName);
  const safeRole = escapeHtml(role);
  const safeUrl = escapeHtml(inviteUrl.toString());
  const expiryText = new Date(expiresAt).toLocaleString("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC"
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `You're invited to join ${organisationName} on Joy Inbox`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937"><h2 style="color:#075e54">Joy Inbox invitation</h2><p>You have been invited to join <strong>${safeOrg}</strong> as <strong>${safeRole}</strong>.</p><p><a href="${safeUrl}" style="display:inline-block;background:#075e54;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px">Accept invitation</a></p><p>This invitation expires on ${escapeHtml(expiryText)} (UTC). Sign in with this invited email address and verify it before accepting.</p><p style="font-size:12px;color:#6b7280">If you were not expecting this invitation, you can ignore this email.</p></div>`,
      text: `You have been invited to join ${organisationName} on Joy Inbox as ${role}. Accept: ${inviteUrl.toString()} . This invitation expires at ${expiryText} UTC.`
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Invitation email provider rejected request:", response.status, String(payload.message || payload.error || "unknown error").slice(0, 240));
    return { sent: false, reason: "provider_error" };
  }
  return { sent: true, provider: "resend", providerMessageId: String(payload.id || "") };
}

module.exports = { sendOrganisationInvitationEmail };
