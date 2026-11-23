# Joy Inbox deployment preparation: Cloudflare Pages + AWS Lambda

## Confirmed target

- Frontend host: Cloudflare Pages
- Current frontend URL supplied by the project owner: https://final-joy-inbox.pages.dev
- Backend target: AWS Lambda (Node.js 22)
- This document prepares configuration only. It does not deploy, publish, merge the draft PR, or change live AWS/Firebase/Meta settings.

## Cloudflare Pages project settings

Use these settings for the Pages project connected to this repository:

- Root directory: `frontend`
- Build command: `npm run build`
- Build output directory: `dist`
- Runtime / build environment: Node.js 22
- Production branch: do not change until the SaaS branch is approved and the PR is merged.
- Build environment variables: define the required `VITE_*` values in Cloudflare Pages project settings for the production environment. Vite embeds these values into the browser bundle, so they must never contain private keys, Meta access tokens, Firebase Admin credentials, or the tenant encryption key.

Required frontend variables:

- `VITE_FIREBASE_API_KEY`: Firebase Web App API key
- `VITE_FIREBASE_AUTH_DOMAIN`: exact Firebase Authentication domain for the project
- `VITE_FIREBASE_PROJECT_ID`: Firebase project ID
- `VITE_FIREBASE_STORAGE_BUCKET`: Firebase storage bucket name
- `VITE_FIREBASE_MESSAGING_SENDER_ID`: Firebase sender ID
- `VITE_FIREBASE_APP_ID`: Firebase Web App ID
- `VITE_FIREBASE_VAPID_KEY`: Web Push public VAPID key from Firebase Console > Project settings > Cloud Messaging
- `VITE_API_BASE_URL`: deployed AWS Lambda Function URL, with no trailing slash

The repository includes `frontend/public/_redirects` to send client-side React Router paths to `index.html`. Vite is configured to serve from the Pages site root.


## Important: current Pages project is connected to the original repository

The existing production Pages project at `https://final-joy-inbox.pages.dev` is connected to `dhananjoyarjya/Final-joy-inbox`, not this target repository. Commits to `dhananjoyarjyaservices/Joy-inbox-apk-empty` therefore will not trigger builds for that existing project.

**Do not change or disconnect the existing production Pages project during preparation.** Keep it serving the current application.

Recommended safe preview arrangement:

1. In Cloudflare Dashboard > Workers & Pages, create a separate Pages project (for example, `joy-inbox-saas-preview`).
2. Connect GitHub repository `dhananjoyarjyaservices/Joy-inbox-apk-empty`.
3. Set the root directory to `frontend`, build command to `npm run build`, and output directory to `dist`.
4. Configure `feature/saas-foundation` as a preview branch (or allow all non-production branches for previews). Keep the preview project separate from the current production project.
5. Add only staging Firebase and staging Lambda public configuration as `VITE_*` build variables. Never copy server secrets into Pages.
6. Open PR #1 and check whether Cloudflare posts a preview URL/check to that PR. Do not promote the preview to production until the backend, data migration and tenant-security gates pass.

Cloudflare documents that Git-integrated Pages projects can create branch and pull-request preview deployments, and that the repository/project connection is managed under Settings > Builds > Manage. See the official [Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/) and [GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/) guides.

## AWS Lambda environment

Lambda must use Node.js 22 and the deployment package must include the backend dependencies. Configure the following values using AWS Secrets Manager or protected Lambda environment variables:

- Firebase Admin credentials: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (or the supported service-account JSON alternative)
- `TENANT_SECRET_ENCRYPTION_KEY`: random base64-encoded 32-byte key. Keep server-side only; never add it to Cloudflare Pages or any `VITE_*` variable.
- `META_APP_SECRET`
- `WHATSAPP_VERIFY_TOKEN`
- `GRAPH_API_VERSION`
- `CORS_ORIGINS=https://final-joy-inbox.pages.dev`

Legacy `PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` are only for legacy owner-only routes. New tenant connections should use organization-encrypted credentials.

## Current deployment blockers

1. No AWS deployment connector/credentials or deployment workflow is available in this repository session. The existing Lambda cannot safely be updated from here.
2. `backend/package-lock.json` is absent. Generate and commit a real lockfile before producing a reproducible Lambda package; do not hand-write one.
3. The actual Cloudflare Pages project settings and its currently deployed commit have not been verified. The supplied URL alone does not prove that this GitHub repository/branch is connected.
4. The current Lambda Function URL in the old frontend example was not validated as the correct deployed SaaS API. Set `VITE_API_BASE_URL` only after confirming the intended Lambda Function URL.
5. Firebase project values and the VAPID public key must be copied from the correct Firebase Web App configuration. The example file intentionally uses placeholders.
6. The tenant encryption key must be provisioned securely in AWS before onboarding/WhatsApp connection routes can store tenant credentials.
7. Firestore rules, webhook tenant routing, legacy route exposure, migration/rollback, media proxy behavior and real Meta/Firebase integration tests still require a security and production-readiness review.

## Safe rollout sequence

1. Verify the Cloudflare Pages project is connected to this target repository and confirm its build settings.
2. Generate and commit the backend lockfile; package and test the Lambda artifact with Node.js 22.
3. Configure secrets and CORS on a staging Lambda; do not copy secrets into GitHub.
4. Deploy the backend to a staging Lambda and test authentication, tenant membership, message routes, webhook signature/routing, media proxy and CORS.
5. Deploy a preview build to Cloudflare Pages with staging API/Firebase configuration and test signup, workspace setup and tenant isolation.
6. Review Firestore/storage rules and complete the owner data migration plus rollback snapshot.
7. Only after all checks pass, approve/merge the draft PR and explicitly authorize production cutover.

## Current status

Preparation changes on the feature branch configure the Vite root path, Cloudflare Pages SPA fallback, and safe environment-variable examples. This is not a production deployment and the SaaS branch is not certified production-ready.


## Scheduled SLA push alerts (AWS EventBridge)

The backend now exports a separate Lambda entry point for scheduled checks. This lets overdue alerts run even when every agent has closed Joy Inbox.

1. Deploy the backend package to the same Node.js 22 Lambda that has Firebase Admin credentials and FCM service-account permissions.
2. Create an EventBridge Scheduler schedule, for example `rate(1 minute)`, with flexible time window disabled.
3. Choose the target Lambda function and set the target invocation payload to an empty JSON object: `{}`.
4. In the Lambda runtime configuration, set the handler to `src/index.slaScheduledHandler`. If the same Lambda must also serve HTTP Function URL requests, deploy a second Lambda function from the same code and configure its handler as `src/index.slaScheduledHandler`; keep the HTTP function on `src/index.handler`.
5. Allow EventBridge Scheduler's execution role to invoke only that scheduled Lambda using `lambda:InvokeFunction`. Do not expose the scheduled handler through a public Function URL or HTTP route.
6. Set a timeout appropriate to organization volume (start with 60 seconds) and monitor CloudWatch logs and Lambda errors/throttles.

The scheduled runner scans organizations in pages and checks up to 1,000 overdue chats per organization per invocation. It uses the same per-chat transactional claim fields as the interactive checker to avoid duplicate notifications when both paths run. A chat is marked notified only after FCM reports at least one successful device delivery; failed/no-device deliveries remain eligible for a later check.

**Not deployed:** adding this code does not create the EventBridge schedule, change Lambda runtime settings, or deploy AWS resources. Until the schedule and dedicated scheduled Lambda target are configured, background SLA alerts will not run when all clients are closed.
