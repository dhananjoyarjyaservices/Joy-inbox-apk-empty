# AWS data-plane migration — implementation contract

**Status:** design and migration contract only. This document does not claim that the application has been migrated, that AWS resources are connected, or that customer data is safe to cut over.

## Target architecture

- Firebase Authentication remains the identity provider. The backend verifies Firebase ID tokens and uses the verified UID as the actor identity.
- DynamoDB becomes the system of record for tenant/workspace, membership, customer/CRM, conversation/message, billing-usage and operational records.
- Private S3 becomes the durable object store for inbound customer media and saved Quick Reply images.
- AWS Lambda remains the API and worker runtime. Cloudflare Pages remains the frontend host.
- Firestore and Firebase Storage are not to be removed until the DynamoDB/S3 implementation passes staging acceptance and a rollback rehearsal.

## Existing implementation that must be replaced

The current branch still uses `firebase-admin/firestore` throughout the API, tenancy, billing, CRM, campaigns, automations, messaging and retention modules. `backend/src/media.js` uses Firebase Admin Storage through `FIREBASE_STORAGE_BUCKET`. Workspace creation in `backend/src/organizations.js` is a Firestore transaction. The existing retention worker in `backend/src/historyRetention.js` scans Firestore organization/chat/message collections and deletes message documents only.

This is a cross-cutting data-layer migration, not a configuration-only switch. Do not change only `media.js` and declare the SaaS migrated.

## Verified provisioned DynamoDB schema (AWS console screenshots, 2026-11-26)

All three existing tables were inspected in the AWS console in region `ap-south-1` (Asia Pacific — Mumbai).

| Logical table | Exact table name | Partition key | Sort key | GSIs | Vector indexes | Capacity | PITR |
|---|---|---|---|---:|---:|---|---|
| Workspaces | `JoyInboxWorkspaces` | `PK` (String) | `SK` (String) | 0 | 0 | On-demand | Off |
| Customers | `JoyInboxCustomers` | `PK` (String) | `SK` (String) | 0 | 0 | On-demand | Off |
| Messages | `JoyInboxMessages` | `PK` (String) | `SK` (String) | 0 | 0 | On-demand | Off |

The console showed all three tables Active and empty (item count 0) at inspection time. No table settings or indexes were changed during inspection.

**What this verifies:** the adapter's primary-key attribute names `PK` and `SK` match the provisioned tables, and there are currently no GSIs available for alternate access patterns. The screenshots do **not** reveal the intended PK/SK value conventions, item attribute shapes, encryption configuration, or application access patterns. Those must be confirmed from the application data contract before production queries or writes are enabled.

**Operational warning:** point-in-time recovery is Off on all three tables. Enable PITR and verify backup/recovery policy before storing production customer or message data. This documentation update does not change AWS settings.

## DynamoDB logical ownership

Use the three already-provisioned DynamoDB tables only after their exact names, partition/sort keys, GSIs, billing mode, encryption and region have been inspected and recorded. Do not create replacement tables or assume key names from this document.

The logical item ownership must be:

| Logical entity | Required attributes |
|---|---|
| Workspace | organizationId, status, plan, createdAt, updatedAt |
| Membership | organizationId, uid, role, status, joinedAt |
| User workspace index | uid, organizationId, status, role |
| Customer | organizationId, customerId, normalized phone, profile fields, tags |
| Conversation | organizationId, conversationId, customerId, phoneNumberId, status, assignment, timestamps |
| Message | organizationId, conversationId, messageId, direction, type, timestamp, delivery state, media metadata |
| Subscription and usage | organizationId, plan, status, billing period, counters, reservations |
| Idempotency / jobs | tenant scope, operation key, state, cursor, lease/expiry |

Every tenant-owned item must include an organization identifier in its key or in a key condition that is enforced by the repository layer. Never query across tenants and filter afterward. All tenant APIs must derive the actor UID from the verified Firebase token and validate membership/role before reading or writing tenant items.

## S3 object layout and security

Use a private bucket with Block Public Access enabled, bucket-owner-enforced object ownership, server-side encryption, TLS-only bucket policy and no public ACLs. Store objects using generated keys; never use customer-provided filenames as object keys.

Recommended key convention:

`tenants/{organizationId}/customers/{customerId}/messages/{messageId}/{randomObjectId}`

Quick Reply images:

`tenants/{organizationId}/quick-replies/{quickReplyId}/{randomObjectId}`

Store the S3 bucket/key, verified MIME type, byte size, SHA-256, original display filename (sanitized), createdAt, customerId, conversationId, messageId and retention expiry in the corresponding DynamoDB message/item metadata. Do not store permanent public URLs. Generate short-lived presigned URLs only after verifying workspace membership and resource ownership.

Inbound WhatsApp media flow:
1. Verify webhook signature and resolve the connected phone number to exactly one workspace.
2. Persist the webhook event/idempotency claim before processing to prevent duplicate downloads.
3. Fetch media metadata and bytes from Meta using that workspace's encrypted WhatsApp credentials.
4. Enforce provider size limits, actual byte limit, allowlisted MIME types and file-signature validation.
5. Reserve the workspace's media quota atomically before committing an S3 object; settle or release the reservation on success/failure.
6. Upload to the tenant-prefixed S3 key, then write message metadata to DynamoDB with an idempotent transaction/state transition.
7. On partial failure, leave a recoverable processing record and run a cleanup/retry worker; do not silently lose the message or double-count usage.

## Plan policy to enforce

| Plan | Monthly price | Stored media cap | Retention |
|---|---:|---:|---:|
| Lite | ₹299 | 1 GB | 3 months |
| Starter | ₹599 | 3 GB | 6 months |
| Growth | ₹999 | 6 GB | 12 months |
| Business | ₹1,499 | 6 GB | 12 months |
| Pro | ₹1,999 | 15 GB | 12 months |

Annual prices: Lite ₹2,990; Starter ₹5,990; Growth ₹9,990; Business ₹14,990; Pro ₹19,990. Annual billing charges 10 months for 12 months of service. Meta WhatsApp charges remain paid directly by the customer.

Distinguish stored-media capacity from monthly media transfer. The existing billing document currently defines transfer allowances; it does not yet implement the stored-media caps above. Implement separate counters: current stored bytes/object count and period transfer bytes. Enforce the stored cap transactionally before upload. A failed/ambiguous upload must reconcile by checking the S3 object and reservation record, not by blindly charging or releasing.

Retention expiry must be calculated from each media object's creation time and the workspace's contracted retention policy. Deletion worker must:
- page tenant items safely with a durable cursor;
- identify expired message media and Quick Reply images;
- delete S3 objects idempotently;
- mark/delete corresponding DynamoDB metadata only after object deletion is confirmed or object is already absent;
- reconcile orphaned S3 objects and dangling metadata;
- record counts/errors and continue bounded batches;
- preserve non-media message metadata only if the product's message-history policy requires it.

Do not configure an S3 lifecycle rule that deletes all tenant objects on a single fixed schedule: plans have different retention periods. Use per-object `expiresAt` metadata and a scheduled worker, or apply plan-specific S3 object tags/lifecycle policies only after proving tag updates and downgrade behavior are correct.

## Required backend modules and migration sequence

1. Inspect the three actual DynamoDB table schemas and write a schema contract with their real table names, PK/SK names, GSIs, region and billing mode.
2. Add AWS SDK v3 dependencies and regenerate `backend/package-lock.json` using Node.js 22; CI must run `npm ci`.
3. Add a centralized DynamoDB document client, conditional-write helpers, pagination helpers and tenant-scoped repository interfaces.
4. Migrate tenancy, organization onboarding, membership, invitations and encrypted WhatsApp connection storage.
5. Migrate inbox, chat actions, messages, contacts, CRM, quick replies, internal notes, notifications, automation, campaigns, SLA, billing and idempotency modules. Preserve transactional usage enforcement and concurrency guarantees.
6. Implement S3 media repository, inbound webhook ingestion, secure presigned read, saved Quick Reply image storage, deletion and orphan reconciliation.
7. Migrate scheduled workers, including message-history and media-retention workers; add EventBridge templates and least-privilege IAM policies.
8. Add DynamoDB Local or AWS SDK mock tests, S3 mock tests, tenant-isolation tests, duplicate webhook tests, quota race tests, partial-failure/retry tests, retention boundary tests and frontend contract tests.
9. Add a dry-run export/import and reconciliation tool from Firestore to DynamoDB/S3. Do not delete source records during initial migration.
10. Run isolated staging, backup/restore and rollback rehearsal. Only then approve production cutover and eventual retirement of Firestore/Storage data access.

## Required environment variables (server-side only)

- `AWS_REGION`
- `DYNAMODB_WORKSPACES_TABLE`
- `DYNAMODB_CUSTOMERS_TABLE`
- `DYNAMODB_MESSAGES_TABLE`
- `S3_MEDIA_BUCKET`
- Existing Firebase Admin credentials remain temporarily required for Firebase Auth token verification.
- Existing Meta, Stripe and tenant encryption secrets remain in AWS Secrets Manager or protected Lambda environment variables.

Never expose AWS credentials, Firebase Admin credentials, Meta access tokens, Stripe secrets or tenant encryption keys in Cloudflare `VITE_*` variables or Git.

## Cutover gates

No production cutover until:
- real table names/keys/indexes and AWS region are verified;
- all tenant routes and background workers use repositories, with no unintended Firestore data access;
- automated tests and CI pass;
- media quotas and plan retention match the approved policy;
- webhook idempotency, S3 partial failure and duplicate processing are tested;
- DynamoDB PITR/backups and S3 recovery/versioning policy are tested;
- least-privilege IAM and tenant isolation review pass;
- data migration reconciliation and rollback are signed off.

**Current blocker:** the exact table names and key/index definitions are not available in the repository. They must be inspected from the actual AWS console before writing production repository key expressions. Guessing them would risk data corruption or cross-tenant access.
