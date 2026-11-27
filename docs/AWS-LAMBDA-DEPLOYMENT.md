# AWS Lambda deployment guide

This repository packages the Joy Inbox HTTP API for **AWS Lambda Node.js 22.x**.

## Build and verify the deployment ZIP

From the repository root:

```bash
cd backend
npm ci
npm run package:lambda
```

The script creates `backend/dist/joy-inbox-lambda.zip`, installs production dependencies from the lockfile, and runs `unzip -t` before reporting success. Upload that ZIP to the Lambda function; rebuild and upload it again only when backend code or dependencies change.

## Lambda function settings

- Runtime: **Node.js 22.x**
- Handler: **index.handler**
- Architecture: **x86_64** (the package is built on GitHub/Linux; use the same architecture for native dependencies if introduced)
- Memory: start at 1024 MB and tune from CloudWatch metrics
- Timeout: start at 30 seconds; keep API Gateway integration timeout constraints in mind
- Expose the function through an API Gateway **HTTP API** with a catch-all route to the Lambda integration.
- Configure a Lambda execution role with CloudWatch Logs permissions. Add only the AWS permissions actually used by enabled features.

## Health check

Configure an unauthenticated `GET /health` route. It returns a minimal liveness response and does not initialize Firebase or expose environment configuration:

```json
{ "status": "ok", "service": "joy-inbox-api" }
```

This is a process/liveness check, not a Firebase, Meta, Stripe, or database readiness check. Validate those integrations separately in staging before production traffic.

## Required server-side environment

Set these on the Lambda function (prefer AWS Secrets Manager for credentials):

- Firebase Admin: either `FIREBASE_SERVICE_ACCOUNT` (complete service-account JSON) **or** all of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
- `TENANT_SECRET_ENCRYPTION_KEY`: base64-encoded 32-byte key.
- `WHATSAPP_VERIFY_TOKEN`: random webhook verification secret.
- `FRONTEND_BASE_URL` and `CORS_ORIGINS`: exact deployed HTTPS origin(s).
- Meta Embedded Signup: `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`.
- Billing only when enabled: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, all monthly and annual `STRIPE_PRICE_*` IDs, and trusted billing return URLs.
- Campaign suppression: `CAMPAIGN_SUPPRESSION_HASH_KEY` (base64-encoded 32-byte key).

Optional integrations must remain disabled until their real credentials and provider-side setup are complete. Do not copy frontend `VITE_*` values into Lambda, commit secrets, or paste secrets into GitHub source files.

## Staging verification

1. Deploy the ZIP to a separate staging Lambda and attach the HTTP API staging stage.
2. Confirm `GET /health` returns HTTP 200.
3. Confirm Firebase-authenticated organization endpoints reject anonymous requests (401) and work with a staging Firebase identity.
4. Verify Meta webhook signature/verification, embedded signup, a test WhatsApp send, and inbound webhook delivery using Meta test assets.
5. If Stripe is configured, use Stripe test mode and verify checkout, webhook signature, and portal return.
6. Review CloudWatch errors, throttles, duration, and memory; test rollback to the previous ZIP.
7. Keep scheduled workers and destructive retention schedules disabled until each schedule has a staging dry run, backup, and restore verification.

A successful ZIP build or health response does **not** mean AWS resources have been created or deployed. AWS account configuration, IAM role, Lambda, API Gateway, Secrets Manager values, and provider credentials still need to be applied and verified in the owner's AWS account.
