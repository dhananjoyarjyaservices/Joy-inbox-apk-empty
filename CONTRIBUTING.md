# Contributing to Joy Inbox

## Development branch and pull requests

- Current SaaS development branch: `feature/saas-foundation`.
- The development PR targets `main` and must remain draft until review and release gates are satisfied.
- Keep changes scoped and include regression tests for security, billing, tenant isolation, webhook, media and worker behavior.
- Do not merge, deploy, migrate production data or enable live billing without explicit owner approval.

## Runtime and package managers

- Use Node.js 22 for backend and frontend development.
- Install from committed lockfiles with `npm ci`; do not regenerate lockfiles with a different Node/npm version without reviewing the diff.

## Local checks

Backend tests (Firestore emulator required by the CI workflow):

```sh
npm ci --prefix backend
npx --yes firebase-tools emulators:exec --only firestore --project demo-joy-inbox "npm test --prefix backend"
```

Frontend tests and production build:

```sh
npm ci --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
```

Production Lambda package smoke test (creates `backend/dist/joy-inbox-lambda.zip`; does not deploy):

```sh
npm run package:lambda --prefix backend
```

## Required engineering rules

1. Authenticate every tenant request using a Firebase Admin-verified ID token.
2. Resolve active organization membership and permission server-side; never trust client role or tenant ID alone.
3. Keep tenant reads/writes scoped to the organization path.
4. Add route-inventory classification and tests when introducing HTTP routes.
5. Use idempotency, bounded retries and transaction-backed reservations for outbound messages and usage.
6. Verify Meta/Stripe webhook signatures against the raw request body before processing.
7. Never log credentials, tokens, invitation tokens, message bodies or media bytes.
8. Keep customer media metadata-only; Quick Reply assets are separate user-saved assets and must remain tenant-scoped.
9. Update the release-readiness checklist and architecture docs when implementation status changes.
10. Do not ask for or connect Firebase credentials until repository-only implementation, review and CI work is complete.

## External integration and production boundaries

Use local emulators and mocks for repository tests. Real Firebase, Meta, Stripe, email-provider and AWS staging credentials belong in protected service configuration, not source files or chat messages. Production actions require isolated staging evidence, backup/rollback plans and explicit owner approval.
