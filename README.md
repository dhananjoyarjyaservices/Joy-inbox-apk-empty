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

The existing application source has been migrated from the original repository. A first backend tenancy foundation is present in `backend/src/tenancy.js` with organization membership lookup, role permissions, WhatsApp phone-number-to-organization resolution, and AES-256-GCM helpers for server-side tenant secrets. See [docs/SAAS-MIGRATION.md](docs/SAAS-MIGRATION.md) for the target data model, security requirements, media policy and migration sequence. Cloudflare Pages + AWS Lambda deployment preparation is documented in [docs/DEPLOYMENT-CLOUDFLARE-AWS.md](docs/DEPLOYMENT-CLOUDFLARE-AWS.md).

**Important: this branch is not production-ready.** Existing API handlers still enforce a legacy single-owner UID, use global WhatsApp credentials, store chats in top-level collections, and persist media in Firebase Storage. The new tenancy helpers are not yet wired into every API route, webhook, frontend service or Firestore rule. Do not deploy this branch to production or connect real customer tenants until those items and their tests are complete.

## Customer media policy

The SaaS target is to support WhatsApp images, video, audio and documents without permanently storing customer media in Firebase Storage or another durable object store. The final implementation must retain only message metadata and Meta media IDs, use bounded transient processing in Lambda memory, and retrieve inbound media through an authenticated short-lived proxy. See the migration document for required safeguards.

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
