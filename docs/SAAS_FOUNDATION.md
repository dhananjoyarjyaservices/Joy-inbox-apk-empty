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
