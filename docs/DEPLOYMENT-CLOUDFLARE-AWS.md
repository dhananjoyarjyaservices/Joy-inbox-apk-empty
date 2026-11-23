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

The backend exports a separate Lambda entry point for scheduled checks. It runs overdue SLA push alerts and due delayed automation replies even when every agent has closed Joy Inbox.

1. Deploy the backend package to the same Node.js 22 Lambda that has Firebase Admin credentials and FCM service-account permissions.
2. Create an EventBridge Scheduler schedule, for example `rate(1 minute)`, with flexible time window disabled.
3. Choose the target Lambda function and set the target invocation payload to an empty JSON object: `{}`.
4. In the Lambda runtime configuration, set the handler to `src/index.slaScheduledHandler`. If the same Lambda must also serve HTTP Function URL requests, deploy a second Lambda function from the same code and configure its handler as `src/index.slaScheduledHandler`; keep the HTTP function on `src/index.handler`.
5. Allow EventBridge Scheduler's execution role to invoke only that scheduled Lambda using `lambda:InvokeFunction`. Do not expose the scheduled handler through a public Function URL or HTTP route.
6. Set a timeout appropriate to organization volume (start with 60 seconds) and monitor CloudWatch logs and Lambda errors/throttles.

The scheduled runner scans organizations in pages and checks up to 1,000 overdue chats per organization per invocation. The same invocation processes up to 50 due automation reply steps (scanning at most 200 queued records) from the organization automation queues. It uses the same per-chat transactional claim fields as the interactive checker to avoid duplicate notifications when both paths run. A chat is marked notified only after FCM reports at least one successful device delivery; failed/no-device deliveries remain eligible for a later check.

When a push cannot be delivered, the checker releases its temporary claim and stores an exponential retry delay (1, 2, 4, 8, 16, 32, then up to 60 minutes). Successful delivery clears the retry counter and records `slaOverdueLastDeliveredAt`. Reassigning a chat resets its retry state so the new assignee is not held behind the previous assignee's backoff. Retry fields are stored on the chat document; no separate queue service is required.

### Per-agent notification preferences

Each workspace member can manage their own Assignment, Status update, and SLA alert preferences from the Notification Center. Preferences are stored at `organizations/{organizationId}/members/{uid}/settings/notifications`, defaulting to enabled when no saved settings exist. Authenticated endpoints: `GET /organizations/notifications/preferences?organizationId=...` and `PUT /organizations/notifications/preferences` with `organizationId` and boolean `assignment`, `status`, and `sla` fields. The notification feed filters categories using these preferences, and both the scheduled SLA runner and interactive SLA checker skip push delivery when that agent has disabled SLA alerts. These are per-member settings and do not change workspace-wide SLA configuration.

### In-app Notification Center

The inbox includes a Notifications tab. It combines assignment/status activity from workspace audit logs with SLA push events saved under `organizations/{organizationId}/members/{uid}/notifications`. Selecting a notification marks it read and opens the related chat. The feed refreshes every 30 seconds while open, supports All/Unread/Assignments/Status/SLA filters, and provides Mark all read. The API is `GET /organizations/notifications?organizationId=...` and `POST /organizations/notifications` with `{ organizationId, notificationId }`. Each user can only read and mark their own workspace notifications through the authenticated membership check. SLA history is persisted only after FCM reports at least one successful device delivery; if writing the history record fails, the already-delivered alert is not retried solely because of that history-write failure.

### Organization SLA settings

Workspace owners and admins can open Inbox → Settings → SLA alerts to enable or disable overdue push alerts and select a first-response target from 1 to 120 minutes. Settings are stored at `organizations/{organizationId}/settings/sla`; workspaces without a saved setting retain the default of enabled with a 5-minute target. Both the interactive checker and scheduled runner read this same setting, and first-response analytics store the configured target with each response metric. Agents can view the setting but cannot change it.

**Not deployed:** adding this code does not create the EventBridge schedule, change Lambda runtime settings, or deploy AWS resources. Until the schedule and dedicated scheduled Lambda target are configured, background SLA alerts will not run when all clients are closed.

Notification delivery controls are stored per organization member at `organizations/{orgId}/members/{uid}/settings/notifications`. `soundEnabled` controls the foreground inbox chime; `desktopEnabled` controls browser notification display when browser permission is granted. FCM data messages carry these per-recipient flags so the service worker can suppress desktop notifications or mark them silent. Browser/OS permission settings remain authoritative.

### Registered push devices and delivery retries

Each member can view and revoke up to 50 recently active browser/device registrations in Notification Center. Device records are scoped to that member and organization; the API returns device label, platform, user agent summary, and timestamps, never the FCM token. Removing a device deletes its token registration. Re-registering a browser refreshes its last-active timestamp and metadata. FCM multicast delivery retries once after a short delay for transient server/internal/unknown errors; invalid or unregistered tokens are removed automatically. Persistent failures are not reported as delivered.

### Notification delivery monitoring

Push delivery attempts for tenant incoming-message and SLA alerts are recorded per member at `organizations/{organizationId}/members/{uid}/notificationDeliveries`. The authenticated `GET /organizations/notifications/deliveries?organizationId=...` endpoint returns at most the latest 100 records for the requesting member, including delivered/failed status, attempt count, timestamp, notification type, and provider error code. FCM registration tokens are never included. Transient retries are reflected in the final per-device status; log-write failures are warned in CloudWatch and do not change FCM delivery outcomes.


### Delivery log filters and CSV export

The Notification Center delivery monitor supports client-side filtering by final status (delivered/failed), notification type (incoming message/SLA), text or error-code search, and inclusive local date range. Export CSV downloads only the currently filtered rows from the latest 100 entries returned by the API. The export is generated in the browser and is not uploaded to another service.


### Notification delivery analytics

The Notification Center summarizes the latest 100 per-device delivery records: delivered count, failed count, delivery percentage, records requiring a retry, and total send attempts. A seven-day daily trend separates successful and failed records. These are client-side summaries of the bounded API response, not organization-wide lifetime totals; FCM accepted/successful status does not prove that a person viewed or opened a notification.

### Team notification delivery analytics

Workspace owners and admins can request `GET /organizations/notifications/team-deliveries?organizationId=...`. The endpoint is restricted to owner/admin roles and reports per-active-member push delivery aggregates (delivered, failed, retried records, attempts, and delivery rate). It reads at most 50 member documents and the latest 100 delivery records for each member. The UI displays this table in Notification Center; agents continue to see only their own delivery history. This is an independently sampled recent window per member, not a lifetime or cross-member time-aligned total. FCM delivery success does not establish that a recipient opened or read a notification.

The team analytics endpoint also accepts optional inclusive `from=YYYY-MM-DD` and `to=YYYY-MM-DD` query parameters. The UI date controls request the selected range from the API and can export the currently displayed per-member aggregates to CSV. Each member query is bounded to 500 records in the selected range; the UI should be understood as a sampled report when this cap is reached, not a lifetime total.

Team delivery analytics also groups the sampled delivery records by notification type (for example, incoming message and SLA push), both per active member and across the displayed team. The CSV export includes per-member message and SLA delivered/failed counts. Unknown future notification types remain available in the type breakdown rather than being discarded.

Workspace owners and admins can inspect an individual active or existing member's notification delivery report with `GET /organizations/notifications/member-deliveries?organizationId=...&uid=...`. Optional `from` and `to` date filters use inclusive calendar dates. The response includes aggregate delivery rate, delivered/failed/retried counts, notification-type breakdown, and up to 200 recent delivery records (type, status, attempts, error code, timestamp). Access is restricted to owners/admins with `chats:read`; the member must belong to the selected workspace. No FCM tokens are returned. A `capped` flag indicates when the latest-200 limit was reached.

## Keyword automation rules

Workspace owners and admins can manage up to 100 rules through the authenticated `/organizations/automation-rules` endpoint (GET, POST, PUT, DELETE). Rules are stored under `organizations/{organizationId}/automationRules` and contain a name, keyword, match mode (`contains`, `exact`, or `starts_with`), reply text (maximum 1,024 characters), enabled state, and priority (lower numbers run first).

For each newly persisted inbound WhatsApp text message, the webhook checks up to 100 rules and runs only the first enabled match. Media-only messages do not trigger keyword rules. A run record keyed by the inbound message and rule prevents duplicate replies when Meta retries the same webhook. Replies are sent only inside WhatsApp's 24-hour customer service window; out-of-window matches are recorded as skipped. Automation send failures are recorded and logged without causing Meta to retry an already-saved inbound message. This is a first keyword-auto-reply milestone, not yet a visual workflow builder or multi-step chatbot.

### Multi-step automation reply sequences

Each keyword automation rule can now contain one to five ordered text reply steps. The webhook sends the steps in order and records progress, completed step count, message IDs, and final status in the automation run. If a later step fails after earlier replies were sent, the run is marked `partially_failed` and is not automatically replayed, preventing duplicate sends on webhook retries. Existing single-response rules remain compatible. Steps are sent immediately; timed delays, branching, non-text actions, and a drag-and-drop canvas are not part of this release.

### Automation execution history

Owners and admins can read the latest 50 workflow runs through `GET /organizations/automation-runs?organizationId=...`. The endpoint returns rule name, customer phone, run status, completed/total steps, error or skip reason, and timestamps. The builder displays this recent history; it is a rolling latest-50 view, not a long-term analytics export.

### Delayed automation replies

Keyword automation steps can specify a wait in seconds before each later reply (0 to 86,400 seconds). The first reply is sent from the inbound webhook; later steps are stored in `organizations/{organizationId}/automationQueue` and delivered by `src/index.slaScheduledHandler`. Configure the EventBridge schedule above at `rate(1 minute)` for minute-level scheduling. A queued reply is skipped when its originating WhatsApp 24-hour customer-service window has expired. The scheduler processes up to 50 due steps per invocation and scans at most 200 queued records; increase capacity only after load testing. Failed queued steps are marked failed/partially_failed for operator review and are not automatically retried. A worker lease reduces concurrent duplicate processing, but external send success followed by a process crash before Firestore commit can still cause a duplicate on a later lease expiry; monitor CloudWatch and run history. This is scheduled delivery, not an exact-to-the-second timer.

