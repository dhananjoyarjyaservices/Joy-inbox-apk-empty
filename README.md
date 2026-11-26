# Joy Inbox

Joy Inbox is a multi-tenant WhatsApp Business inbox SaaS built with React, TypeScript, Vite, Node.js 22, AWS Lambda, Firebase Authentication and the WhatsApp Cloud API.

## Product capabilities in the SaaS branch

- Workspace onboarding, account switching, owner/admin/agent roles and workspace invitations.
- Initial tenant-scoped Sales CRM with a five-stage pipeline, configurable stages, up to 30 typed custom fields, lead values/sources/follow-ups and a pipeline board.
- Shared tenant inbox with assignment, status management, pin/archive, search, paginated history, customer contacts, one-tap WhatsApp contact links and internal notes.
- Tenant-scoped text, media, approved-template and interactive WhatsApp messaging, including reply buttons, lists, CTA links, media carousels and quoted replies.
- Searchable saved Quick Replies, greeting automation, keyword automation and scheduled automation workers.
- SLA settings, notification center, per-agent notification preferences and delivery monitoring.
- Campaign drafts, opt-in evidence checks, STOP/START suppression, approved-template revalidation, scheduling, pause/cancel and delivery reports.
- Workspace billing foundation with monthly/annual plan discovery, seven-day one-time trial, Stripe Checkout/Billing Portal/webhooks and server-side usage/seat enforcement.
- Existing Firestore-based data implementation and media-retention worker remain in the SaaS foundation branch; AWS migration is tracked separately and is not yet implemented.

## Pricing policy

The approved product design is documented in [docs/PRICING-AND-USAGE-POLICY.md](docs/PRICING-AND-USAGE-POLICY.md).

| Plan | Monthly | Annual |
|---|---:|---:|
| Lite | ₹299 | ₹2,990 |
| Starter | ₹599 | ₹5,990 |
| Growth | ₹999 | ₹9,990 |
| Business | ₹1,499 | ₹14,990 |
| Pro | ₹1,999 | ₹19,990 |

Annual billing charges for 10 months and provides 12 months of service. Eligible workspaces receive one seven-day trial. The configured usage policy blocks outbound activity at hard limits without automatic overages. Meta WhatsApp charges are separate. These prices are approved product design, not proof that live Stripe prices have been configured.

## Architecture and repository layout

- `frontend/` — responsive React/TypeScript/Vite application.
- `backend/` — Node.js 22 Lambda API, WhatsApp integration, billing and scheduled worker handlers.
- `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `firebase.json` — current Firebase security, indexes and emulator configuration.
- `infra/aws/` — EventBridge schedule templates for automation, campaigns, SLA monitoring and history retention.
- `docs/AWS-DATA-PLANE-MIGRATION.md` — target DynamoDB/S3 architecture, tenant isolation, media quota/retention contract and safe cutover sequence.
- `docs/` — onboarding, billing, deployment, migration and release-readiness guidance.

**Important migration status:** the current application still uses Firestore for tenant/business data and Firebase Storage for saved media. The requested AWS target (DynamoDB for tenant records and private S3 for durable customer media) is not yet connected. The migration contract documents the required work; do not treat it as a completed migration. Customer inbound media is currently not permanently copied into tenant storage by the webhook.

## Development and automated checks

Backend tests:

```sh
npm ci --prefix backend
npm test --prefix backend
```

Frontend tests and production build:

```sh
npm ci --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
```

GitHub Actions runs backend tests with the Firestore emulator and builds/tests the frontend using Node.js 22. Check the latest commit's workflow status before treating a change as verified.

## Release status

The current SaaS foundation branch is `feature/saas-foundation`, with draft PR [#1](https://github.com/dhananjoyarjyaservices/Joy-inbox-apk-empty/pull/1) targeting `main`. AWS data-plane migration preparation is on `feature/aws-data-plane-migration`.

The code foundation is **not production-ready**. Remaining acceptance work includes the DynamoDB/S3 migration, staging integration tests, transactional email delivery, worker deployment and verification, backup/restore, tenant-isolation/concurrency/security review, legal/billing review, mobile/accessibility checks and production migration/cutover rehearsal.

No production Firebase rules/indexes, AWS Lambda/EventBridge resources, Meta webhook settings, Stripe live payments, production data migration or PR merge are performed by repository-only development work. Never commit secrets or place server credentials in frontend `VITE_*` variables.

## Current authoritative checklists

- [docs/WEBHOOKS.md](docs/WEBHOOKS.md) — signed outbound webhook setup, verification and retry behavior.
- [docs/PUBLIC-API.md](docs/PUBLIC-API.md) — initial scoped contacts API and developer key guide.
- [docs/INTERAKT-FEATURE-PARITY.md](docs/INTERAKT-FEATURE-PARITY.md) — audited feature-by-feature comparison and missing-work backlog.
- [docs/EVENING-IMPLEMENTATION-PLAN.md](docs/EVENING-IMPLEMENTATION-PLAN.md) — prioritized build sequence and acceptance criteria.
- [docs/CRM-FOUNDATION.md](docs/CRM-FOUNDATION.md)
- [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md)
- [docs/META-EMBEDDED-SIGNUP-OPERATIONS.md](docs/META-EMBEDDED-SIGNUP-OPERATIONS.md) — customer flow, Tech Provider billing boundary and Meta launch checklist
- [docs/DEPLOYMENT-CLOUDFLARE-AWS.md](docs/DEPLOYMENT-CLOUDFLARE-AWS.md)
- [docs/BILLING-STRIPE.md](docs/BILLING-STRIPE.md)
- [docs/ORGANIZATION-ONBOARDING.md](docs/ORGANIZATION-ONBOARDING.md)
- [docs/SAAS-MIGRATION.md](docs/SAAS-MIGRATION.md)
- [docs/AWS-DATA-PLANE-MIGRATION.md](docs/AWS-DATA-PLANE-MIGRATION.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [docs/OPERATIONS-RUNBOOK.md](docs/OPERATIONS-RUNBOOK.md)
