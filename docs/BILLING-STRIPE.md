# Joy Inbox Stripe billing

## Implemented backend foundation

- Organization-scoped billing status and configured-plan discovery at `GET /organizations/billing?organizationId=...`.
- Stripe Checkout Session creation at `POST /organizations/billing` with `{ organizationId, action: "checkout", plan: "starter" | "growth" | "business" }`.
- Stripe Billing Portal session creation at `POST /organizations/billing` with `{ organizationId, action: "portal" }`.
- Signed webhook receiver at `POST /billing/stripe-webhook`.
- Subscription state is stored under `organizations/{organizationId}/billing/subscription`; Stripe webhook idempotency records are stored in the server-only `stripeWebhookEvents` collection.
- Webhook events handled: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`.
- Stripe signature verification uses the raw request body, a five-minute timestamp tolerance, HMAC-SHA256 and timing-safe comparison. Event claims use leases so Stripe can retry after failed processing.

Only workspace owners/admins with `settings:manage` can create checkout or portal sessions. Stripe secret keys and webhook secrets are never returned to the browser. The browser receives only the Checkout or Billing Portal URL.

## Required backend environment

Configure these in both staging and production backend secrets; never use a Vite/`VITE_` variable:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_GROWTH`
- `STRIPE_PRICE_BUSINESS`
- `BILLING_SUCCESS_URL`
- `BILLING_CANCEL_URL`
- `BILLING_PORTAL_RETURN_URL`

Create the three recurring Products/Prices in the Stripe Dashboard and supply their actual Price IDs. No prices or plan entitlements are invented in this repository. The backend exposes only plans whose Price IDs are configured.

## Stripe webhook setup

Register `https://YOUR_API_DOMAIN/billing/stripe-webhook` in Stripe and subscribe to the event types listed above. Copy the endpoint signing secret into `STRIPE_WEBHOOK_SECRET`. Keep webhook request bodies unmodified by any proxy or middleware before signature verification.

## Staging acceptance checks

1. Configure Stripe test-mode secret, webhook secret, three recurring Price IDs and HTTPS return URLs.
2. From an owner/admin account, open Workspace Billing and create a Checkout Session for each configured plan.
3. Complete a test subscription and verify `checkout.session.completed` writes the correct organization, customer, subscription, plan, status and renewal date.
4. Update, cancel and fail payment on test subscriptions; verify the subscription status and cancellation flag update from signed webhook events.
5. Open the Billing Portal and verify it returns only the linked Stripe customer.
6. Replay a processed webhook event; it must be acknowledged without applying changes twice. Simulate a concurrent in-progress event and verify the endpoint returns 503 for Stripe retry.
7. Confirm agents and users from another workspace cannot create Checkout/Portal sessions or read billing documents through Firestore.

## Not yet production-ready

This is an integration foundation, not a complete commercial billing rollout. It does not configure a Stripe account, create Products/Prices, deploy webhook endpoints, define plan entitlements/usage quotas, implement trial/grace-period business policy, tax/VAT handling, invoices UI, or test live payments. Billing remains disabled until Stripe secrets and real Price IDs are configured. Complete staging acceptance and legal/accounting review before production activation.
