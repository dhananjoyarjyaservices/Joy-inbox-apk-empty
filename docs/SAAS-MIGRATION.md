# Joy Inbox SaaS architecture and migration status

**Current status (2026-11-24):** The `feature/saas-foundation` branch contains a broad multi-tenant SaaS implementation. Repository CI is passing on recent commits, but the product is not yet accepted for staging or production. This document is the current architecture summary; historical incremental notes from earlier phases have been consolidated to avoid contradictory instructions.

## Product architecture

- **Frontend:** React, TypeScript, Vite, responsive tenant workspace inbox.
- **Authentication and data:** Firebase Authentication and Cloud Firestore, accessed by the backend Admin SDK for protected writes.
- **Backend:** Node.js 22 AWS Lambda HTTP API and isolated scheduled worker handlers.
- **Messaging:** WhatsApp Cloud API with per-workspace encrypted credentials and inbound webhook routing by Meta Phone Number ID.
- **Billing:** Stripe Checkout, Billing Portal, signed webhook processing and server-enforced subscription entitlements.
- **Hosting/operations:** Cloudflare Pages frontend, AWS Lambda/EventBridge backend workers, Firestore security rules and indexes.

## Tenant data model and trust boundaries

- `organizations/{organizationId}`: workspace profile, lifecycle and plan metadata.
- `organizations/{organizationId}/members/{uid}`: active membership and owner/admin/agent role.
- `users/{uid}/organizations/{organizationId}`: server-managed workspace switcher index.
- `organizations/{organizationId}/chats/{chatId}/messages/{messageId}`: tenant conversation and message history.
- `organizations/{organizationId}/contacts/{contactId}`, `quickReplies/{replyId}`, `settings/{settingId}`: tenant resources and settings.
- `whatsappPhoneNumbers/{phoneNumberId}`: server-only mapping from Meta Phone Number ID to workspace.
- `organizations/{organizationId}/billing/*`, `invitations/*`, `auditLogs/*`: server-managed billing, invitation and audit records.

Every authenticated tenant API request verifies the Firebase ID token, resolves active organization membership, and checks the required permission. Client-supplied organization IDs are never treated as proof of membership. Webhooks resolve the tenant using Meta's Phone Number ID mapping rather than a tenant identifier in the webhook body. Firestore client rules keep privileged writes, invitations, billing records, audit logs and credential material server-only.

Workspace WhatsApp credentials are encrypted with AES-256-GCM. The 32-byte tenant encryption key and campaign suppression HMAC key belong in server-side secret storage only. Never expose these values through frontend `VITE_*` variables or commit them.

## Implemented product capabilities in this branch

### Workspace and team
- Authenticated workspace create/list and active-workspace selection.
- Owner/admin/agent role checks and plan-based active-seat caps.
- One-time hashed invitation tokens, verified-email acceptance, expiry/revocation and fragment-based invite links.
- Member role changes/removal, paginated member/activity views and audit records.
- WhatsApp connection add/list/health-check/disconnect flow with encrypted per-workspace tokens.

### Shared inbox and messaging
- Organization-scoped chat and message listeners.
- Text, supported media, approved templates, interactive buttons/lists/CTA links and 2–10-card media carousels.
- Quoted replies, message pin/save, chat pin/archive/read/delete, assignment and open/pending/resolved states.
- Contacts with tags/notes and Quick Replies with searchable `/` shortcut insertion.
- Quick Reply image upload/send, internal conversation notes, greeting settings and notification preferences.
- Authenticated tenant media proxy. Customer inbound media bytes are not permanently copied to Firebase Storage, S3, local disk or Lambda temporary storage; only bounded metadata and Meta media IDs are retained. Preview bytes are fetched from Meta on demand and held temporarily by the browser.

### Operations, engagement and analytics
- SLA configuration/checks and team notifications.
- Keyword automation rules and leased scheduled automation queue.
- Campaign draft validation against approved Meta templates, opt-in evidence, STOP/START suppression, explicit start/schedule/pause/resume/cancel and delivery reconciliation.
- Dashboard/team delivery analytics and exportable reports.
- FCM device registration and notification preference foundations; actual device delivery still needs staging acceptance.

### Subscription and usage policy
- Monthly and annual plan catalog and workspace billing UI.
- Stripe Checkout/Billing Portal and signed, idempotent subscription webhook foundations.
- One-time seven-day trial policy, annual price design (10 months charged for 12 months service), hard outbound usage blocking, message/media reservations, active-agent seat caps and usage warnings.
- Plan-based message history retention worker code and a disabled-by-default EventBridge schedule template.

See [PRICING-AND-USAGE-POLICY.md](PRICING-AND-USAGE-POLICY.md) and [BILLING-STRIPE.md](BILLING-STRIPE.md) for the exact plan table, trial rules, quotas and Stripe configuration requirements.

## Customer media retention

The tenant webhook retains bounded media metadata and Meta media IDs only. It does not download customer media bytes into Firebase Storage or S3. Tenant previews are fetched from Meta through an authenticated proxy with host, redirect, MIME/signature and size checks; the current preview cap is 4 MB. Outbound media uploads are bounded and sent to Meta without durable Joy Inbox storage. The legacy owner-only code paths remain in the repository for migration compatibility and must remain fail-closed for tenant traffic.

## Automated repository verification

The branch includes backend unit/regression tests, Firestore emulator/rules coverage, frontend unit tests and a TypeScript/Vite production build. GitHub Actions uses Node.js 22 and locked dependency installation. Recent CI results have passed; always check the latest branch head before treating any commit as verified.

A passing local/emulator test or CI run validates only the tested code path. It does not prove that a live Firebase project, Meta account, Stripe account, email provider, Lambda deployment or customer device is correctly configured.

## Remaining work and acceptance gates

### Repository-only work — do this before Firebase connection
1. Complete source review across all tenant API routes, Firestore rules/indexes, frontend actions and scheduled workers.
2. Resolve remaining code defects and contradictory historical documentation.
3. Complete automated tests for gaps found during review; keep the latest backend emulator tests, frontend tests/build and CI green.
4. Review all legacy owner-only routes and data paths; preserve fail-closed defaults and document the retirement/migration boundary.
5. Review AWS Lambda packaging, handler exports, IAM permissions, EventBridge templates, environment-variable contracts, timeouts and payload-size behavior without deploying production resources.
6. Review Cloudflare preview/build configuration, responsive/mobile behavior and accessibility without changing the production deployment.
7. Complete static tenant-isolation, concurrency, secret-handling, retry/idempotency, retention and migration/rollback review.
8. Refresh release documentation with the exact latest commit and verified CI status.

### Final external integration phase — Firebase intentionally last
After repository-only work is complete, connect an isolated Firebase staging project. Configure Admin credentials, web app settings, indexes and rules; then verify Auth, workspace creation, tenant membership isolation, rules, indexes, data boundaries and rollback. Do not connect Firebase earlier just to make progress on work that can be done in code or emulator.

After Firebase staging is accepted, configure Meta test assets, Stripe test-mode secrets/Price IDs, transactional email and isolated AWS staging resources. Run end-to-end webhook/message delivery, billing/trial/portal/webhook lifecycle, invitation email, campaigns, automation, SLA, notifications, retention, concurrency, backup/restore and mobile tests.

### Production launch gates
- Complete privacy/consent/template-policy and billing/tax/legal review.
- Verify backups, restore drills, alarms, dashboards, rate limits, monitoring and incident runbooks.
- Complete production data migration dry-run, backup, explicit approval, execution and post-migration verification.
- Obtain explicit owner approval before marking the PR ready, merging, deploying production resources, activating schedules, changing production Meta webhooks or enabling Stripe live payments.

## Legacy migration safety

The migration utility at `backend/scripts/migrate-legacy-to-tenant.js` is dry-run first and is never executed automatically. It requires a verified legacy owner UID and an existing active target workspace/owner membership. It uses deterministic IDs, skips existing destination documents and writes a completion marker only after successful completion. It deliberately excludes customer media bytes, Firebase Storage paths, signed URLs and base64 media payloads. Quick Reply image references are marked unavailable and need to be uploaded again to the workspace.

Never run the utility with `--execute` until a Firestore backup and independent rollback snapshot are verified, dry-run counts are reviewed, and the owner explicitly approves the migration window.

## Owner-requested execution order

**Finish all repository-only code, review, documentation, automated testing, static security checks, packaging and preview preparation first. Connect Firebase only as the final external integration step.** Do not ask the owner to configure Firebase while repository-only work remains.

## Deployment boundary

No production Firebase rules/indexes, AWS Lambda/EventBridge resources, Meta webhook settings, Stripe live payments, production data migration or PR merge are performed by repository-only development work. The current pull request remains draft until all required gates pass and the owner explicitly approves the next release action.

## Authoritative checklists

- [RELEASE-READINESS.md](RELEASE-READINESS.md)
- [DEPLOYMENT-CLOUDFLARE-AWS.md](DEPLOYMENT-CLOUDFLARE-AWS.md)
- [ORGANIZATION-ONBOARDING.md](ORGANIZATION-ONBOARDING.md)
- [PRICING-AND-USAGE-POLICY.md](PRICING-AND-USAGE-POLICY.md)
- [BILLING-STRIPE.md](BILLING-STRIPE.md)
- [TENANT-SECRET-KEY-ROTATION.md](TENANT-SECRET-KEY-ROTATION.md)
- [WHATSAPP-CAMPAIGNS.md](WHATSAPP-CAMPAIGNS.md)
