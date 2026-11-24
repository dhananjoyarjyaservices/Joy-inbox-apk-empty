# Joy Inbox — next implementation work plan

**Prepared:** 2026-11-24  
**Branch:** `feature/saas-foundation`  
**Purpose:** Turn the Interakt parity audit into a buildable backlog. This is a plan, not a claim that these modules are implemented.

## Work completed in the current audit session

- Reviewed the current SaaS branch, key frontend screens, backend route inventory and core tenant resource/billing/webhook modules.
- Compared existing code against Interakt's public product categories.
- Added `docs/INTERAKT-FEATURE-PARITY.md` with implemented/partial/missing distinctions.
- Linked the audit from README and release-readiness documentation.
- Kept Firebase, live payment activation, production deployment and PR merge untouched.

## Priority 0 — Interakt-style self-service WhatsApp onboarding

**Repository implementation status:** Initial code path now added; real Meta activation remains blocked on the owner's Meta app configuration and Meta approval.

Implemented in code:
- Customer-facing **Continue with Facebook** flow using Meta Embedded Signup v4-compatible configuration.
- Authenticated, tenant/user-bound, expiring, single-use onboarding sessions.
- Server-side authorization-code exchange; app secret never sent to the browser.
- WABA/phone-number membership validation.
- Server-generated six-digit registration PIN, Cloud API phone registration and WABA app subscription.
- Encrypted access-token and registration-PIN storage, WABA/phone metadata, and owner/admin-only PIN retrieval.
- Removed manual Phone Number ID/access-token entry from the customer-facing setup screen.

Still required before live customer onboarding:
- Configure Meta App ID, App Secret and Embedded Signup v4 Configuration ID in protected backend settings.
- Select the approved billing model: Tech Provider (Meta bills each customer directly) or Solution Partner (requires Meta-issued Partner Solution ID, system-user token and extended credit line; Joy Inbox assumes payment liability). Solution Partner mode stays disabled until Meta usage metering, customer invoicing, tax and collections are implemented and approved.
- Complete Meta business verification, Tech Provider/Solution Partner eligibility, App Review/Advanced Access and production app mode.
- Validate OTP, new number, existing WABA, eligible coexistence, phone registration, webhook delivery and retry/recovery against Meta staging assets.
- Confirm customer Meta payment responsibility and the selected Tech Provider/Solution Partner billing model.

This is a launch-critical onboarding requirement and must be implemented before CRM expansion.

Customer experience:
- Customer creates a Joy Inbox account and workspace.
- Customer clicks **Connect WhatsApp** and completes Meta's official Facebook Login for Business / Embedded Signup in a secure Meta-hosted flow.
- Customer selects or creates their Business Portfolio and WhatsApp Business Account, chooses an eligible phone-number path, completes the required OTP/QR verification and approves permissions.
- Joy Inbox receives the authorized account/phone identifiers, completes server-side token exchange and phone registration where required, subscribes the WABA to the app webhook, encrypts credentials at rest and automatically syncs number/profile/template status.
- Customer returns to Joy Inbox and sees a clear connected/needs-attention state. No manual Phone Number ID, WABA ID, access-token or webhook URL entry.

Required supported onboarding paths:
- New number registration.
- Existing eligible WhatsApp Business App number through Coexistence, where Meta and the account qualify.
- Existing WhatsApp Business Platform number migration where supported and authorized.
- Clear recovery/help states for OTP failure, display-name review, business verification, permissions, unsupported number and Meta rejection.

Implementation prerequisites and constraints:
- Register/configure Joy Inbox's Meta app and Embedded Signup configuration; complete required app/business verification, permissions and App Review/Tech Provider onboarding.
- Confirm the applicable Meta partner/Tech Provider/BSP model and commercial rules before promising reseller billing or message-fee markup. Embedded Signup availability alone does not confer every BSP capability.
- Implement OAuth state/CSRF protection, one-time authorization-code exchange, server-only app secret, encrypted tenant credential storage, webhook signature validation, duplicate-safe callbacks, audit logs and disconnect/revoke handling.
- Never ask customers to paste access tokens or expose app secrets in browser code.
- Customer still must complete Meta-controlled identity/business choices, number ownership verification (OTP/QR) and requested permissions; Joy Inbox cannot bypass Meta review, eligibility, policy or approval decisions.

Acceptance:
- A first-time customer can connect an eligible number without manually entering API IDs, tokens or webhook URLs.
- Successful onboarding creates the tenant connection and webhook subscription exactly once, even if callback delivery is repeated.
- Tenant A cannot read, connect, disconnect or use Tenant B's WhatsApp assets.
- Failed/abandoned signup can safely resume without duplicate WABAs/numbers or leaked tokens.
- Test new-number, coexistence (when enabled), existing-WABA, denial, OTP failure, retry and disconnect paths in Meta test/staging before launch.

## Recommended build sequence

### Phase 1 — CRM foundation (first product module)
Deliver:
- Tenant-scoped custom contact fields with typed definitions (text, number, date, single-select, multi-select, checkbox).
- Contact profile editor and display of custom values.
- Lead record lifecycle and configurable pipeline stages.
- Board/list views, stage movement, lead owner, value, source and next-follow-up date.
- Filters and basic funnel/agent reports.

Acceptance:
- Every CRM read/write checks active organization membership and permission.
- Firestore rules and backend APIs enforce organization isolation.
- Custom-field schema changes do not silently corrupt existing contact values.
- Stage movement and owner changes have audit history.
- Pagination and indexes are defined before unbounded queries.
- Unit tests cover malformed fields, cross-tenant access, duplicate stages and concurrent updates.

### Phase 2 — Public API and outbound webhooks
Deliver:
- Versioned API surface separate from browser-session routes.
- Hashed API keys, scoped permissions, expiry, rotation and revocation.
- Per-tenant rate limits and idempotency keys.
- Customer-configurable webhook subscriptions, HMAC signatures, delivery attempts, retry/backoff and replay.
- Delivery logs and secret rotation UI.

Acceptance:
- Raw API secrets are displayed once and never stored in plaintext.
- Tenant identity comes from the verified API key, never a caller-supplied organization ID.
- Signed webhook verification examples and tests are supplied.
- Abuse controls and audit events are enabled.

### Phase 3 — Advanced automation builder
Deliver:
- Schedule and out-of-office windows with timezone support.
- Branch/condition nodes and bounded workflow execution.
- FAQ/knowledge entries with owner review.
- Human handoff, stop conditions and loop prevention.
- Safe API/webhook action nodes with allowlists and execution logs.

Acceptance:
- No unbounded loops or arbitrary code execution.
- Workflow sends obey WhatsApp policy, consent and subscription quotas.
- Delayed steps use durable queues and leases.
- Every run is traceable and retry-safe.

### Phase 4 — Commerce, forms and attribution
Deliver:
- Product/catalog records and sync adapters.
- Customer payment-link/order status workflows, distinct from Joy Inbox subscription billing.
- Lead forms, submission capture and contact mapping.
- Campaign click/conversion events and source attribution.

Acceptance:
- Payment provider secrets stay server-side.
- Order/payment state is reconciled from signed provider events.
- Forms validate inputs and consent.
- Attribution reports clearly distinguish delivered, clicked and converted events.

### Phase 5 — Additional channels
Deliver:
- Instagram professional account connection, webhook routing and shared inbox.
- Channel-neutral conversation/message abstraction without breaking WhatsApp tenant paths.
- RCS provider integration only after provider access and delivery capabilities are confirmed.

Acceptance:
- Channel credentials are encrypted and tenant-scoped.
- Webhook signatures, replay and duplicate handling are tested.
- Channel permissions and message windows are enforced independently.

### Phase 6 — AI and voice
Deliver:
- Opt-in AI assistant with knowledge sources, answer citations and agent approval controls.
- Human handoff, safety rules, per-tenant budget/usage caps and observability.
- Voice calling/voice AI only after supported provider access, consent and regulatory review.

Acceptance:
- No cross-tenant retrieval or training-data leakage.
- Admin can disable AI and review actions.
- Sensitive actions require human approval.
- Cost, latency, refusal and escalation metrics are available.

## Owner-controlled final integration phase

Only after repository-only work is finished:
1. Connect isolated Firebase staging and verify Auth, rules, indexes, tenant isolation and rollback.
2. Configure Meta staging credentials and test real inbound/outbound messages, templates and media.
3. Configure Stripe test-mode secrets and all ten recurring Price IDs; complete subscription lifecycle tests.
4. Deploy private staging Lambda workers and schedules; verify IAM, retries, monitoring and backups.
5. Configure transactional email and verify invitations.
6. Complete load, security, mobile/accessibility, privacy, consent and billing/tax acceptance.

## Explicitly out of scope for unattended repository work

- Do not request or commit Firebase/Meta/Stripe/AWS/email secrets.
- Do not activate production schedules or deploy production resources.
- Do not run production migration, merge PR #1 or enable live Stripe payments without explicit approval.
- Do not claim parity until each module has UI, backend, tests, staging evidence and documented operational controls.
