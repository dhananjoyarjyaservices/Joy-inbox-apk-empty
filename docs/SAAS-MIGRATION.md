# Joy Inbox SaaS migration

## Status

The original React/Vite + Firebase + AWS Lambda application has been migrated into this repository. SaaS foundation work is being introduced incrementally on `feature/saas-foundation`. This branch is not production-ready and must not be deployed until the remaining API, frontend, rules, webhook and migration work is complete and tested.

## Target data model

- `organizations/{organizationId}`: organization profile, status, timestamps and non-secret configuration.
- `organizations/{organizationId}/members/{uid}`: role (`owner`, `admin`, `agent`), active status and timestamps.
- `organizations/{organizationId}/chats/{chatId}/messages/{messageId}`: tenant-scoped conversations and message history.
- `organizations/{organizationId}/contacts/{contactId}`, `quickReplies/{replyId}`, and `settings/{settingId}`: tenant-owned resources.
- `whatsappPhoneNumbers/{phoneNumberId}`: server-only mapping from Meta phone number ID to organization ID.

## Security requirements

1. Verify Firebase ID tokens on every authenticated API request.
2. Resolve the requested organization from Firestore membership; never trust a client-provided organization ID without checking membership.
3. Enforce role permissions server-side. The browser must never receive WhatsApp access tokens or encryption keys.
4. Store each organization's WhatsApp token encrypted with AES-256-GCM using a 32-byte key held in AWS Secrets Manager or an equivalent server-only secret store. Keep key rotation and recovery procedures outside Firestore.
5. Route webhooks by Meta's verified `metadata.phone_number_id` mapping. Never accept a tenant ID supplied in webhook body fields as the routing authority.
6. Scope FCM registrations to authenticated users and organizations.
7. Firestore rules must deny cross-tenant reads and writes by default. Admin SDK access must always pass through the same membership and role checks in Lambda.

## Media retention policy

The product requirement is to support WhatsApp media without permanently storing customer images or videos in Firebase Storage. The final implementation must store only message metadata and Meta media IDs. Uploads should be sent to Meta from bounded Lambda memory buffers; inbound media should be fetched from Meta on demand through an authenticated, short-lived streaming proxy. Do not log media bytes, tokens, signed URLs or customer content. Do not persist media to Firebase Storage, S3, local disk or Lambda /tmp. Lambda memory buffering is transient processing, not durable storage.

## Migration plan

1. Keep the current single-owner collections and API available while the SaaS routes are developed.
2. Create an organization for the existing owner and add the owner membership.
3. Copy existing chats/messages, contacts, quick replies and settings into organization-scoped paths with deterministic IDs; verify counts and representative documents.
4. Add an idempotent migration marker and a rollback snapshot before switching reads/writes.
5. Switch frontend and backend together only after tenant isolation tests pass.
6. Remove legacy owner-only access only in a separately reviewed release after production verification.

## Not yet complete

The existing production handlers still use the legacy owner UID, global WhatsApp credentials, top-level chat collections and Firebase Storage media functions. The new tenancy helpers are a foundation only; they are not yet wired into every route or webhook. The frontend signup/onboarding flow, tenant-aware Firestore rules, migration utility, webhook routing, per-tenant secret provisioning, and no-persistent-media proxy must be completed before launch.


## Incremental implementation update

The branch now also contains a server-side organization onboarding service and authenticated `GET /organizations` / `POST /organizations` routes. It creates the organization, first owner membership, and user organization index in one Firestore transaction.

An authenticated `POST /whatsapp/connect` endpoint now:
1. verifies the Firebase ID token,
2. checks active organization membership and `whatsapp:manage` permission,
3. validates the supplied Phone Number ID and access token against Meta Graph API,
4. encrypts the access token using AES-256-GCM with `TENANT_SECRET_ENCRYPTION_KEY`,
5. stores the encrypted connection under the organization settings and reserves the Phone Number ID in the server-side mapping collection.

The endpoint never returns the access token. Configure a base64-encoded 32-byte `TENANT_SECRET_ENCRYPTION_KEY` only in the backend secret environment. Never place it in Vite/client environment variables or commit it.

**Critical remaining integration:** Existing send, media, status, greeting and webhook code still uses legacy global WhatsApp credentials and legacy top-level chat paths. The new stored tenant credentials are not yet used by those message flows. The media implementation still persists customer media in Firebase Storage. Do not connect live customer tenants or deploy this branch until the message paths, webhook routing, tenant-scoped data paths and no-permanent-media-storage design are implemented and tested.


## Tenant credential transport foundation

The WhatsApp API client now accepts an explicit credential object for text sends, media sends, connection checks and outbound media upload. The credential object is intended to be loaded by trusted backend code from the organization's encrypted settings after membership and permission checks. Legacy environment fallback remains for the existing owner-only routes during migration. This is only a transport-layer compatibility step: the current HTTP handlers do not yet load and pass tenant credentials, and must not be treated as multi-tenant messaging.
