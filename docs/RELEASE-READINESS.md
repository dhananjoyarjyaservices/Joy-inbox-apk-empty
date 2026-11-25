# Joy Inbox SaaS release readiness

Current development branch: `feature/saas-foundation`.

This checklist separates code already present from work that requires real service configuration, production data, external review or an explicit deployment decision. A green CI build does not mean the SaaS product is production-ready.



## Owner-requested execution order

Complete all repository-only implementation, code review, documentation, local/emulator testing, CI checks, static security review, frontend build/preview preparation, Lambda packaging review and infrastructure-template review before requesting any Firebase connection. Firebase connection is intentionally reserved for the final external integration phase. Once the repository-only phase is complete, connect an isolated Firebase staging project and then run integrated Firebase/Meta/Stripe/AWS acceptance tests. Do not ask the owner to configure Firebase while code-only work remains. This sequencing does not waive any staging or production gate below.

## Current parity implementation plan

- [x] Prepare a phased implementation backlog with acceptance criteria for CRM, public APIs/webhooks, advanced automation, commerce/forms/attribution, additional channels and AI/voice in [docs/EVENING-IMPLEMENTATION-PLAN.md](EVENING-IMPLEMENTATION-PLAN.md). This is planning documentation, not implementation of those modules.

- [x] Initial tenant-scoped CRM foundation: pipeline stages, typed custom field definitions/validation, lead records, contact and owner pickers, lead editing/stage changes, follow-up dates, agent-only assigned-lead access and Sales CRM UI.
- [x] Automated CRM follow-up reminders: scheduled scan, transactional deduplication, active-owner validation, in-app notification, push delivery, member opt-out and retry after failure. Notification Center routes CRM alerts to Sales CRM. See `docs/CRM-FOUNDATION.md`.
- [x] CRM CSV bulk import for up to 200 leads per upload, with row-level validation and partial success reporting.
- [x] CRM sales performance report: pipeline totals, won revenue, conversion rate, stage, owner and source breakdowns with agent-scoped visibility and a 1,000-lead sample cap.
- [x] CRM lead activity timeline: append-only actor-attributed create/update/delete events, tracked-field before/after snapshots, agent assignment checks and on-demand pipeline-card history.
- [x] Probability-weighted CRM pipeline forecast using configurable stage win probabilities; expected open value is calculated separately per currency.
- [ ] Validate forecast accuracy and stage-probability configuration with real workspace sales data.

## Public developer API and outbound webhooks — contacts, CRM, text-send, template-read, campaign reporting and draft creation slices

- [x] Add owner/admin API key creation, metadata listing and revocation with one-time raw-key display, SHA-256-only storage, scopes, expiry and throttled last-used metadata.
- [x] Add API-key authentication that derives the workspace from the key, checks active workspace state and enforces contacts read/write scopes.
- [x] Add versioned `GET /public/v1/contacts` and `POST /public/v1/contacts` endpoints.
- [x] Add versioned `GET`, `POST`, `PUT` and `DELETE /public/v1/leads` endpoints with workspace-scoped CRM validation.
- [x] Add `POST /public/v1/messages` for workspace-connected WhatsApp text, media (Meta-hosted upload; no customer media persisted in Firebase), validated interactive button/list/CTA/carousel sends and approved text-header template sends, with `messages:write`, required idempotency keys, message/media quota enforcement and outbound webhook events.
- [x] Add `GET /public/v1/templates` for listing the first Meta template page with `templates:read` and workspace phone/WABA ownership checks.
- [x] Add paginated `GET /public/v1/campaigns` summaries with `campaigns:read`; results expose aggregate delivery counters only and never recipient phone numbers or consent records.
- [x] Add `POST /public/v1/campaigns` with separate `campaigns:write` scope, mandatory idempotency, connected-number validation, Meta approved-template/language/category verification, body-variable validation and opt-out suppression; this endpoint creates drafts only and cannot schedule or send.
- [x] Add a workspace Developer panel to create/revoke keys and view API examples.
- [x] Deny client-side Firestore access to API key and rate-limit records.
- [ ] Enable Firestore TTL on `publicApiRateLimits.expiresAt` in the staging/production project.
- [x] Enforce per-key 60/120/300-requests-per-minute rate limits using server-only Firestore counters.
- [x] Add cursor pagination for contacts and CRM leads, 24-hour idempotency for public API mutations, and daily per-key request/rate-limit usage analytics.
- [x] Add configurable per-key rate-limit tiers (60/120/300 requests per minute), persist the selected tier with the hashed API-key record, enforce it in server-side Firestore counters, and expose the selected tier in the Developer panel.
- [x] Add public API `leads:read` and `leads:write` scopes with workspace-derived list/create/update/delete endpoints and CRM stage/contact/owner/custom-field validation; add unit coverage and explicitly classify the API-key route in the HTTP route-security inventory.
- [x] Add `messages:write` for public text, media, interactive and approved text-header template sends; template sends require past opt-in evidence, check the workspace opt-out suppression list and retain a consent audit record. Add `templates:read` for cursor-paginated public template listing. Public campaign draft creation and campaign state controls are implemented with separate scopes, idempotency and transactional state transitions. Remaining public API gaps: template create/update/delete management, media-header template sends, advanced message management and full staging verification.
- [x] Add owner/admin-managed HTTPS webhook subscriptions, one-time encrypted signing secrets, HMAC-SHA256 delivery, idempotent queueing, bounded retries and contact/message/CRM lead lifecycle events.
- [x] Wire inbound message and Meta message-status events (`sent`, `delivered`, `read`, `failed`) into the outbound delivery queue.
- [x] Add workspace-scoped webhook delivery history API/UI and manual replay for failed deliveries.
- [x] Add workspace-scoped CRM saved views with validated criteria, private/shared visibility, creator/admin deletion and follow-up filter presets in the pipeline UI.
- [x] Add transactional duplicate-contact merge with tenant-scoped linked-lead reassignment, merged tags/notes/custom fields, matching-email duplicate suggestions, merge audit records, admin-authorized endpoint and confirmation UI; staging-scale verification remains pending.
- [x] Add owner/admin endpoint secret rotation with one-time secret display in the Developer panel.
- [x] Add workspace-scoped webhook delivery status/event filters, stable cursor pagination, Firestore composite indexes and Developer panel load-more controls. (Code and unit coverage added; isolated staging delivery/replay/rotation verification remains pending.)
- [ ] Enable Firestore TTL on `webhookDeliveryQueue.expiresAt`; split the delivery worker into its own schedule after staging load tests.
- [ ] Validate external integration traffic, abuse controls and production CORS strategy before public launch.

## Product parity audit

- [x] Compare the implemented Joy Inbox code paths against Interakt's current public product categories and document implemented, partial, missing and externally gated capabilities in [docs/INTERAKT-FEATURE-PARITY.md](INTERAKT-FEATURE-PARITY.md).
- [ ] Implement remaining missing/partial product capabilities listed in `docs/INTERAKT-FEATURE-PARITY.md` before claiming Interakt feature parity. CRM activity timeline and weighted forecasting are implemented; validate them with real workspace data. Public text-send, template-read, campaign reporting/draft/control and signed webhook operations have initial implementations. Still missing or partial: Instagram, RCS, AI/voice, commerce, forms, CTWA ads, visual automation canvas/branching/schedule nodes (the rule builder now supports ALL/ANY conditions and six keyword operators), advanced CRM segments/conversion attribution, catalog/order/payment workflows, and public template management/media-header template sends.

## WhatsApp Embedded Signup onboarding

- [x] Replace customer-facing manual Phone Number ID/access-token entry with a Meta-hosted Facebook Login for Business Embedded Signup flow.
- [x] Add authenticated, workspace-bound, expiring and single-use signup sessions.
- [x] Exchange the authorization code server-side; keep the Meta app secret out of browser code.
- [x] Validate that the selected phone number belongs to the WABA shared by Meta.
- [x] Register the phone with a server-generated six-digit two-step PIN and subscribe the Meta app to the customer's WABA.
- [x] Store the access token and registration PIN encrypted; store WABA/phone metadata with the tenant connection.
- [ ] Configure Meta App ID, App Secret, Embedded Signup v4 Configuration ID and any issued Partner Solution ID in protected backend settings.
- [ ] Complete Meta business verification, Tech Provider/Solution Partner onboarding, App Review/Advanced Access and production app-mode requirements.
- [ ] Choose and approve the commercial model: Tech Provider means Meta bills each customer directly and the customer may need to add a payment method; Solution Partner mode requires Meta-issued Partner Solution ID, assigned system user, approved credit line and exposes Joy Inbox to Meta usage liability.
- [ ] Before enabling Solution Partner mode, implement and validate Meta conversation/utility/marketing/authentication usage metering, customer invoices, tax treatment, payment collection, credit controls and delinquency handling. The code deliberately keeps this mode disabled unless `META_USAGE_BILLING_ENABLED=true`.
- [ ] Verify the full flow with Meta test assets and real eligible customer numbers, including OTP, existing WABA, coexistence eligibility, registration, webhook delivery and recovery paths.
- [ ] Confirm billing responsibility/payment-method UX for the selected Meta partner model before promising fully managed customer billing.

## Code foundations present

- [x] Tenant authentication, organization membership and role checks.
- [x] Tenant-scoped text messaging and webhook routing by Meta Phone Number ID.
- [x] Tenant chat, contact and Quick Reply data foundations.
- [x] Tenant inbox customer phone links validate international digits and open the contact in WhatsApp; unit tests cover valid and invalid numbers.
- [x] Legacy connection-status credential lookup falls back to a still-connected per-number credential when the most recently configured primary number is disconnected; a regression test covers this multi-number edge case.
- [x] Contact phone-number changes use a Firestore transaction, preserve creation timestamps and reject destination-number collisions; regression tests cover missing source and collision cases.
- [x] Inbox assignment and agent-performance views page through the complete organization member list instead of silently stopping at the first 100 members.
- [x] Assignment/state management, SLA checks and team notifications.
- [x] Automation rules with up to five ALL/ANY keyword conditions (`contains`, `exact`, `starts_with`, `ends_with`, `not_contains`, `not_exact`), priority ordering, up to five delayed reply steps, leased queue processing, execution history/health and uncertain-delivery protection. Visual branching, schedules/timezone windows, API/action nodes and FAQ knowledge-base automation remain product gaps.
- [x] Campaign drafts, approved-template checks, consent evidence validation, STOP suppression, explicit START re-subscription, send worker, pause/cancel and recipient reports.
- [x] Internal conversation notes served through authenticated tenant APIs.
- [x] Interactive WhatsApp button and list messages.
- [x] Interactive WhatsApp media carousel composer and server payload validation for 2–10 image cards with HTTPS image and CTA links; card images are referenced by public URL rather than stored in Joy Inbox. Real Meta delivery still requires staging verification.
- [x] Tenant inbox quoted replies: swipe-right gesture and explicit Reply action, quoted-message preview, reply context sent with text/media messages, and backend validation that resolves the original message inside the same organization.
- [x] Transaction-backed message quota reservations and hard outbound enforcement across tenant text, media, templates, interactive messages, campaigns, greetings, retries and automation; unique inbound messages are counted idempotently.
- [x] Production paths fail closed when a workspace has no active trial or paid subscription; backend tests explicitly isolate this gate to the test environment.
- [x] Media-transfer byte reservations for tenant media uploads, template header uploads, Quick Reply image uploads and media proxy downloads.
- [x] Transactional active-agent seat caps and billing-screen usage meters with 80%/95%/100% warnings for messages and media transfer.
- [x] Stripe Checkout/Billing Portal/webhook foundation and workspace billing screen.
- [x] Dry-run-first legacy data migration utility with media sanitization and post-write verification.
- [x] EventBridge schedule templates for campaign, automation and SLA workers.
- [x] Unit tests for Meta webhook HMAC verification, inbound media metadata-only persistence, duplicate webhook-message handling and workspace invitation lifecycle; HTTP route-level tests also verify Meta and Stripe webhook endpoints reject missing/invalid signatures before payload processing. (hashed tokens, verified-email acceptance, expiry, revocation and safe link generation).
- [x] CORS response tests verify exact configured-origin matching, reject lookalike origins, omit wildcard access and keep no-store response headers.
- [x] Firestore rules explicitly deny client reads and writes to workspace invitation documents; emulator coverage verifies that even active owners cannot read invitation token hashes.
- [x] Firestore emulator verifies legacy root chat/deletion/WhatsApp-number collections remain readable only by the configured legacy owner, are not writable from the client, and do not expose arbitrary user profile documents to agents.
- [x] Legacy single-owner HTTP API routes (`/send`, chat state/deletion, media, status, greeting settings and legacy FCM token routes) fail closed with HTTP 410 unless `LEGACY_OWNER_API_ENABLED=true`; organization-scoped routes and Meta webhooks are excluded. Automated tests cover the default-off behavior, explicit migration opt-in and tenant-route isolation.
- [x] A route-inventory regression test scans backend HTTP route suffixes and fails CI if a newly added unscoped endpoint is neither classified as a deliberate system endpoint nor added to the legacy fail-closed list.
- [x] A genuine `backend/package-lock.json` is committed; backend CI uses `npm ci`, and a Node.js 22 workflow regenerates and commits the lockfile when the backend dependency manifest changes.
- [x] Route-level code splitting lazy-loads Login, Setup, Dashboard and Tenant Inbox rather than shipping the entire application in the initial route bundle.
- [x] Firebase Authentication and Firestore client initialization are separated; Firestore SDK imports are deferred to workspace data services instead of the login/auth entry path.
- [x] Vite vendor chunking separates React, motion, Firebase Auth, Firebase core and Firestore; the verified frontend build has no oversized-chunk warning and the largest generated chunk is about 400 KB.
- [x] GitHub Actions checkout/setup-node/setup-java use Node 24-compatible major versions while project builds remain on Node.js 22.
- [x] CI concurrency no longer cancels the validation run on every subsequent push.
- [x] Dependabot weekly update groups target `feature/saas-foundation`; repository security and contribution policies are documented in `SECURITY.md` and `CONTRIBUTING.md`.
- [x] Add a regression test proving concurrent outbound reservations cannot consume more than the final available message quota.
- [x] Draft the staging/production incident triage, secret-rotation and rollback runbook in `docs/OPERATIONS-RUNBOOK.md`.
- [x] Add Lambda entry-point export tests for HTTP, SLA, history retention, campaign and automation workers.
- [x] Add a reproducible production-only Lambda ZIP packaging script; CI installs locked production dependencies in an isolated directory and verifies the ZIP archive.

## History retention worker

- [x] Add a bounded, cursor-based worker that deletes tenant message records older than the active plan's retention window; contacts and chat records remain intact.
- [x] Add a dedicated EventBridge schedule template with the schedule disabled by default.
- [ ] Deploy the worker to an isolated staging Lambda and verify each plan's cutoff against seeded test records.
- [ ] Verify backups and restore procedures before enabling the schedule in any customer environment.

## Required before staging acceptance

- [ ] Configure Firebase Admin credentials and verify all required Firestore indexes.
- [ ] Configure Meta app secret, access tokens, WABA/Phone Number IDs and webhook subscriptions.
- [ ] Configure tenant encryption keyring and the same `CAMPAIGN_SUPPRESSION_HASH_KEY` in webhook/API and campaign worker environments.
- [ ] Configure Stripe test-mode secret, webhook signing secret, real recurring Price IDs and HTTPS return URLs.
- [ ] Deploy isolated staging Lambdas and EventBridge schedules; keep worker Lambdas private.
- [ ] Add Cloudflare preview credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) to repository Actions secrets; preview deployment now skips cleanly when they are absent.
- [ ] Run webhook signature, retry, duplicate delivery and tenant-isolation integration tests with Meta test assets; committed unit tests do not replace this staging exercise.
- [ ] Complete Stripe test checkout, portal, subscription update/cancel and failed-invoice webhook tests.
- [ ] Exercise campaign STOP/START, suppression re-check, throttling, pause/cancel and uncertain-delivery reconciliation end-to-end.
- [x] Implement invitation lifecycle in code: pending invitations, hashed one-time tokens, verified-email acceptance, seven-day expiry, revocation, audit-safe tenant membership creation, copyable fragment-based invitation links that preserve configured deployment base paths, email verification/resend, login redirect preservation and expired-status display in the team UI.
- [ ] Configure a transactional email provider and verify delivery/retry/bounce handling; until then, workspace owners/admins must distribute the generated invitation links through a trusted channel.
- [ ] Run real Firestore staging concurrency/load tests and complete the route-by-route security review of legacy paths; keep `LEGACY_OWNER_API_ENABLED` unset/false outside a controlled migration window.
- [ ] Review data retention, privacy notice, consent language, WhatsApp template policy and billing/tax requirements.

## Required before migrating production data

- [ ] Identify and verify the exact legacy owner UID and target organization ID.
- [ ] Take and verify a Firestore backup plus an independent rollback snapshot.
- [ ] Run migration CLI without `--execute` and review source chat/message/contact/Quick Reply counts.
- [ ] Confirm that media storage paths, signed URLs and customer image bytes are not copied.
- [ ] Obtain explicit approval for the production migration window.
- [ ] Execute migration, verify counts and representative records, and retain the completion marker.
- [ ] Switch frontend/backend reads only after tenant isolation checks pass.

## Required before production launch

- [ ] Configure real Stripe products/prices, verify trial-end behavior and publish the approved cancellation/refund policy.
- [ ] Complete billing invoices, tax/VAT and customer support flows.
- [ ] Verify backups, restore drills, alarms, dashboards, rate limits and incident runbooks.
- [ ] Complete mobile/responsive UX and accessibility review.
- [ ] Review and merge the draft pull request only after all required checks pass and the owner explicitly approves.
- [ ] Deploy production only with explicit approval.

## Deployment boundary

No production data migration, Firebase rules deployment, Lambda deployment, EventBridge activation, Meta webhook change, Stripe live-mode payment or PR merge is performed by this development workflow. These actions require the correct account credentials, an agreed maintenance window and explicit approval.

## Latest automated verification (2026-11-25)

Latest checked development commit: `a4829aae487ac6249b0e42501013eccb5f0f15b5`.
- Backend tests (run 45572134772): **passed**, including Firestore emulator tests and production Lambda package verification.
- Frontend build (run 45572134755): **passed**.
- Joy Inbox CI (run 45572134749): **passed**.
- Cloudflare Pages preview workflow (run 45572126125): **passed**; frontend build succeeded, while the actual Cloudflare deploy step was **skipped** because repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not configured.
- These checks cover repository tests/build and the static preview build only. They do not prove that live Firebase, Meta, Stripe, AWS workers, email or customer-device integrations are configured correctly.

PR #1 remains open and unmerged. Keep it unmerged until external staging and launch gates pass and the owner explicitly approves.

## Static security review completed in repository

Reviewed the current implementation paths for Firebase ID-token verification, active workspace membership and role permissions, legacy single-owner route kill-switch coverage, Firestore tenant read/write boundaries, Meta raw-body HMAC verification, Stripe timestamped HMAC verification, tenant Phone Number ID webhook routing, encrypted per-number credentials, outbound idempotency/uncertain delivery handling, subscription/usage fail-closed behavior and media metadata-only inbound persistence. The review found and fixed a multi-number connection-status fallback edge case; the regression has an automated backend test; the exact current suite count must be read from the latest workflow logs, not inferred from an older run.

This is a repository-level static review, not an independent penetration test or live-service security certification. Staging verification, provider account configuration, external email delivery, AWS deployment/IAM review, load/concurrency testing against real Firestore, backup/restore rehearsal, legal/privacy review and mobile/accessibility acceptance remain open.

The Lambda ZIP is a validation artifact only; no AWS Lambda was deployed. CI and preview success do not prove that a live Firebase project, Meta account, Stripe account, email provider or customer device is correctly configured. Keep PR #1 in draft until all external staging and launch gates pass.
