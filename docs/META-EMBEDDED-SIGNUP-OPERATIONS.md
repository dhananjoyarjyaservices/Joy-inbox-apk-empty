# Meta Embedded Signup — implementation and launch runbook

**Target model:** Tech Provider with direct Meta billing to each customer.  
**Customer experience:** Joy Inbox subscription → Connect WhatsApp → Meta-hosted business authorization and phone verification → automatic connection.  
**Status:** Repository code is present; Meta app approval, protected production configuration and live staging acceptance remain external launch gates.

## Customer journey

1. The customer creates a Joy Inbox account and business workspace.
2. The customer selects and pays for a Joy Inbox monthly or annual subscription (or starts the eligible seven-day trial).
3. The workspace owner opens **Connect WhatsApp Business** and chooses **Continue with Facebook**.
4. Meta hosts the authorization flow. The customer signs in, chooses or creates a Business Portfolio and WhatsApp Business Account, selects or adds a phone number, completes any required OTP/ownership checks, and accepts Meta's permissions and terms.
5. If Meta requires a payment method for WhatsApp usage, the customer adds it in Meta's own billing experience. Joy Inbox must not collect Meta usage charges in Tech Provider mode.
6. Meta returns an authorization code and the selected WABA/phone identifiers to the browser. Joy Inbox sends these to its authenticated backend using a short-lived, single-use workspace-bound signup session.
7. The backend exchanges the code using the server-only Meta app secret, verifies the selected phone and its WABA membership, subscribes the app to the WABA, registers the phone with a server-generated two-step PIN, encrypts the business token/PIN, and saves the connection to that workspace.
8. The customer returns to the Joy Inbox inbox. No manual token, Phone Number ID, WABA ID, webhook URL, AWS or Firebase setup is required.

Meta may still require business details, business verification, phone ownership verification, agreement to Meta terms, or a Meta payment method. Joy Inbox cannot bypass those Meta-controlled checks.

## Required Meta-side setup (Joy Inbox operator)

- [ ] Complete Meta's Tech Provider onboarding/eligibility process for the app and business.
- [ ] Create and configure a Facebook Login for Business configuration specifically for WhatsApp Embedded Signup v4; select the required WhatsApp business permissions and onboarding options.
- [ ] Configure the exact production and staging OAuth redirect/origin settings and allowed domains in the Meta app.
- [ ] Complete required business verification, App Review and Advanced Access for the permissions needed by the intended customer flow; switch to Live mode only after approval.
- [ ] Record the Meta App ID and Embedded Signup Configuration ID.
- [ ] Store the Meta App Secret only in protected backend configuration/AWS Secrets Manager. Never expose it in frontend variables, source control, browser responses or logs.
- [ ] Configure the backend encryption key and Meta webhook verification/app-secret settings in protected backend configuration.
- [ ] Keep `META_PARTNER_MODE=tech_provider` and `META_USAGE_BILLING_ENABLED=false` for direct customer-to-Meta billing.
- [ ] Confirm Meta's current Tech Provider onboarding requirements and approved permissions in the actual app dashboard before production release.

The configuration ID must represent the intended Embedded Signup v4 flow. The Graph API version setting (currently v26.0) is separate from the Embedded Signup flow version; changing the Graph API version does not itself upgrade the Meta Login configuration.

## Protected backend configuration

Required:
- `META_APP_ID`
- `META_APP_SECRET`
- `META_EMBEDDED_SIGNUP_CONFIG_ID`
- `TENANT_SECRET_ENCRYPTION_KEY`
- Firebase Admin credentials and the existing Meta webhook verification/app-secret configuration

Recommended commercial settings:
- `META_PARTNER_MODE=tech_provider`
- `META_USAGE_BILLING_ENABLED=false`
- `GRAPH_API_VERSION=v26.0` (revalidate before release)

Do not put any of these secrets in `VITE_*` frontend variables. The authenticated configuration endpoint intentionally returns only the public App ID, configuration ID, Graph API version and safe display metadata; it never returns the app secret or tenant access tokens.

## Current repository implementation

- Frontend Meta SDK bootstrap and Facebook Login for Business Embedded Signup launch.
- Handles Meta FINISH/CANCEL/ERROR events and validates the returned WABA and phone-number identifiers.
- Authenticated configuration endpoint and workspace-bound signup-session creation.
- Ten-minute, random, single-use session identifiers stored as SHA-256 hashes and bound to the authenticated user and workspace.
- Server-side OAuth code exchange; app secret is never sent to the browser.
- Backend verifies the selected phone number with Meta and verifies that it belongs to the WABA shared during signup.
- Checks for an existing Joy Inbox mapping before connecting the number.
- Subscribes the app to the customer's WABA and registers the phone with a server-generated six-digit two-step PIN.
- Encrypts the tenant access token and registration PIN before saving the workspace connection.
- Stores the billing model with the connection. Tech Provider mode reports `meta_direct`; Solution Partner mode is gated behind separate partner/credit-line/usage-billing configuration.
- Tenant customer media bytes are not permanently copied into Joy Inbox storage by the inbound webhook; this remains the product's metadata/provider-ID-only policy.

## Acceptance tests before launch

### Automated/repository tests
- [ ] Run `npm ci --prefix backend` and `npm test --prefix backend`.
- [ ] Run `npm ci --prefix frontend`, `npm test --prefix frontend` and `npm run build --prefix frontend`.
- [ ] Verify the latest commit's GitHub Actions results, not only a historical green run.
- [ ] Add/retain negative tests for wrong workspace/user, expired/replayed sessions, invalid codes/IDs, phone not in WABA, duplicate phone mapping, missing encryption configuration, Meta API rejection and safe error responses.

### Meta staging acceptance
- [ ] Use a separate Meta app/configuration and test business assets; never test with production customer credentials.
- [ ] Complete signup with a new test business and phone number end-to-end.
- [ ] Verify Meta direct billing is selected and the customer's Meta payment setup remains with Meta.
- [ ] Verify WABA webhook subscription, inbound message routing, delivery-status routing and outbound template/text delivery.
- [ ] Verify encrypted credentials can be read by the tenant backend and are inaccessible to another workspace.
- [ ] Verify disconnect/reconnect, duplicate-number rejection, retry after a failed flow, and session replay rejection.
- [ ] Confirm the generated two-step PIN is recoverable only by an authorized workspace owner/admin and is never written to logs.
- [ ] Record evidence and the tested app/configuration/Graph API versions in the release checklist.

## Billing boundary

- Joy Inbox subscription: charged by Joy Inbox through its own subscription billing integration.
- WhatsApp usage in Tech Provider mode: billed directly by Meta to the customer; any required Meta payment method is configured by the customer in Meta.
- Do not enable Solution Partner mode unless Meta has approved the partner relationship and issued all required IDs/credit-line access, and Joy Inbox has implemented, tested and legally reviewed usage metering, customer invoicing, tax handling, collections, credit limits and delinquency handling.

## Explicit non-goals / safety

- Do not ask customers to paste access tokens, WABA IDs or Phone Number IDs into Joy Inbox.
- Do not expose Meta app secrets or tenant access tokens to the browser.
- Do not claim Meta approval, production connection, live billing, or successful real-number onboarding until the relevant staging/production evidence exists.
- Do not deploy production infrastructure, change live Meta settings, migrate production data or merge the draft PR without the owner's explicit approval.
