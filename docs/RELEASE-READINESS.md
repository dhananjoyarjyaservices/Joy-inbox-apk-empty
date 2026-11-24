# Joy Inbox SaaS release readiness

Current development branch: `feature/saas-foundation`.

This checklist separates code already present from work that requires real service configuration, production data, external review or an explicit deployment decision. A green CI build does not mean the SaaS product is production-ready.



## Owner-requested execution order

Complete all repository-only implementation, code review, documentation, local/emulator testing, CI checks, static security review, frontend build/preview preparation, Lambda packaging review and infrastructure-template review before requesting any Firebase connection. Firebase connection is intentionally reserved for the final external integration phase. Once the repository-only phase is complete, connect an isolated Firebase staging project and then run integrated Firebase/Meta/Stripe/AWS acceptance tests. Do not ask the owner to configure Firebase while code-only work remains. This sequencing does not waive any staging or production gate below.

## Code foundations present

- [x] Tenant authentication, organization membership and role checks.
- [x] Tenant-scoped text messaging and webhook routing by Meta Phone Number ID.
- [x] Tenant chat, contact and Quick Reply data foundations.
- [x] Contact phone-number changes use a Firestore transaction, preserve creation timestamps and reject destination-number collisions; regression tests cover missing source and collision cases.
- [x] Inbox assignment and agent-performance views page through the complete organization member list instead of silently stopping at the first 100 members.
- [x] Assignment/state management, SLA checks and team notifications.
- [x] Automation rules, leased queue processing and uncertain-delivery protection.
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
- [ ] Run webhook signature, retry, duplicate delivery and tenant-isolation integration tests with Meta test assets; committed unit tests do not replace this staging exercise.
- [ ] Complete Stripe test checkout, portal, subscription update/cancel and failed-invoice webhook tests.
- [ ] Exercise campaign STOP/START, suppression re-check, throttling, pause/cancel and uncertain-delivery reconciliation end-to-end.
- [x] Implement invitation lifecycle in code: pending invitations, hashed one-time tokens, verified-email acceptance, seven-day expiry, revocation, audit-safe tenant membership creation, copyable fragment-based invitation links that preserve configured deployment base paths, email verification/resend, login redirect preservation and expired-status display in the team UI.
- [ ] Configure a transactional email provider and verify delivery/retry/bounce handling; until then, workspace owners/admins must distribute the generated invitation links through a trusted channel.
- [ ] Run load tests, concurrency tests and security review for all legacy routes; keep `LEGACY_OWNER_API_ENABLED` unset/false outside a controlled migration window.
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

## Latest automated verification (2026-11-24)

The latest code-bearing commit verified by all three GitHub Actions workflows is `f0feca5ce4fef23aca99a0a2867d6da85a664d54` on `feature/saas-foundation`:

- Frontend build (run 45349483444): dependency installation, 6 frontend tests, TypeScript check and Vite production build passed. Largest generated chunk was about 400 KB; no oversized-chunk warning was emitted.
- Backend tests (run 45349483428): Node.js 22 setup, locked dependency installation and all 282 backend tests with the Firestore emulator passed.
- Joy Inbox CI (run 45349483369): backend unit tests and frontend TypeScript/tests/production build passed.

These checks validate the code at the stated commit. They do not prove that a live Firebase project, Meta account, Stripe account, email provider, deployed AWS worker or customer device is correctly configured. Documentation-only and configuration-only commits may follow this code-bearing commit; rerun checks for any later source-code changes before treating them as verified.
