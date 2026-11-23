# Joy Inbox multi-tenant foundation

This branch migrates the existing Joy Inbox source into this repository and adds the first server-side organisation and membership layer.

## API endpoints

All endpoints below require a Firebase ID token in the `Authorization: Bearer <idToken>` header.

| Method | Path | Purpose |
|---|---|---|
| POST | `/organisations` | Create an organisation. Body: `{ "name": "Business name" }`. Creator becomes owner. |
| GET | `/organisations` | List active organisations for the signed-in user. |
| POST | `/organisations/:orgId/invitations` | Owner/admin creates an invitation. Body: `{ "email": "agent@example.com", "role": "agent" }`. Roles: admin, manager, agent. |
| POST | `/organisations/:orgId/invitations/accept` | Accept an invitation using `{ "invitationId": "..." }`. Email must be verified and match the invitation. |
| GET | `/organisations/:orgId/members` | List active members for owner/admin/manager. |

Invitations currently create a pending invitation record and return its ID; an email-delivery provider is not configured yet, so the ID must be shared by the organisation admin through a trusted channel.

## Firestore layout

```text
organisations/{orgId}
  name, ownerUid, status, plan, createdAt, updatedAt
  members/{uid}
    uid, email, role, status, joinedAt
  invitations/{invitationId}
    email, role, status, createdBy, createdAt, expiresAt
```

Organisation and membership writes are performed by the backend Admin SDK. Firestore client rules permit reads only to active members (and restrict member/invitation visibility by role/email).

## Important rollout boundary

The existing inbox, webhook, WhatsApp credentials, and message persistence are still using the original single-owner data model. Do not onboard real customer organisations or connect production WhatsApp numbers yet. The next migration must scope conversations, contacts, messages, quick replies, push tokens, webhook routing, and WhatsApp credentials by `orgId`; it must also remove the fixed owner UID from the legacy API only after every route has tenant authorization.

Customer media retention also remains in the legacy media flow. The requested text-only retention policy must be implemented before production onboarding.


## Frontend onboarding

- Email/password registration sends a Firebase verification email.
- Authenticated users who are not the legacy inbox owner are routed to `/setup`.
- The setup page calls the organisation APIs to create a business, list memberships, create invitations, accept invitations, and list members.
- The legacy single-owner inbox route remains restricted to the existing owner until all inbox and webhook data is migrated to tenant-scoped paths.

## Customer media retention

New inbound WhatsApp media is no longer downloaded to Firebase Storage. The webhook stores the message type and text/caption only, and the UI reports that customer media is not retained.

Previously stored inbound media is not automatically removed by deploying this change. Review and run the cleanup script after backing up anything that must be retained:

```bash
cd backend
node scripts/cleanup-inbound-media.js
CONFIRM_DELETE_INBOUND_MEDIA=true node scripts/cleanup-inbound-media.js
```

The first command is a dry run. The second permanently deletes inbound media files and clears their storage metadata from Firestore. Configure the Firebase Admin credentials and storage bucket before running it. Outbound attachments are not removed by this script.

## Validation and rollout

The GitHub Actions CI workflow is configured to run backend tests, backend syntax checks, and the frontend TypeScript/Vite build on feature branches. A green CI run must be confirmed before merging. This branch has not been deployed and the Firestore rules have not been published to the live Firebase project.


## Per-organisation WhatsApp credential connection (development)

The organisation setup screen now has a WhatsApp Cloud API connection form. The backend:

- Requires owner/admin membership for credential changes and owner/admin/manager for viewing connection metadata.
- Calls Meta Graph API to verify the supplied Phone Number ID and access token before saving.
- Encrypts the access token with AES-256-GCM using `WHATSAPP_CREDENTIALS_ENCRYPTION_KEY` (64 hex characters / 32 random bytes).
- Stores the WABA ID, Phone Number ID, verified display name and encrypted token under the organisation's `whatsappConnections/primary` document.
- Maintains a unique Phone Number ID to organisation mapping in the server-only `whatsappPhoneNumbers` collection.
- Never returns the access token to the browser. Re-enter the token when rotating credentials.

Before enabling this API, configure the encryption key in the Lambda environment. Generate one with:

```bash
openssl rand -hex 32
```

Store the value in AWS Lambda environment configuration or a secrets manager; do not commit it to GitHub. Back it up securely because losing the key makes previously encrypted tokens unrecoverable. Rotating the key requires an explicit re-encryption migration.

**Important:** This phase verifies and stores per-business credentials only. Existing message sending, webhook processing, conversation storage and status callbacks still use the legacy single-owner code path. Do not enable live production messaging for newly connected organisations until those paths are migrated to the organisation-scoped model and verified with cross-tenant tests.


## Organisation-scoped WhatsApp inbox foundation

- Each verified WhatsApp Phone Number ID is mapped to one organisation in the server-only `whatsappPhoneNumbers` collection.
- The webhook verification token is generated per connection. Only its SHA-256 hash is stored; the plaintext token is returned once after saving credentials.
- Meta webhook GET verification accepts either the legacy global token or a matching organisation token.
- Incoming messages are written under `organisations/{orgId}/chats/{customerPhone}/messages/{wamid}`; contact profiles are written under `organisations/{orgId}/contacts/{customerPhone}`.
- Message delivery/read status callbacks update the matching organisation message document.
- Customer media is not downloaded or persisted; only text/caption/type metadata is retained.
- `POST /organisations/{orgId}/messages` checks active membership, decrypts that organisation's token server-side, sends a WhatsApp text message using that organisation's Phone Number ID, and persists the outgoing message under that organisation's chat.
- The new organisation inbox UI reads only the organisation-scoped Firestore paths and uses the tenant-authorized send API.

Configure the same AWS Lambda webhook URL (the `/webhook` endpoint) in Meta, and use the one-time organisation verify token displayed after saving. In Meta, subscribe the relevant WhatsApp Business Account to the app and enable the `messages` webhook field. The Meta App Secret used for request signature validation remains a platform-level secret.

The new inbox supports basic text conversation viewing and sending. Team assignment, internal notes, tags, quick replies, media/template sending, automations, broadcasts, analytics and billing remain future work. Do not migrate the old top-level single-owner chat data automatically; it needs a reviewed tenant ownership mapping and migration plan.
