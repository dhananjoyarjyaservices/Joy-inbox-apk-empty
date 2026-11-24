# Joy Inbox Public API — v1 (initial release)

This document describes the first implemented server-to-server API surface. It is intentionally limited to workspace contacts until additional resource scopes, rate limits, pagination and outbound webhook delivery are complete.

## Authentication

1. In Joy Inbox, open **Developer** in the workspace inbox.
2. Create an API key with only the required permissions and an expiry.
3. Copy the key once and store it in a server-side secret manager.
4. Send it as an HTTP Bearer token. Never put it in browser JavaScript, mobile app bundles or public source repositories.

Example header:

```http
Authorization: Bearer joy_live_REPLACE_WITH_YOUR_KEY
```

The raw key is generated from cryptographic random bytes. Joy Inbox stores only its SHA-256 hash. Keys are workspace-scoped, expire within 1–365 days, can be revoked immediately and update a throttled last-used timestamp. The workspace ID is derived from the key and is never accepted from the API request.

## Endpoints

### List contacts

```http
GET /public/v1/contacts?limit=50
Authorization: Bearer YOUR_JOY_API_KEY
```

Required scope: `contacts:read`

The limit is clamped to 1–100. Response includes `data` and a `pagination.hasMore` indicator. Cursor pagination is not yet available.

### Create or update a contact

```http
POST /public/v1/contacts
Authorization: Bearer YOUR_JOY_API_KEY
Content-Type: application/json
```

Required scope: `contacts:write`

Example body:

```json
{
  "name": "Asha",
  "phone": "+919876543210",
  "email": "asha@example.com",
  "notes": "Website enquiry",
  "source": "local",
  "tags": ["website", "new-lead"]
}
```

Contacts are keyed by normalized international phone number. A repeated POST for the same phone updates the existing contact within that workspace.

## Key management

- Workspace owners and admins can create, list and revoke keys.
- Agents cannot manage developer keys.
- The full key is returned only at creation time.
- Revocation takes effect immediately.
- Only `contacts:read` and `contacts:write` scopes are currently supported.

## Not yet included

- Public API endpoints for leads, messages, campaigns and templates.
- Customer-managed outbound webhook subscriptions, signed delivery, retries and replay.
- Per-key configurable rate limits and usage analytics.
- Cursor pagination and idempotency keys for write requests.
- Browser CORS allowlists for third-party frontend apps.

Do not treat this initial API surface as a full Interakt developer API replacement until the remaining controls and endpoints are implemented and tested.
