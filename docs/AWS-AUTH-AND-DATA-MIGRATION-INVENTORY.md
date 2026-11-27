# AWS-Native Authentication and Data Migration Inventory

Status: implementation planning based on the current `feature/saas-foundation` source tree. This document is not evidence that AWS resources have been provisioned or that production traffic has migrated.

## Confirmed current-state dependencies

### Frontend authentication
- `frontend/src/context/AuthContext.tsx` imports Firebase Auth `User` and subscribes with `onAuthStateChanged`.
- `frontend/src/services/auth.ts` implements email/password sign-in, email registration, verification email, Google popup sign-in, sign-out, and auth observation using Firebase Auth.
- `frontend/src/firebase/config.ts` initializes Firebase App/Auth from `VITE_FIREBASE_*` variables.
- `frontend/src/firebase/firestore.ts` initializes Firestore for tenant data listeners.
- The frontend deployment validator and Cloudflare workflow currently require Firebase variables. This is consistent with the current source dependencies, even though it conflicts with the agreed AWS-only target.

### Backend authentication and data
- `backend/src/firebase.js` initializes Firebase Admin and exposes Firestore.
- `backend/src/index.js` imports Firebase Admin/Firestore at the API entry point; the health route is intentionally able to respond without initializing Firebase.
- `backend/src/tenancy.js` resolves organization and membership documents from Firestore and relies on a verified Firebase decoded token containing `uid`.
- `backend/src/organizations.js` creates organization, first owner membership, and user-to-organization index in a Firestore transaction.
- `backend/src/media.js` stores and retrieves media through Firebase Admin Storage.
- Numerous domain modules use Firestore collection/document/query/transaction/batch APIs. Replacing only the Firebase initialization file or changing environment variables is not a safe migration.

### AWS migration foundations already committed
- `backend/src/aws/dynamoTenantStore.js`: injected DynamoDB DocumentClient access primitives with organization partition keys and resource sort-key prefixes.
- `backend/src/aws/s3MediaStore.js`: injected private S3 media primitives, tenant-scoped object keys, SSE-S3 upload, and short-lived signed downloads.
- `infra/aws/aws-native-staging.yaml`: proposed private S3 bucket and narrowly scoped Lambda role policy. It is a template, not a deployed stack.
- These adapters are not yet connected to the existing domain routes and do not constitute a production AWS data layer.


## Cognito verifier implementation status (incremental)

- Added `backend/src/aws/cognitoAuth.js`: RS256 signature verification using Cognito's issuer JWKS, strict issuer, app-client ID, `token_use=access`, subject, expiry, issued-at and optional not-before checks. JWKS are cached in-process for one hour.
- Added `backend/test/cognito-auth.test.js`: positive signature test plus invalid signature, wrong issuer/client/token-use, expired token, unknown key and missing configuration cases.
- Added an opt-in backend auth-provider switch in `backend/src/index.js`: `AUTH_PROVIDER=cognito` selects Cognito access-token verification; default remains the existing Firebase verification path.
- This is deliberately **not enabled for staging or production yet**. Existing tenant membership and organization creation still read Firestore and expect the identity to resolve to a stored membership. Cognito `sub` values are not automatically the same as Firebase UIDs. Enabling the switch before migrating membership records would reject legitimate users or break tenant authorization.
- Required Cognito runtime configuration for a future staging test: `AUTH_PROVIDER=cognito`, `COGNITO_REGION=ap-south-1`, `COGNITO_USER_POOL_ID=<pool-id>`, `COGNITO_CLIENT_ID=<app-client-id>`. These are not configured in AWS by this code change. Never put app client secrets, Meta tokens, Stripe secrets or private keys in Vite/frontend variables.

## Required AWS target responsibilities

| Concern | Target | Migration requirement |
|---|---|---|
| User identity | Amazon Cognito User Pools | Replace Firebase sign-in, registration, email verification, Google identity federation, token refresh, logout and auth-state handling |
| API authentication | Cognito JWT verification | Verify signature, issuer, audience/client ID, token_use, expiry and key rotation; never trust decoded-but-unverified claims |
| Tenant authorization | DynamoDB | Resolve active organization and membership server-side on every protected request; derive role from stored membership |
| Tenant records | DynamoDB | Migrate each Firestore query/transaction/batch to explicit partition/sort-key and conditional/transactional access patterns |
| Media | Private S3 | Replace Firebase Storage operations; enforce tenant authorization before issuing signed URLs; enforce plan storage limits and retention |
| Secrets | AWS Secrets Manager + KMS | Keep Meta, Stripe and encryption secrets out of frontend bundles and source |
| Runtime | Lambda + API Gateway | Configure least-privilege role, environment references, logs, alarms, CORS and API base URL |

### DynamoDB organization and membership adapter

- Added `backend/src/aws/dynamoOrganizationStore.js` with transactional organization + first-owner creation, strongly consistent organization/member reads, active membership authorization, and user-to-organization listing.
- Added `backend/test/dynamo-organization-store.test.js` for atomic creation, active membership checks, inactive membership rejection and user-scoped pagination.
- The initial adapter version expected a GSI, but the owner-provided AWS console screenshots (2026-11-27) confirm `JoyInboxMessages` has **zero GSIs**, primary keys `PK` (String) and `SK` (String), On-demand capacity, Active status, and zero items at the time of capture.
- Updated the adapter to avoid requiring any GSI: organization metadata uses `PK=ORG#<id>, SK=META`; organization membership uses `PK=ORG#<id>, SK=MEMBER#<uid>`; a user-to-organization lookup record is transactionally duplicated at `PK=USER#<uid>, SK=ORG#<id>`. Listing organizations now queries the base table by `PK` and `begins_with(SK, ORG#)`. Creation writes all three records atomically.
- The owner-provided `JoyInboxCustomers` screenshots (2026-11-27) confirm the same `PK` (String) and `SK` (String) primary keys, Active status, On-demand capacity, zero GSIs, and zero items at capture time.
- The owner-provided `JoyInboxWorkspaces` screenshots (2026-11-27) confirm the same `PK` (String) and `SK` (String) primary keys, Active status, On-demand capacity, zero GSIs, and zero items at capture time.
- All three tables currently share the same base-key shape and have no GSIs in the screenshots. Do not assume they are interchangeable: keep entity ownership and access patterns explicit. No AWS infrastructure changes have been made. Existing Firebase organization/member data remains the active source of truth until cutover.

## Safe migration sequence

1. Confirm the actual key schemas and indexes for `JoyInboxMessages`, `JoyInboxCustomers`, and `JoyInboxWorkspaces`; inspect records before writing to any live table. `JoyInboxMessages` was verified from screenshots as `PK`/`SK`, no GSIs, zero items at capture time.
2. Finalize a DynamoDB entity/access-pattern model for organizations, memberships, user indexes, chats, messages, contacts, CRM, campaigns, templates, usage, billing, webhook deliveries and audit events. Add GSIs only after access patterns are documented.
3. Provision Cognito and its app clients in `ap-south-1`; configure callback/logout URLs, email verification, password policy, Google federation only after provider credentials and consent are available.
4. Implement and unit-test Cognito JWT verification and a backend identity abstraction. Add explicit tests for invalid signature, wrong issuer/audience, wrong token_use, expired token, unknown key ID, inactive user and revoked/disabled account behavior.
5. Implement DynamoDB organization creation, membership lookup and tenant store operations with conditional writes/transactions. Verify cross-tenant isolation.
6. Implement S3 upload/download/delete routes with authorization, MIME/content validation, quotas, plan retention, lifecycle policy and metadata persistence. Signed URLs must not bypass membership checks.
7. Migrate each Firestore-backed domain module in small, testable slices. Do not remove Firebase until no production route, scheduled worker, webhook, frontend listener or migration utility depends on it.
8. Build a controlled, resumable data migration with counts, checksums, idempotency, dry-run, rollback and source preservation. Do not delete Firebase data as part of cutover.
9. Change frontend auth and API clients to Cognito only after backend Cognito verification is deployed and tested. Then update Cloudflare build validation to require the actual AWS API URL and only non-secret Cognito public configuration.
10. Run all backend/frontend tests, build/package Lambda, deploy to staging, perform smoke tests, then request owner approval before production cutover.

## Current blockers / facts not yet verified

- Live item formats and data volume for all three tables still need verification when items are introduced; screenshots show zero items in each at capture time. All three were visually verified with `PK`/`SK`, no GSIs, Active status and On-demand capacity.
- Whether the existing Lambda role is the intended role for the staging stack and whether any additional AWS policies/resources already exist.
- Cognito User Pool, app client, callback URLs and Google federation configuration.
- S3 bucket deployment and lifecycle/retention rules.
- API Gateway URL and Cloudflare deployment secrets.
- Existing production Firebase data volume and whether data migration is required.

## Deployment safety rule

Do not remove Firebase deployment variables from the Cloudflare workflow merely to make CI green. The current frontend still imports Firebase Auth and Firestore. The deployment validator must be switched to Cognito/AWS configuration only after the frontend migration is implemented; otherwise a successful deployment could ship a broken login/workspace experience.
