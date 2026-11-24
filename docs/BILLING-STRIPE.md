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
- `STRIPE_PRICE_LITE`
- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_GROWTH`
- `STRIPE_PRICE_BUSINESS`
- `STRIPE_PRICE_PRO`
- `STRIPE_PRICE_LITE_ANNUAL`
- `STRIPE_PRICE_STARTER_ANNUAL`
- `STRIPE_PRICE_GROWTH_ANNUAL`
- `STRIPE_PRICE_BUSINESS_ANNUAL`
- `STRIPE_PRICE_PRO_ANNUAL`
- `BILLING_SUCCESS_URL`
- `BILLING_CANCEL_URL`
- `BILLING_PORTAL_RETURN_URL`

Create five monthly and five annual recurring Products/Prices in the Stripe Dashboard using the INR amounts and entitlements in docs/PRICING-AND-USAGE-POLICY.md, then supply their actual Price IDs. Annual prices bill once per year and are priced at ten monthly payments (two months free). The backend exposes only plans whose Price IDs are configured. Checkout applies a seven-day trial once per workspace; the first successful trial subscription is recorded using trialUsedAt, and subsequent subscriptions for that workspace do not receive another trial. The public billing-plan response includes monthly and annual INR prices, interval availability and usage limits but never exposes Stripe Price IDs. Checkout accepts interval: "month" or "year"; monthly remains the default for older clients.

## Stripe webhook setup

Register `https://YOUR_API_DOMAIN/billing/stripe-webhook` in Stripe and subscribe to the event types listed above. Copy the endpoint signing secret into `STRIPE_WEBHOOK_SECRET`. Keep webhook request bodies unmodified by any proxy or middleware before signature verification.

## Staging acceptance checks

1. Configure Stripe test-mode secret, webhook secret, ten recurring Price IDs (five monthly and five annual) and HTTPS return URLs.
2. From an owner/admin account, open Workspace Billing and create a Checkout Session for each configured plan and both billing intervals.
3. Complete a test subscription and verify `checkout.session.completed` writes the correct organization, customer, subscription, plan, status and renewal date.
4. Update, cancel and fail payment on test subscriptions; verify the subscription status and cancellation flag update from signed webhook events.
5. Open the Billing Portal and verify it returns only the linked Stripe customer.
6. Replay a processed webhook event; it must be acknowledged without applying changes twice. Simulate a concurrent in-progress event and verify the endpoint returns 503 for Stripe retry.
7. Confirm agents and users from another workspace cannot create Checkout/Portal sessions or read billing documents through Firestore.

## Implemented entitlement and launch boundaries

The application now enforces the core hard-limit policy server-side:
- Transaction-backed message reservations and idempotent inbound counting cover tenant outbound message paths, including text, media, templates, interactive messages, campaigns, greetings, retries and automation.
- Media-transfer reservations cover tenant media uploads, template header uploads, Quick Reply image uploads and media proxy downloads.
- Active-agent seat caps are checked transactionally for member additions and invitation acceptance.
- Workspace billing surfaces usage meters and 80% / 95% / 100% message and media warnings.
- Workspaces without an active trial or paid subscription are blocked from outbound messaging and adding team members. Inbound webhooks and existing history remain available when outbound quota is exhausted.
- The one-time seven-day trial is applied at Checkout; trial usage is limited to 25% of the selected plan's monthly message and media allowance, rounded up. A workspace with a recorded trial cannot receive another trial.
- Five monthly and five annual plan Price ID environment variables are supported. Annual billing charges ten monthly payments upfront for twelve months of service; the two-month-free annual prices are documented in `PRICING-AND-USAGE-POLICY.md`.

Still outstanding before commercial launch:
- Create and verify the real Stripe Products/Prices, configure test-mode secrets, webhook signing secret and trusted HTTPS return URLs, then complete the full staging Checkout/Portal/webhook lifecycle tests.
- Verify trial-end payment behavior, cancellation/refund terms, invoices/tax handling and customer support workflows.
- Complete concurrency and tenant-isolation testing against isolated Firebase/Meta/Stripe staging resources.
- Configure external push/email alert delivery; the current in-app usage warnings do not imply email or push delivery.
- Deploy and test the history-retention worker in staging, verify backups/restores, and only then consider enabling its disabled-by-default schedule.
- Complete operational monitoring, incident/rollback rehearsal, legal/accounting review and explicit production approval.

Do not enable live paid checkout or claim staging/production acceptance until these gates are complete. CI success validates committed code and tests only; it does not validate external service configuration or real payment/webhook behavior.
