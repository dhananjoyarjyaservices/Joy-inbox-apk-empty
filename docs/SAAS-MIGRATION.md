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

## Tenant-scoped text messaging foundation

The backend now exposes `POST /organizations/send` as a separate tenant-aware text-send route. It verifies the Firebase ID token, checks active organization membership and the `messages:send` permission, loads the organization's decrypted WhatsApp credentials server-side, and writes chats, messages, and idempotency records below `organizations/{organizationId}/chats/{chatId}`. Reply lookup is constrained to the same organization's message subcollection. The legacy `POST /send` route remains unchanged for the existing owner-only application.

This is a backend foundation, not a completed SaaS chat rollout: the current frontend has not yet been switched to this endpoint or to organization-scoped Firestore listeners. Tenant media sending, webhook ingestion/status updates, tenant chat-state/delete routes, and media proxy/no-retention behavior remain outstanding. Do not treat the new endpoint as production-ready until automated tests and integration validation pass.

## Tenant webhook routing and media retention

Incoming webhook changes are now routed using the trusted `value.metadata.phone_number_id` field. The server resolves that ID through the `whatsappPhoneNumbers` mapping and loads the organization's encrypted WhatsApp credentials; unlinked or inactive numbers are ignored. Incoming messages and delivery statuses are written under `organizations/{organizationId}/chats/{chatId}`. Greeting settings and sends are also organization-specific.

The new tenant webhook path stores incoming media references and metadata (Meta media ID, MIME type, file size, filename, and hash) only. It does not download or persist the customer media bytes in Firebase Storage. This is metadata-only retention, **not yet a media viewing proxy**. The legacy media upload/retrieval functions and owner-only media routes still exist; tenant media sending and authenticated short-lived media retrieval remain to be implemented.

Firestore rules now allow active organization members to read that organization's chat and message documents while keeping writes server-only. This is an incremental rule set; the legacy owner-only rules and old data paths remain for the current application until the full frontend and migration are completed.

## Frontend SaaS account and workspace onboarding (initial)

The frontend now permits Firebase email/password account registration and no longer automatically signs out every non-legacy-owner user. Non-owner authenticated users are redirected away from the legacy owner dashboard to a protected `/setup` route. The setup screen calls the authenticated organization APIs to list workspaces, create a business workspace, and connect a WhatsApp Cloud API number using the Meta Phone Number ID and access token. The access token is sent only to the backend connection endpoint and cleared from the form after a successful response.

The legacy owner account continues to use the existing dashboard while tenant users are kept out of that owner-only dashboard. This is intentionally a limited onboarding milestone: tenant chat UI, organization switching in the inbox, organization-scoped Firestore listeners and tenant-aware message/media actions are not yet wired. Google sign-in can also create a Firebase account and then proceeds to the same setup route. Do not treat this as a complete or production-ready SaaS release.


## Organization-scoped frontend data access (foundation)

The frontend now has a separate tenant chat service that reads only from `organizations/{organizationId}/chats` and its `messages` subcollections. It provides tenant-specific chat/message lookups, realtime listeners, and cursor pagination. It does not fall back to the legacy top-level `chats` collection. The setup page also remembers the selected workspace ID locally so a later tenant inbox can restore the last selection.

This is deliberately not wired into the legacy dashboard yet. That dashboard still calls legacy global chat, contacts, quick-reply, send, pin, delete, media, greeting, and status services. Unlocking it for tenant users before every operation is tenant-scoped would risk exposing or modifying another workspace's data. The next integration stage must move the entire dashboard onto organization-aware services and keep tenant access blocked until that is complete.


## Tenant contacts and Quick Replies read foundation

The frontend now has separate read-only services for contacts and saved Quick Replies under the active organization's own Firestore paths. These services never read the legacy `users/{uid}` collections. Firestore permits active organization members to read these tenant-owned records; browser writes remain denied until authenticated backend create/update/delete endpoints with role checks and input validation are implemented. The legacy owner dashboard still uses legacy personal collections and has not been switched to these services.
