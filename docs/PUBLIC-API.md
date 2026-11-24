# Joy Inbox Public API — v1

This document describes the workspace-scoped server-to-server API. API keys are scoped, hashed at rest, expiring and rate limited.

## Authentication

1. Open **Developer** in the workspace inbox.
2. Create an API key with only the required permissions and an expiry.
3. Copy the key once and store it in a server-side secret manager.
4. Send it as an HTTP Bearer token. Never put it in browser JavaScript, mobile app bundles or public source repositories.

The raw key is generated from cryptographic random bytes. Joy Inbox stores only its SHA-256 hash. Keys are workspace-scoped, expire within 1–365 days, can be revoked immediately and are limited to 60 requests per key per minute. The workspace ID is derived from the key and is never accepted from API requests.

## Contacts

### List contacts
```http
GET /public/v1/contacts?limit=50
Authorization: Bearer YOUR_JOY_API_KEY
```
Required scope: `contacts:read`. Limit must be an integer from 1–100. The response contains `data` and `pagination`; pass `pagination.nextCursor` as `cursor` to fetch the next page. Cursors are opaque and workspace-bound.

### Create or update a contact
```http
POST /public/v1/contacts
Authorization: Bearer YOUR_JOY_API_KEY
Content-Type: application/json
```
Required scope: `contacts:write`. Contacts are keyed by normalized international phone number; repeated POST requests update the same workspace contact. Send a unique `Idempotency-Key` header (8–128 safe characters) to make retries safe; a completed retry returns the original response without creating another webhook event.

## Sales CRM leads

### List leads
```http
GET /public/v1/leads?limit=50
Authorization: Bearer YOUR_JOY_API_KEY
```
Required scope: `leads:read`. Results are limited to 1–100 and ordered by most recently updated. Response contains `data` and `pagination`; use `pagination.nextCursor` as the `cursor` query parameter to continue.

### Create a lead
```http
POST /public/v1/leads
Authorization: Bearer YOUR_JOY_API_KEY
Content-Type: application/json
```
Required scope: `leads:write`. Send a unique `Idempotency-Key` header (8–128 safe characters) on POST, PUT and DELETE requests. The same key and same request returns the original result; reusing a key with a different method or body returns HTTP 409.
```json
{
  "title": "Website enquiry",
  "stageId": "new",
  "source": "website",
  "value": 2500,
  "currency": "INR",
  "contactId": "workspace-contact-document-id",
  "ownerUid": "active-workspace-member-uid",
  "nextFollowUpAt": "2026-12-01T10:00:00.000Z",
  "notes": "Asked for a product demo",
  "customFields": {}
}
```
The stage, linked contact, owner and custom field values are validated against the API key's workspace. Do not send an organization ID; it is derived from the API key.

### Update a lead
```http
PUT /public/v1/leads
Authorization: Bearer YOUR_JOY_API_KEY
Content-Type: application/json
```
Required scope: `leads:write`. Send `resourceId` plus the complete `data` object:
```json
{ "resourceId": "lead-document-id", "data": { "title": "Updated enquiry", "stageId": "qualified" } }
```

### Delete a lead
```http
DELETE /public/v1/leads
Authorization: Bearer YOUR_JOY_API_KEY
Content-Type: application/json
```
Required scope: `leads:write`. Send `{ "resourceId": "lead-document-id" }`.

## Key management and limits

- Workspace owners/admins manage API keys; the full key is shown only once.
- Supported scopes: `contacts:read`, `contacts:write`, `leads:read`, `leads:write`.
- API rate limit is 60 requests per key per minute. Enable Firestore TTL on `publicApiRateLimits.expiresAt` and `publicApiUsageDaily.expiresAt` before production.
- Idempotency records are retained for 24 hours. Enable Firestore TTL on `publicApiIdempotency.expiresAt`; use a new key for a distinct logical mutation.
- Daily usage analytics count accepted requests and rate-limited attempts by API key and UTC date.

### Read API usage analytics
```http
GET /organizations/developer/api-usage?organizationId=WORKSPACE_ID&days=30
Authorization: Bearer FIREBASE_ID_TOKEN
```
Requires an authenticated workspace member with API management permission. `days` must be 1–90 (default 30). The response includes totals and per-key daily request/rate-limit counts. API key IDs are hashes, not raw secrets.
- Public API keys must remain server-side. Configure browser CORS allowlists before exposing any API endpoints to browsers.


## CRM lead webhook events

Workspace webhook subscriptions can also select:

- `lead.created` — a lead is created in Sales CRM or through the public API.
- `lead.updated` — a lead is edited, reassigned or moved to another pipeline stage.
- `lead.deleted` — a lead is deleted; payload contains the workspace lead ID and organization ID.

Events use the same signed delivery queue, retry policy and idempotent event envelope as contact and message events. A webhook enqueue failure is logged and does not roll back a CRM save.


## Webhook delivery operations

The workspace Developer panel shows recent webhook delivery attempts and their status.

### List delivery history
```http
GET /organizations/developer/webhook-deliveries?organizationId=WORKSPACE_ID&limit=50
Authorization: Bearer FIREBASE_ID_TOKEN
```
Requires an authenticated workspace member with API management permission. The response is limited to 1–100 recent deliveries and includes event, status, attempts, HTTP response, timestamps and the last delivery error.

### Replay a failed delivery
```http
POST /organizations/developer/webhook-deliveries
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json

{ "organizationId": "WORKSPACE_ID", "deliveryId": "64-character-delivery-document-id" }
```
Only failed deliveries belonging to the selected workspace can be replayed. The server resets the retry state and queues the existing signed event again; it does not create a new event or change its payload. A delivery that is pending, processing or already delivered cannot be replayed.


### Rotate a webhook signing secret

```http
PUT /organizations/developer/webhooks
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json

{ "organizationId": "WORKSPACE_ID", "webhookId": "WEBHOOK_ID" }
```
Only an active subscription in the selected workspace can be rotated. The previous secret is replaced immediately; the new signing secret is returned once and must be copied into the receiving integration before its next delivery.
