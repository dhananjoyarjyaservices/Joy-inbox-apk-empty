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
