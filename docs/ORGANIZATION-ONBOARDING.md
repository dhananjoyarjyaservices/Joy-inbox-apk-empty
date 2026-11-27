# Joy Inbox workspace onboarding

**Current status:** The multi-tenant workspace onboarding flow is implemented in the SaaS feature branch. This document describes the current code foundation; it does not claim that Firebase, Meta or AWS staging resources have been connected or accepted.

## Workspace records

Creating a workspace uses a server-side Firestore transaction to write:

- `organizations/{organizationId}`: workspace name, status, creator, plan and timestamps.
- `organizations/{organizationId}/members/{uid}`: creator membership with the `owner` role.
- `users/{uid}/organizations/{organizationId}`: user-facing workspace index for account switching.

The backend uses a Firebase Admin-verified identity. It does not trust a client-supplied UID. Workspace names are normalized and validated before writes.

## Implemented onboarding flow

- Authenticated organization list and create handlers are wired into the backend router.
- The frontend Setup screen loads the signed-in user's workspaces, creates a workspace, and lets the user select the active workspace.
- Workspace invitations support hashed one-time tokens, verified-email acceptance, expiry and revocation; the team UI supports invitation handling.
- WhatsApp connections are stored and managed in workspace scope. New tenant connections use encrypted per-workspace credentials rather than a shared global token.
- Organization membership and role checks protect tenant routes and workspace resources.

## Security boundaries

- Every tenant API operation must resolve the requested workspace through the authenticated membership/permission check.
- Client Firestore rules deny direct access to server-only invitation token data and protect legacy owner-only collections.
- Legacy single-owner HTTP endpoints fail closed unless the explicit migration-only flag is enabled; keep `LEGACY_OWNER_API_ENABLED` unset or false outside a controlled migration window.
- Never place Firebase Admin credentials, Meta access tokens, Stripe secrets, tenant encryption keys or campaign suppression keys in frontend `VITE_*` variables.

## Remaining acceptance work

The code foundation is not the same as a connected staging environment. Before accepting workspace onboarding for real customers:

1. Complete the remaining repository-only implementation, review and automated checks.
2. Provision isolated staging service resources and secrets.
3. Connect Firebase and verify Auth, Firestore indexes/rules, organization creation, membership isolation and rollback behavior.
4. Connect Meta test assets and verify WhatsApp number onboarding, webhook signature/routing and real message delivery.
5. Complete Stripe test-mode checkout, trial, billing portal and webhook lifecycle tests.
6. Complete security, concurrency, backup/restore and migration rehearsals.

Firebase connection is intentionally deferred until the repository-side work and review are complete. Production migration, live billing, production webhook changes and deployment require explicit owner approval.

For the authoritative current checklist, see [RELEASE-READINESS.md](RELEASE-READINESS.md), [PRICING-AND-USAGE-POLICY.md](PRICING-AND-USAGE-POLICY.md), and [BILLING-STRIPE.md](BILLING-STRIPE.md).
