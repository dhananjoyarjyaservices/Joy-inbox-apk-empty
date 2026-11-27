# Joy Inbox AWS-Native Backend Migration

Status: migration required; this document is the implementation contract for the AWS target. It does not claim that the migration or AWS deployment is complete.

## Owner decision

Joy Inbox customer/business data must be stored in AWS, not Firebase. The existing Firebase-backed implementation is legacy source code to migrate; it is not the target architecture. Do not request or add Firebase credentials to the new Lambda deployment. Do not deploy the current Firebase-dependent ZIP as the target backend.

## Target architecture

- AWS Lambda (Node.js 22.x): HTTP API and scheduled workers.
- Amazon DynamoDB: tenant, workspace, membership, chats, messages, contacts, CRM, campaigns, templates metadata, automation, webhook delivery, billing metadata, quotas, usage, idempotency and audit records.
- Amazon S3: private customer media (images, video, audio, documents and uploaded assets), with tenant-scoped object keys, encryption, lifecycle/retention and signed access.
- AWS Cognito: proposed AWS-native user identity provider; confirm pool/app-client design and migration strategy before production cutover. Lambda must verify Cognito JWTs and map Cognito subject IDs to tenant memberships.
- AWS Secrets Manager: server-side Meta/WhatsApp, Stripe and application encryption secrets. Lambda execution role receives read access only to the specific secret ARNs required by that function.
- Amazon EventBridge: scheduled workers (campaign, automation, SLA, CRM follow-up and retention) with schedules disabled until staging verification.
- Amazon CloudWatch: logs, metrics and alarms.
- API Gateway: HTTPS API entry point; configure CORS to exact frontend origins and route to Lambda.
- AWS KMS / S3 SSE: encryption at rest. S3 public access remains blocked.

Region: ap-south-1 (Mumbai), consistent with the owner-created Lambda and existing AWS resource context.

## Existing AWS resource facts supplied/observed

- Existing DynamoDB table previously created by the owner: `JoyInboxMessages`, partition key `PK` (String), sort key `SK` (String), status Active.
- Lambda function created in the owner account: `joy-inbox-api`, region `ap-south-1`, Node.js 22.x, 512 MB memory, 30-second timeout.
- Lambda execution role currently has only `AWSLambdaBasicExecutionRole` (CloudWatch Logs).
- Do not assume an S3 bucket, Cognito user pool, API Gateway, Secrets Manager secret, EventBridge rules or additional DynamoDB tables already exist. Verify before referencing them in IAM policies.

## Legacy implementation audit (feature/saas-foundation)

The current backend is Firebase-dependent:
- `backend/src/firebase.js` initializes Firebase Admin using service-account environment variables and exposes Firestore.
- `backend/src/index.js` imports Firebase Admin and uses Firebase ID-token verification for authentication.
- `backend/src/organizations.js`, `tenancy.js`, `tenantResources.js`, `tenantMessaging.js` and numerous domain modules use Firestore collection/document/query/transaction/batch APIs.
- `backend/src/media.js` stores and deletes message media through Firebase Admin Storage.
- `backend/package.json` currently depends on `firebase-admin`; the current Lambda package is therefore not AWS-native.
- `backend/src/historyRetention.js` deletes old message documents through Firestore. It must be rewritten against DynamoDB and S3 retention policy before its schedule is enabled.

This is a cross-cutting data/auth migration, not an environment-variable-only change. Existing Firestore collection semantics, document IDs, transactions, pagination, atomic updates and security checks must be deliberately mapped to DynamoDB access patterns and conditional/transactional writes.

## Data model migration requirements

Use tenant isolation in every key and every query. Never perform unbounded table scans in request paths. Define and document access patterns before creating tables.

Initial access-pattern inventory:
- Tenant/workspace and membership lookup by Cognito subject + organization ID.
- Organization list for a user.
- Workspace settings and encrypted WhatsApp connection lookup by organization + phone number ID.
- Chats/messages by organization + chat + chronological message timestamp/ID.
- Contacts by organization + normalized phone and by name cursor.
- Quick replies, tags, notes, CRM leads, stages, custom fields, saved filters and activity by organization.
- Campaigns, recipients/suppression state, automation rules/runs, SLA settings, scheduled follow-ups.
- API keys (hash only), API usage/rate limits, idempotency keys.
- Webhook subscriptions, delivery queue/history, retry and replay state.
- Billing subscription, plan, quotas, usage reservations and audit history.
- Retention cursors and system job state.

The existing `JoyInboxMessages` PK/SK table must be inspected and its current data/access patterns verified before reuse. Do not silently change its key schema or overwrite existing data. Decide whether to extend this table with GSIs or create purpose-specific tables only after the access-pattern review. Document every table, key, GSI, TTL attribute and billing mode in an infrastructure template.

## S3 media requirements

- Private bucket in ap-south-1; block all public access; enable bucket-owner-enforced object ownership and encryption.
- Object key namespace must include an opaque tenant/workspace ID and validated chat/message/media IDs; never trust client-supplied object keys.
- Store metadata (tenant ID, MIME type, size, checksum, retention expiry) in DynamoDB.
- Use short-lived presigned URLs for authorized uploads/downloads; validate content type, file signature, size and tenant ownership.
- Lifecycle/retention must honor each plan's configured history/media retention and legal/operational holds. Do not enable automatic deletion until staging restore and retention tests pass.
- Avoid storing WhatsApp bearer tokens or other secrets in object metadata.

## Authentication migration requirements

- Confirm AWS Cognito user-pool region, sign-in identifiers, app clients, callback/logout URLs, MFA and password policy.
- Replace Firebase `verifyIdToken` with Cognito JWT verification (issuer, audience/client ID, signature, expiry and token_use).
- Map Cognito `sub` to tenant memberships; enforce current owner/admin/agent role permissions on every request.
- Provide a secure account migration/invitation/reset path. Do not attempt to migrate password hashes from Firebase.
- Keep authentication and authorization separate: a valid JWT alone never grants workspace access.

## Secrets and IAM requirements

- Do not put real credentials in Git, chat, screenshots, frontend variables or source files.
- Store Meta app secret, WhatsApp system credentials where applicable, Stripe secret/webhook secret, tenant-secret encryption keys and webhook signing material in Secrets Manager.
- Use environment variables only for non-secret configuration and secret ARNs/names; retrieve secrets server-side with bounded caching.
- IAM policies must use verified resource ARNs and least privilege. No `AdministratorAccess`, wildcard resource grants or guessed bucket/table/secret names.
- Separate execution roles for API and scheduled workers when practical. Lambda role must not get IAM administration or resource-creation permissions.

## Migration phases and acceptance gates

1. **Inventory and design**: enumerate every Firestore collection, document shape, query, transaction, batch, scheduled job, Firebase Auth dependency and Storage operation. Produce DynamoDB table/key/GSI design and data migration mapping. No production data changes.
2. **AWS infrastructure as code**: define DynamoDB, S3, Cognito, Secrets Manager references, API Gateway, Lambda roles and disabled EventBridge schedules in version-controlled templates. Keep deletion/retention schedules disabled.
3. **AWS adapters**: implement tested repository interfaces for DynamoDB and S3; preserve tenant scoping, conditional writes, idempotency, pagination and concurrency behavior.
4. **Authentication**: implement Cognito JWT verification and tenant membership mapping with tests; provide owner-controlled user migration/onboarding flow.
5. **Domain migration**: migrate organizations/members, WhatsApp connections, chat/messages, contacts/CRM, campaigns, automation, webhooks, billing, quotas, notifications and all remaining modules. Remove Firestore SDK usage only after each module has AWS parity and tests.
6. **Data migration**: build an idempotent export/transform/import tool with counts, checksums, retry logs and reconciliation. Keep source data read-only until acceptance; do not delete Firebase data automatically.
7. **Media migration**: move existing media only if it exists and the owner approves; verify object count, byte count, checksums, metadata and signed access.
8. **Validation**: unit, integration, tenant-isolation, auth, concurrency, quota, idempotency, retention, failure/retry, backup/restore and load tests. Run against isolated AWS staging resources.
9. **Cutover**: owner approval required. Deploy new Lambda package, configure API Gateway/custom domain, frontend API URL and monitoring. Retain rollback path and source snapshots.
10. **Decommission Firebase**: only after owner confirms migration reconciliation, production acceptance and rollback window completion.

## Immediate next implementation tasks

- [ ] Produce a complete Firestore collection/query/transaction inventory across all backend modules.
- [ ] Produce a DynamoDB single-table vs multi-table decision using real access patterns, including the existing `JoyInboxMessages` table.
- [ ] Produce S3 bucket/object/lifecycle design and exact IAM policy ARNs after resources are confirmed.
- [ ] Implement DynamoDB and S3 adapters with unit tests before replacing domain modules.
- [ ] Implement Cognito token verification and tenant identity mapping.
- [ ] Update Lambda packaging to remove Firebase dependencies only after all imports are migrated.
- [ ] Add AWS-native integration tests and disabled-by-default infrastructure templates.

## Implemented adapter progress (feature/saas-foundation)

- [x] Tenant-scoped DynamoDB primitives for messages, customers and workspaces using the existing PK/SK key shape; no GSI required for those partition-local operations.
- [x] Organization and membership repository with user-to-organization lookup rows, transactional member changes, owner protection and atomic seat counter enforcement.
- [x] DynamoDB-backed organization authorization adapter.
- [x] Cognito JWT verifier and opt-in authentication-provider seam; Firebase remains the default until all dependent domains are migrated.
- [x] Private S3 media adapter with tenant-scoped keys, server-side encryption and presigned downloads.
- [x] Tenant-scoped DynamoDB audit event writer and audit listing; member-management factory uses it by default.
- [x] DynamoDB subscription snapshot store with server-verified write gate and trusted plan-catalog seat-limit resolver.
- [x] Leased DynamoDB Stripe webhook event ledger with conditional claims, duplicate/in-progress detection and lease-token guarded completion/failure.
- [ ] Wire the Stripe webhook route to verify signatures, retrieve canonical Stripe subscription state, and persist through `subscriptions.putVerifiedSubscription`; never pass client-supplied plan data.
- [ ] Connect the AWS repositories to migrated domain services and HTTP routes, including the Stripe webhook event ledger.
- [ ] Migrate frontend authentication/session handling and remaining Firestore/Storage modules.
- [ ] Add AWS SDK v3 runtime dependencies and real AWS integration tests against isolated staging resources.
- [ ] Provision and verify actual AWS resources; deploy Lambda and validate the full application flow.

## Current Lambda console instruction

The newly created `joy-inbox-api` Lambda is only a starter function. Keep its basic CloudWatch execution role. Do not add Firebase environment variables, do not paste a broad IAM policy, do not upload the existing Firebase-dependent ZIP, and do not enable public Function URL. Wait until AWS-native code, verified resource names and the staging deployment plan are ready.
