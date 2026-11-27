# Security policy

## Supported branch

Security fixes should target the active development branch, `feature/saas-foundation`, until the SaaS migration pull request is reviewed and merged. Do not assume the development branch is production-ready.

## Reporting a vulnerability

Do not open a public issue containing exploitable details, credentials, customer data, access tokens, or proof-of-concept payloads. Use GitHub's private vulnerability reporting for this repository, or contact the repository owner through a private channel.

Include the affected component/path, impact, reproduction steps that do not expose real customer data, and a suggested mitigation if known.

## Secret handling

Never commit:
- Firebase service-account JSON/private keys or Admin credentials.
- Meta/WhatsApp access tokens, app secrets or webhook verification tokens.
- Stripe API keys, webhook signing secrets or real Price IDs if they are treated as private configuration.
- Tenant encryption keys, campaign suppression HMAC keys, FCM private credentials or customer exports.

Server secrets belong in AWS Secrets Manager or protected backend runtime configuration. Browser `VITE_*` values are public and must never contain server secrets. If a secret is exposed, revoke/rotate it immediately and review access logs.

## Tenant isolation and media

- Every tenant API route must verify the Firebase ID token, active organization membership and permission.
- Resolve webhook tenants only from Meta Phone Number ID mappings.
- Keep invitations, billing records, audit logs, send idempotency records and WhatsApp credentials server-only.
- Do not persist customer media bytes to Firebase Storage, S3, local disk or Lambda temporary storage. Use the authenticated bounded Meta media proxy.
- Keep legacy owner-only routes fail-closed; do not enable `LEGACY_OWNER_API_ENABLED` outside a controlled migration window.

## Release safety

CI success is not production acceptance. Require isolated staging, backup/restore rehearsal, tenant-isolation and concurrency review, and explicit owner approval before production migration, live billing, webhook changes, worker activation or deployment.
