# Joy Inbox SaaS release readiness

Current development branch: `feature/saas-foundation`.

This checklist separates code already present from work that requires real service configuration, production data, external review or an explicit deployment decision. A green CI build does not mean the SaaS product is production-ready.

## Code foundations present

- [x] Tenant authentication, organization membership and role checks.
- [x] Tenant-scoped text messaging and webhook routing by Meta Phone Number ID.
- [x] Tenant chat, contact and Quick Reply data foundations.
- [x] Assignment/state management, SLA checks and team notifications.
- [x] Automation rules, leased queue processing and uncertain-delivery protection.
- [x] Campaign drafts, approved-template checks, consent evidence validation, STOP suppression, explicit START re-subscription, send worker, pause/cancel and recipient reports.
- [x] Internal conversation notes served through authenticated tenant APIs.
- [x] Interactive WhatsApp button and list messages.
- [x] Stripe Checkout/Billing Portal/webhook foundation and workspace billing screen.
- [x] Dry-run-first legacy data migration utility with media sanitization and post-write verification.
- [x] EventBridge schedule templates for campaign, automation and SLA workers.
- [x] Unit tests for Meta webhook HMAC verification, inbound media metadata-only persistence, duplicate webhook-message handling and workspace invitation lifecycle (hashed tokens, verified-email acceptance, expiry, revocation and safe link generation).
- [x] Firestore rules explicitly deny client reads and writes to workspace invitation documents; emulator coverage verifies that even active owners cannot read invitation token hashes.
- [x] Firestore emulator verifies legacy root chat/deletion/WhatsApp-number collections remain readable only by the configured legacy owner, are not writable from the client, and do not expose arbitrary user profile documents to agents.
- [x] Legacy single-owner HTTP API routes (`/send`, chat state/deletion, media, status, greeting settings and legacy FCM token routes) fail closed with HTTP 410 unless `LEGACY_OWNER_API_ENABLED=true`; organization-scoped routes and Meta webhooks are excluded. Automated tests cover the default-off behavior, explicit migration opt-in and tenant-route isolation.
- [x] A genuine `backend/package-lock.json` is committed; backend CI uses `npm ci`, and a Node.js 22 workflow regenerates and commits the lockfile when the backend dependency manifest changes.

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

- [ ] Configure real Stripe products/prices and decide plan entitlements, quotas, trial/grace policy and cancellation policy.
- [ ] Complete billing invoices, tax/VAT and customer support flows.
- [ ] Verify backups, restore drills, alarms, dashboards, rate limits and incident runbooks.
- [ ] Complete mobile/responsive UX and accessibility review.
- [ ] Review and merge the draft pull request only after all required checks pass and the owner explicitly approves.
- [ ] Deploy production only with explicit approval.

## Deployment boundary

No production data migration, Firebase rules deployment, Lambda deployment, EventBridge activation, Meta webhook change, Stripe live-mode payment or PR merge is performed by this development workflow. These actions require the correct account credentials, an agreed maintenance window and explicit approval.
