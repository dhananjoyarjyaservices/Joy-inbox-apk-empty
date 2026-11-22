# SaaS organization onboarding foundation

This change adds a server-side organization provisioning service.

## Firestore records

Creating an organization writes these records in a single Firestore transaction:

- `organizations/{organizationId}`: organization name, status, creator, plan and timestamps.
- `organizations/{organizationId}/members/{uid}`: first member with the `owner` role.
- `users/{uid}/organizations/{organizationId}`: user-facing organization index for account switching.

The service requires a Firebase Admin-verified token payload. It never accepts a client-selected UID. Business names are normalized and validated before any write.

## Important integration boundary

The service is not yet exposed as an HTTP route and the existing application still uses legacy owner-only handlers and global WhatsApp credentials. Do not treat this commit as multi-tenant production support. The next integration must add authenticated create/list routes, update the frontend onboarding flow, and migrate every chat, message, contact, quick reply, push-token and webhook operation to an organization scope before opening access to multiple businesses.

The current Firestore rules also remain legacy rules. Deploying these helpers alone does not change access control.
