# Joy Inbox

Joy Inbox is a multi-tenant WhatsApp Business inbox SaaS built with React, TypeScript, Vite, Node.js 22, AWS Lambda, Firebase Authentication/Firestore and the WhatsApp Cloud API.

## Product capabilities in the SaaS branch

- Workspace onboarding, account switching, owner/admin/agent roles and workspace invitations.
- Shared tenant inbox with assignment, status management, pin/archive, search, paginated history, customer contacts, one-tap WhatsApp contact links and internal notes.
- Tenant-scoped text, media, approved-template and interactive WhatsApp messaging, including reply buttons, lists, CTA links, media carousels and quoted replies.
- Searchable saved Quick Replies, greeting automation, keyword automation and scheduled automation workers.
- SLA settings, notification center, per-agent notification preferences and delivery monitoring.
- Campaign drafts, opt-in evidence checks, STOP/START suppression, approved-template revalidation, scheduling, pause/cancel and delivery reports.
- Workspace billing foundation with monthly/annual plan discovery, seven-day one-time trial, Stripe Checkout/Billing Portal/webhooks and server-side usage/seat enforcement.
- Plan-based history-retention worker code and a disabled-by-default retention schedule template.
- Dry-run-first legacy migration tooling with customer media bytes and legacy media URLs excluded.

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
- `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `firebase.json` — Firebase security, indexes and emulator configuration.
- `infra/aws/` — EventBridge schedule templates for automation, campaigns, SLA monitoring and history retention.
- `docs/` — onboarding, billing, deployment, migration and release-readiness guidance.

Customer inbound media bytes are not permanently copied into tenant storage by the webhook. Tenant message records retain bounded metadata and Meta media IDs; authenticated previews are proxied from Meta on demand.

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

The current development branch is `feature/saas-foundation`, with draft PR [#1](https://github.com/dhananjoyarjyaservices/Joy-inbox-apk-empty/pull/1) targeting `main`.

The code foundation and automated tests are substantially implemented, but this branch is **not production-ready**. Remaining acceptance work includes staging integration tests, transactional email delivery, worker deployment and verification, backup/restore, tenant-isolation/concurrency/security review, legal/billing review, mobile/accessibility checks and production migration/cutover rehearsal.

**Execution order:** finish repository-only code, documentation, review and CI first. Keep Firebase connection and Firebase staging acceptance until the final external integration phase. Then verify Firebase Auth, Firestore indexes/rules, workspace creation, membership isolation and rollback before accepting real tenants. Meta and Stripe staging validation, AWS worker deployment and all production actions remain gated by credentials, tests and explicit approval.

No production Firebase rules/indexes, AWS Lambda/EventBridge resources, Meta webhook settings, Stripe live payments, production data migration or PR merge are performed by repository-only development work. Never commit secrets or place server credentials in frontend `VITE_*` variables.

## Current authoritative checklists

- [docs/INTERAKT-FEATURE-PARITY.md](docs/INTERAKT-FEATURE-PARITY.md) — audited feature-by-feature comparison and missing-work backlog.\n- [docs/EVENING-IMPLEMENTATION-PLAN.md](docs/EVENING-IMPLEMENTATION-PLAN.md) — prioritized build sequence and acceptance criteria.\n- [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md)
- [docs/DEPLOYMENT-CLOUDFLARE-AWS.md](docs/DEPLOYMENT-CLOUDFLARE-AWS.md)
- [docs/BILLING-STRIPE.md](docs/BILLING-STRIPE.md)
- [docs/ORGANIZATION-ONBOARDING.md](docs/ORGANIZATION-ONBOARDING.md)
- [docs/SAAS-MIGRATION.md](docs/SAAS-MIGRATION.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [docs/OPERATIONS-RUNBOOK.md](docs/OPERATIONS-RUNBOOK.md)
