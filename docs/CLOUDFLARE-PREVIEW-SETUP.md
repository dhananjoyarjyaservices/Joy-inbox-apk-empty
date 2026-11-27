# Cloudflare Pages preview setup

The feature preview is deployed from `feature/saas-foundation` to the Cloudflare Pages project `joy-inbox-apk-empty`.

## Preview URL

- Branch alias: https://feature-saas-foundation-8l1r.joy-inbox-apk-empty.pages.dev
- Production project domain: https://joy-inbox-apk-empty.pages.dev (not changed by the preview workflow)

## GitHub Actions secrets

Configure these repository Actions secrets:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Account / Cloudflare Pages / Edit permission, scoped to the intended account.
- `CLOUDFLARE_ACCOUNT_ID`: 32-character Cloudflare Account ID.

Do not commit credentials or paste them into issues, pull requests, or chat.

## Frontend Actions variables

The frontend build reads the following repository Actions variables. They are currently optional to the build but required for Firebase-backed runtime features:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_VAPID_KEY`
- `VITE_API_BASE_URL`

Use the corresponding values from the Firebase Web App configuration, Firebase Cloud Messaging Web Push certificate, and the deployed AWS Lambda Function URL. See `frontend/.env.example` for the expected formats. Firebase web configuration values are client-side values, but restrict the API key by HTTP referrer in Google Cloud.

## Runtime readiness

A successful Cloudflare upload proves that the static frontend build was uploaded. It does not prove Firebase Authentication, Firestore, push notifications, or the AWS API are connected. After configuring the variables, rerun the Cloudflare Pages workflow and complete the staging checks in `docs/RELEASE-READINESS.md`.

The feature branch deploys to a preview alias only. It does not publish the feature branch to the production Pages domain.
