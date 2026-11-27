# Joy Inbox staging and production operations runbook

This is an operational checklist for the first isolated staging rollout and eventual production service. It is not evidence that any AWS, Firebase, Meta or Stripe resources have been deployed.

## Release and environment boundaries

- Keep development, staging and production Firebase projects, Meta apps/WABAs, Stripe modes, Lambda functions and secrets separate.
- Use Node.js 22 for all Joy Inbox Lambda functions.
- Keep the draft PR open until all repository checks and staging gates pass.
- Never enable legacy owner-only HTTP routes except during an approved, time-limited migration window.
- Keep history-retention schedule disabled until backup/restore tests and retention cutoffs pass.
- Do not expose scheduled worker Lambda Function URLs.
- Do not store inbound customer media bytes in Joy Inbox storage. The tenant webhook stores metadata/Meta media IDs; previews are fetched from Meta through the authenticated bounded proxy.

## Required telemetry and alarms

Before accepting real customers, create CloudWatch dashboards and alarms for each HTTP and scheduled Lambda:

- Lambda Errors, Throttles, Duration (p95 and maximum), ConcurrentExecutions and invocation count.
- EventBridge failed invocations, missed schedule targets and target delivery failures.
- API 4xx/5xx rates separated by route family; do not alert on expected authentication/validation 4xx at the same threshold as server errors.
- Meta webhook signature failures, duplicate/replayed events, retry volume and sustained delivery-status lag.
- Stripe webhook signature failures, unprocessed/leased event age, failed invoices and subscription-state drift.
- Campaign/automation queue age, failed/uncertain deliveries, expired leases and repeated rate limits.
- Firestore transaction contention/aborts, query/index failures and elevated read/write volume.
- FCM delivery failures and invalid-token cleanup.
- History-retention deletions, oldest eligible record age, worker errors and schedule state.

Alert destinations, thresholds, dashboards and on-call owners must be agreed and tested in staging; this repository does not configure them automatically.

## First staging acceptance sequence

1. Confirm the latest source commit has successful backend emulator tests, frontend tests/build, route-inventory checks and Lambda ZIP packaging.
2. Provision isolated staging AWS resources and secrets. Keep production resources unchanged.
3. Connect the isolated Firebase staging project only after repository-only work is signed off. Deploy indexes/rules and verify workspace creation, membership isolation, invitation lifecycle, contacts, Quick Replies and media policy.
4. Connect Meta test assets and verify webhook signature, Phone Number ID routing, duplicate/retry handling, text/media/template/interactive sends and delivery status reconciliation.
5. Connect Stripe test mode with all ten monthly/annual Price IDs and verify one-time seven-day trial, checkout, portal, renewals, cancellation, failed invoices and hard usage blocking.
6. Configure transactional invitation email and verify delivery, failure reporting and manual-link fallback.
7. Deploy API and private worker Lambdas. Verify each handler with a non-production tenant and confirm EventBridge targets, permissions and logs.
8. Test concurrency, quota races, seat caps, campaigns, STOP/START suppression, pause/cancel, uncertain sends, SLA notifications, delayed automation and history-retention cutoffs.
9. Take a staging backup and complete a restore into an isolated test target. Verify tenant boundaries and representative chat/message counts.
10. Test mobile browsers, keyboard-only navigation, screen-reader labels, reduced-motion behavior and responsive breakpoints.
11. Record evidence, outstanding risks, rollback steps and owner approval before any production action.

## Incident triage

### API errors or elevated Lambda failures
- Identify the route family and correlation/request ID from logs.
- Confirm the failure is not an expected 401/403/409/429 response.
- Check Firebase Admin credentials, Firestore index errors, Meta/Stripe availability and configured environment variables.
- Roll back to the last known-good Lambda version if the failure is release-related; do not change tenant data or secrets blindly.
- Preserve logs and the failed request's safe metadata. Never log or paste access tokens, invitation tokens, full message bodies or media bytes.

### Meta webhook delivery or duplicate events
- Verify the raw-body signature check and current app secret before processing.
- Confirm metadata.phone_number_id maps to the expected active workspace.
- Use the persisted webhook/message idempotency record to distinguish a retry from a new event.
- Do not manually replay an event until tenant routing and duplicate behavior are understood.
- For uncertain outbound sends, reconcile with Meta's message status before retrying; do not automatically send again if Meta may already have accepted it.

### Stripe billing mismatch
- Verify the Stripe signature before processing or replaying an event.
- Inspect the event lease/processed record and workspace subscription record.
- Confirm the event's customer/subscription metadata resolves to the correct workspace.
- Reconcile with Stripe's current subscription/invoice state; do not manually grant entitlements or edit usage counters without an audited recovery plan.
- Keep outbound usage blocked if the active subscription cannot be verified.

### Campaign or automation worker failure
- Inspect queue state, lease expiry, retry count, recipient suppression state and last provider result.
- Respect uncertain states: an external send may have succeeded even if the local commit did not.
- Do not bulk-reset uncertain recipients or queue records. Reconcile provider status and obtain owner approval for any manual retry.
- Pause or cancel the campaign/worker schedule if duplicate-send risk is suspected.

### History-retention or migration incident
- Disable the retention schedule immediately if unexpected deletion is observed.
- Preserve system-job cursor/state, worker logs and the affected workspace/plan identifiers.
- Restore only from a verified backup into an isolated recovery project first; verify data before any production restore.
- Never rerun the legacy migration with execute without a fresh backup, dry-run review, rollback snapshot and explicit owner approval.

## Secret rotation and recovery

- Rotate Meta access tokens and app secrets in the provider console, then update the matching backend secret configuration and verify webhook/send behavior in staging.
- Rotate Stripe API/webhook secrets using overlapping staged rollout where supported; verify signatures before removing the old secret.
- Tenant encryption key rotation must preserve old keys in the keyring until all records are re-encrypted and verified. Use the controlled rotation helper and never log plaintext credentials.
- Campaign suppression HMAC key changes require a planned migration of suppression document IDs; do not replace the key in only one worker.
- Revoke exposed credentials immediately and review audit/access logs for unauthorized use.

## Rollback checklist

- Identify the last known-good frontend deployment and Lambda version.
- Stop scheduled workers/campaign schedules if they are causing duplicate or destructive behavior.
- Restore the previous Lambda version and frontend preview/production version without changing Firestore rules or customer data unless required.
- Verify auth, workspace membership, inbound webhook routing, text messaging, billing entitlements and message history.
- Record any messages with uncertain delivery; do not blindly resend.
- Keep the incident open until the owner approves data reconciliation and customer communications.

## Production cutover approval

Production cutover requires:
- All staging acceptance evidence and rollback rehearsal.
- Privacy, consent, WhatsApp template-policy, billing/tax and support review.
- Monitoring, alarms, incident owners and runbooks tested.
- Firestore backup and migration dry-run signed off.
- Explicit owner approval to mark the PR ready, merge, deploy production resources, enable schedules, change Meta webhooks or enable Stripe live payments.
