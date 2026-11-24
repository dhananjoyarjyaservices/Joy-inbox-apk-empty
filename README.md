# Joy Inbox

Joy Inbox is being migrated from a single-owner WhatsApp Cloud API inbox to a multi-tenant SaaS product.

## Existing application stack

- React, TypeScript and Vite frontend
- Firebase Authentication and Cloud Firestore
- Node.js 22 AWS Lambda backend
- WhatsApp Cloud API and Firebase Admin SDK

## Existing functionality carried forward

- Real-time chats and text message history
- Incoming and outgoing WhatsApp text
- Saved Quick Replies and slash search
- Chat pin/archive/restore/read state and message actions
- Contacts, conversation search and paginated history
- Image, video, audio and document messaging
- Greeting automation and backend diagnostics
- Light/dark/system appearance
- FCM web push integration (device delivery still requires end-to-end testing)

## SaaS migration status

The SaaS branch now contains an integrated tenant foundation: organization onboarding and membership/role checks; encrypted per-organization WhatsApp credentials; tenant-scoped text/media messaging, chat state and resource APIs; Meta webhook routing by Phone Number ID; campaign and automation workers; billing integration foundations; and a dry-run-first legacy migration utility. See [docs/SAAS-MIGRATION.md](docs/SAAS-MIGRATION.md) for the implementation notes and migration sequence, [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md) for the remaining acceptance gates, and [docs/DEPLOYMENT-CLOUDFLARE-AWS.md](docs/DEPLOYMENT-CLOUDFLARE-AWS.md) for deployment preparation.

**This branch is not production-ready.** Legacy owner-only routes and data paths remain for compatibility, and not every legacy endpoint has been retired. The tenant implementation still requires automated CI confirmation, real Firebase/Meta/Stripe staging validation, full tenant-isolation review, migration/rollback rehearsal and explicit deployment approval. Do not connect real customer tenants until those gates pass.

## Customer media policy

The tenant webhook stores customer media metadata and Meta media IDs only; it does not download or persist inbound customer media bytes to Firebase Storage, S3, local disk or Lambda /tmp. The authenticated tenant media proxy fetches previews from Meta on demand and applies size/MIME/host checks. Outbound uploads are processed in bounded Lambda memory and sent directly to Meta. Legacy owner-only media routes still exist and must not be used as the tenant media path.

## Development

Backend regression tests:

```sh
npm test --prefix backend
```

Frontend build:

```sh
npm ci --prefix frontend
npm run build --prefix frontend
```

Do not deploy AWS Lambda, Firebase rules, storage policies or Meta webhook settings without an explicit production deployment approval. Use `backend/.env.example` and `frontend/.env.example` as configuration references; never commit real tokens, service-account keys, or encryption keys.

## Repository layout

- `frontend/` — React/TypeScript/Vite application
- `backend/` — Node.js Lambda API, WhatsApp integration and tests
- `firestore.rules`, `storage.rules` — existing Firebase security rules
- `docs/SAAS-MIGRATION.md` — SaaS architecture and phased migration plan

## Latest SaaS implementation notes

The tenant webhook path now resolves inbound WhatsApp events through Meta's phone-number mapping and writes tenant messages below the organization chat path. Customer media is retained as bounded metadata and Meta media IDs only; inbound media bytes are not copied to Firebase Storage. The separate legacy owner-only media routes still exist and must remain disabled for tenant traffic until the migration is complete.

Campaign creation validates Meta-approved templates and recorded opt-in evidence, then saves a draft. Owners/admins can explicitly start or schedule a campaign, pause/resume it, or cancel it. A separate EventBridge-triggered Lambda worker revalidates template approval, checks opt-in evidence and re-checks STOP suppression immediately before each send. It uses recipient leases, bounded batches, 429 backoff, and uncertain-delivery handling to avoid automatic duplicate sends. Meta delivery status webhooks update campaign recipient status and delivered/read/failed counters; this reconciliation must still be validated end-to-end in staging.

These improvements do not change the overall release gate: all legacy routes, tenant frontend actions, billing, migration/rollback, staging Meta/Firebase tests, and production deployment configuration still require completion and review.


## Subscription billing foundation

The tenant inbox includes a Workspace Billing screen and a Stripe integration foundation for Checkout, Billing Portal and signed subscription webhooks. Configure real Stripe test-mode secrets and recurring Price IDs before enabling checkout. No pricing, entitlements or payment configuration is assumed; see [docs/BILLING-STRIPE.md](docs/BILLING-STRIPE.md). Billing is not enabled until Stripe credentials and Price IDs are configured and staging checks pass.


## Additional tenant inbox features

The tenant inbox now includes private conversation internal notes, interactive WhatsApp reply buttons/list menus, 2–10-card media carousels using public HTTPS image links, searchable incoming interactive selections, and workspace-scoped billing controls. A dry-run-first legacy migration utility is available; it is never run automatically and strips old customer media storage paths and URLs.


## Release gate

Track staging, migration and production blockers in [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md). This branch is still a development foundation; CI success is not production acceptance.
