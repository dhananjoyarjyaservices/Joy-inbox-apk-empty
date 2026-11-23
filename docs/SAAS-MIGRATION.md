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


## Tenant contacts and Quick Replies backend APIs

Authenticated organization-scoped endpoints now support listing, creating, updating and deleting contacts and Quick Replies:

- `GET/POST/PUT/DELETE /organizations/contacts`
- `GET/POST/PUT/DELETE /organizations/quick-replies`

Every request verifies the Firebase ID token, active organization membership and the matching `contacts:manage` or `quickReplies:manage` permission. Resource data is stored only below the requested organization path. Contact IDs are normalized phone-number digits; Quick Reply IDs are generated server-side. Inputs reject unknown fields and enforce length/format limits. These endpoints are not yet connected to the tenant dashboard, and integration tests against a real Firebase project remain outstanding.


## Tenant chat management APIs

The backend now includes organization-scoped chat management endpoints:

- `POST /organizations/chat-state`: pin, archive and mark a conversation read.
- `POST /organizations/message-state`: pin or unpin a message.
- `POST /organizations/delete-messages`: delete 1–50 selected messages.
- `POST /organizations/delete-chats`: delete 1–50 conversations and their nested Firestore data.

Each endpoint authenticates the Firebase user, verifies active membership and checks `chats:manage`. All document references are constructed below the verified organization path. Deletion validates IDs and checks selected documents before removing them. These routes do not invoke legacy Firebase Storage cleanup, and they do not delete or persist media bytes; media metadata is removed with its message document. Frontend wiring and end-to-end tests remain outstanding.


## Tenant greeting and connection diagnostics APIs

The backend now provides organization-scoped endpoints for greeting configuration and WhatsApp connection diagnostics:

- `GET /organizations/greeting-settings?organizationId=...`
- `POST /organizations/greeting-settings` with `organizationId`, `enabled` and `text`.
- `GET /organizations/status?organizationId=...`

These routes authenticate the Firebase user and verify active organization membership. Greeting settings require `settings:manage` and are stored below the selected organization's `settings/greeting` document. Connection diagnostics require `chats:read` and check the selected organization's encrypted WhatsApp credentials and organization chat collection. The previous owner-only `/greeting-settings` and `/status` routes remain for the legacy dashboard. Tenant frontend integration and automated end-to-end validation remain outstanding.


## Tenant media sending (metadata-only storage)

The backend now includes `POST /organizations/send-media`. It verifies Firebase authentication, active organization membership and `messages:send` permission; validates the bounded base64 upload and media content signature; uploads the bytes directly to the organization's connected WhatsApp Cloud API account; and sends the resulting Meta Media ID. The message record stores only the Meta Media ID, MIME type, byte size and filename. It does not call Firebase Storage, write media bytes to disk, or use S3. The request body is held in Lambda memory while processing. This initial tenant media endpoint caps uploads at 3 MB and still needs frontend integration, automated tests and an authenticated inbound/outbound media viewing proxy before media viewing is complete.


## Authenticated tenant media viewing proxy

The backend now provides `GET /organizations/media?organizationId=...&chatId=...&messageId=...`. It requires Firebase authentication, active organization membership and `chats:read` permission, then verifies the message is inside that organization's chat before reading its Meta Media ID. The server retrieves the short-lived media URL from Meta and fetches the bytes server-side; the Meta access token and media URL are never returned to the browser. The response is marked private/no-store and includes MIME sniffing protections. The proxy rejects untrusted URL hosts and redirects, validates the returned file signature, and currently limits previews to 4 MB to stay within synchronous Lambda response limits. No media bytes are written to Firebase Storage, S3, local disk or Lambda temporary storage. Frontend media viewer integration, larger-file streaming support and automated integration tests remain outstanding.


## Initial tenant inbox frontend

A protected `/inbox` route is now available to authenticated workspace members. It loads the active workspace, listens only to that workspace's chat and message collections, and sends text through the authenticated tenant messaging API. The setup page navigates to the inbox after a WhatsApp number is verified. This is an initial text-chat slice only: media rendering/sending, contacts and Quick Replies screens, chat actions, pagination, push notifications and full parity with the legacy owner dashboard are not yet integrated. The legacy dashboard remains restricted to its original owner account.


## Tenant contacts and Quick Replies frontend

The tenant inbox now has Contacts and Quick Replies views backed by the organization-scoped API routes. Both lists are loaded for the selected organization, and create/delete operations send the organization ID with authenticated requests. These are initial management screens; contact editing, shortcut-triggered insertion into the chat composer, media attachments in Quick Replies, and full interaction testing remain outstanding. The existing owner-only legacy dashboard and user-level resource services are not used by these new tenant views.


## Tenant chat actions and Quick Reply insertion

The tenant inbox now calls organization-scoped chat-state, message-state and delete-chat endpoints. Chat rows expose pin/unpin, archive/unarchive, mark-read and delete actions; individual messages expose pin/unpin. Typing a forward slash in the composer filters the current workspace's saved Quick Replies by shortcut/title, and selecting a result inserts its message into the composer. These controls depend on the existing backend permission `chats:manage`; agent-role permission currently includes that capability. Archived-chat filtering/navigation, bulk actions and end-to-end interaction testing remain outstanding.


## Tenant media frontend and workspace settings

The tenant inbox now has a media attachment picker and previews for supported image, video, audio and document messages. Outgoing files are bounded to 3 MB in the browser and sent through the authenticated tenant media endpoint; incoming previews are fetched through the authenticated media proxy and held only as temporary browser Blob URLs, revoked when the conversation changes or the component unmounts. No customer media bytes are written to Firebase Storage, S3 or local disk by these tenant flows. Current supported MIME types are limited to the explicit allowlist in the backend; unsupported formats such as WebP stickers are not yet supported. The proxy currently caps previews at 4 MB.

The Settings view now displays WhatsApp/Firestore connection diagnostics and lets owner/admin members configure the first-inbound greeting message. Agent users do not see the settings tab. Archived conversations can be shown separately from the inbox list.

Remaining validation: execute backend tests and frontend TypeScript/Vite build; test the binary Lambda proxy through the actual API Gateway/Lambda integration; verify CORS_ORIGINS includes the deployed frontend origin; verify Meta's media host and MIME/signature behavior with real supported samples; test large-file behavior and role-based UI/API permissions. This remains non-production code until those checks pass.

## Organization member management API

Authenticated organization member endpoints are available at `/organizations/members`:

- `GET` with `organizationId`: list organization members (owner/admin only).
- `POST` with `organizationId`, `email`, and optional `role`: add an existing Firebase Authentication user as an agent or admin.
- `PUT` with `organizationId`, `uid`, and `role`: change an active member between admin and agent.
- `DELETE` with `organizationId` and `uid`: revoke the member's active membership.

All routes require Firebase ID-token verification, active organization membership, and `members:manage`. Only an owner can grant the admin role. The owner role cannot be assigned, demoted, or removed through these routes. An invited person must first register for Joy Inbox with the supplied email; email delivery/invitation links are not implemented yet. Removal marks the member and their organization switcher index as removed; it does not delete the Firebase Authentication account or historical chat messages. Frontend member-management screens and real Firebase integration tests remain pending.



## Subscription billing foundation (incremental)

The branch now includes a tenant Workspace Billing screen and a Stripe integration foundation:
- owner/admin-only Checkout and Billing Portal session APIs;
- server-side Stripe Price ID configuration and idempotent Checkout session creation;
- raw-body Stripe signature verification with a five-minute timestamp tolerance;
- idempotent webhook processing for checkout completion, subscription create/update/delete, and failed invoices;
- organization-scoped subscription status storage and customer consistency checks.

Billing documents and Stripe webhook event records remain server-only under Firestore rules. Billing is not enabled until the Stripe account, test/live API secrets, webhook signing secret, recurring Price IDs and trusted return URLs are configured. Plan entitlements, quotas, taxes, invoices UI, trials/grace policy, and live-payment acceptance testing are still outstanding. See [docs/BILLING-STRIPE.md](BILLING-STRIPE.md).


## Legacy data migration utility (dry-run first)

A migration utility is now available at `backend/scripts/migrate-legacy-to-tenant.js`. It requires an existing active target organization and an active owner membership for the selected legacy owner UID.

Dry-run (no writes):

```sh
node backend/scripts/migrate-legacy-to-tenant.js --organization=ORG_ID --owner=FIREBASE_UID
```

Execute only after a verified Firestore backup and explicit operator approval:

```sh
node backend/scripts/migrate-legacy-to-tenant.js --organization=ORG_ID --owner=FIREBASE_UID --execute
```

The utility copies legacy chats/messages, contacts, quick replies and greeting settings to organization-scoped paths using deterministic document IDs. It skips destination documents that already exist, so a partial run can be resumed without overwriting tenant edits. A completion marker is written only after all writes succeed.

Customer media bytes, Firebase Storage paths, signed URLs and base64 media payloads are deliberately excluded. Meta media IDs and safe message metadata may be retained; old media without a Meta media ID is marked unavailable and must not be copied into tenant storage. Quick Reply image references are marked unavailable and need to be re-uploaded to the workspace.

The script is not run automatically and has not been executed against any production data. Do not pass `--execute` until the dry-run counts, owner identity, target organization, backups and rollback plan have been reviewed.


## Conversation internal notes

The tenant inbox now supports private internal notes at `organizations/{organizationId}/chats/{chatId}/internalNotes`. Active members with chat permissions can list the latest 100 notes and add notes up to 2,000 characters. Each note records its author UID/name and timestamp. Internal notes are served only through authenticated tenant APIs; Firestore client rules deny direct access and notes are never sent to WhatsApp.


## Interactive WhatsApp messages

The tenant inbox composer now supports session-based interactive reply buttons (up to three), list menus (up to ten rows total), and HTTPS call-to-action links for payment/catalog URLs, with optional text header/footer. The backend validates Meta length/count limits, sends through the selected workspace Phone Number ID, and uses the tenant send-request idempotency ledger. Outgoing interactive messages are stored as structured tenant message records; incoming button/list selections are stored as searchable text with the selected option ID/title.

Interactive messages remain subject to WhatsApp's active customer-service window and Meta account policy. They are not a substitute for approved templates outside that window.
