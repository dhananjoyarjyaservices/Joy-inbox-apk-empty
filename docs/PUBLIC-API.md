# Joy Inbox Public API — v1

This document describes the workspace-scoped server-to-server API. API keys are scoped, hashed at rest, expiring and rate limited.

## Authentication

1. Open **Developer** in the workspace inbox.
2. Create an API key with only the required permissions, an expiry and a supported rate-limit tier.
3. Copy the key once and store it in a server-side secret manager.
4. Send it as an HTTP Bearer token. Never put it in browser JavaScript, mobile app bundles or public source repositories.

The raw key is generated from cryptographic random bytes. Joy Inbox stores only its SHA-256 hash. Keys are workspace-scoped, expire within 1–365 days and can be revoked immediately. When creating a key, choose `rateLimitPerMinute` as 60 (default), 120 or 300; the selected limit is enforced independently for that key. The workspace ID is derived from the key and is never accepted from API requests.

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

## Send WhatsApp text messages

### Send a text message
```http
POST /public/v1/messages
Authorization: Bearer YOUR_JOY_API_KEY
Idempotency-Key: order-123-message-1
Content-Type: application/json
```
Required scope: `messages:write`. The request must include the connected `phoneNumberId`, recipient phone number in international format (digits only), and text (1–4096 characters):
```json
{ "phoneNumberId": "123456789012345", "to": "919876543210", "text": "Thanks for contacting us." }
```
The number must belong to the API key's workspace. The API sends through the WhatsApp Cloud API and stores the text and delivery metadata in the workspace inbox; it does not store customer media. A unique `Idempotency-Key` is required for every send and makes retries safe. Sends consume the workspace outbound-message allowance and obey its hard-block plan limit. WhatsApp policy, recipient opt-in, messaging windows and Meta account limits still apply. A successful response means Meta accepted the message, not that the recipient device received it.

## Send WhatsApp media

Use the same POST /public/v1/messages endpoint and messages:write scope. Media is uploaded directly to Meta and is not persisted in Joy Inbox customer-media storage. The current public upload limit is 3 MB; the MIME type and file signature must match.

~~~http
POST /public/v1/messages
Authorization: Bearer YOUR_JOY_API_KEY
Idempotency-Key: media-attachment-123
Content-Type: application/json
~~~

~~~json
{
  "phoneNumberId": "123456789012345",
  "to": "919876543210",
  "type": "image",
  "media": {
    "base64": "BASE64_ENCODED_FILE",
    "mimeType": "image/jpeg",
    "filename": "product.jpg",
    "caption": "The product you asked about"
  }
}
~~~

Supported type values are image, video, audio and document. Documents require a filename. The MIME type must be compatible with the selected type. The request is idempotent; use a new Idempotency-Key for a new send. Upload and outbound-message usage are checked against workspace limits.

## Send WhatsApp interactive messages

Use POST /public/v1/messages with messages:write. Interactive messages are validated against WhatsApp limits before sending.

Reply buttons (1–3 buttons):

~~~json
{
  "phoneNumberId": "123456789012345",
  "to": "919876543210",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": "Order update",
    "body": "What would you like to do?",
    "footer": "Joy Inbox",
    "buttons": [
      { "id": "track", "title": "Track order" },
      { "id": "support", "title": "Contact support" }
    ]
  }
}
~~~

Lists support 1–10 sections and up to 10 rows total. CTA URL messages use type: "cta_url", displayText and an HTTPS url. Carousel messages support 2–10 cards with HTTPS image URLs, card text and HTTPS CTA links. Button/row IDs must be unique; text lengths follow WhatsApp limits. Meta's Cloud API availability and account eligibility for each interactive format still apply.

## List approved WhatsApp templates

```http
GET /public/v1/templates?phoneNumberId=123456789012345&wabaId=123456789012345&limit=50
Authorization: Bearer YOUR_JOY_API_KEY
```

Required scope: `templates:read`. The requested WABA ID must match the WABA ID stored for the connected phone number in the API key's workspace. The limit must be 1–100 (default 100). When the response has `pagination.nextCursor`, pass that opaque value as the `cursor` query parameter to retrieve the next Meta page. The API forwards it to Meta as the `after` cursor and returns `hasNext` to indicate whether another page exists.

### Upload template header media

```http
POST /whatsapp/templates/media
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json
```

Requires Owner/Admin WhatsApp management permission and a connected number/WABA pair. Send `organizationId`, `phoneNumberId`, `wabaId`, `format` (`IMAGE`, `VIDEO` or `DOCUMENT`), `mimeType`, `filename` and base64-encoded `base64`. Supported files are JPEG/PNG, MP4 and PDF, up to 3 MB. The backend verifies tenant/WABA ownership and uploads the bytes to Meta's Resumable Upload API. The response contains a Meta `handle`; pass it in the template HEADER component's `example.header_handle` array. Joy Inbox does not persist these uploaded bytes.

### Create a template

```http
POST /whatsapp/templates
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json
```

Requires an Owner or Admin workspace member with WhatsApp management permission. Include `organizationId`, `phoneNumberId`, `wabaId`, `name`, `language`, `category` and `components`. The API verifies that the WABA ID is the one stored for the connected number before calling Meta. The current builder supports UTILITY and MARKETING templates with BODY, optional text/media HEADER and text FOOTER, and supported QUICK_REPLY, HTTPS URL or PHONE_NUMBER buttons. Media headers require a previously uploaded Meta header handle. Variable text headers/bodies require examples. Media headers, AUTHENTICATION templates, dynamic URL buttons, carousel and Flow components are not supported by this endpoint yet. Meta reviews created templates; a successful create response commonly has PENDING status and does not mean approval.

### Update a template

```http
PUT /whatsapp/templates
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json
```

Send `organizationId`, `phoneNumberId`, `wabaId`, `templateId`, `templateName`, and at least one of `category` or `components`. The server first verifies that the template ID/name pair is listed under the connected WABA, then updates the Meta template node. Template name and language cannot be changed.

### Delete a template

```http
DELETE /whatsapp/templates
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json
```

Send `organizationId`, `phoneNumberId`, `wabaId`, `templateId` and `templateName`. The server verifies the ID/name pair against the connected WABA and asks Meta to delete that exact template ID. These operations require Owner/Admin permissions and a token with Meta's `whatsapp_business_management` permission.

## Send an approved WhatsApp template

Use POST /public/v1/messages with messages:write. The API derives the WABA ID from the connected number, checks that the template is approved for the requested language, validates body/header/URL-button variable counts and sends through the connected WhatsApp number. Text-header templates are supported by this endpoint; templates with image/video/document headers must use the media template flow in the workspace inbox.

~~~json
{
  "phoneNumberId": "123456789012345",
  "to": "919876543210",
  "type": "template",
  "templateName": "order_update",
  "language": "en",
  "variables": ["A-100", "today"],
  "headerVariables": ["Customer"],
  "buttonVariables": ["A-100"],
  "consent": {
    "optedIn": true,
    "consentAt": "2026-11-24T10:00:00.000Z",
    "consentSource": "Website checkout opt-in"
  }
}
~~~

A template send requires explicit opt-in evidence with optedIn=true, a past ISO-8601 consentAt timestamp and a 2–120 character consentSource. The API checks the workspace suppression list and rejects recipients who have opted out; the evidence source/time is retained in a workspace-scoped audit record. Use a unique Idempotency-Key for every send. A successful response means Meta accepted the message, not that the recipient device received it. WhatsApp consent, template policy and messaging rules still apply.

## Campaigns

### Create a campaign draft
```http
POST /public/v1/campaigns
Authorization: Bearer YOUR_JOY_API_KEY
Idempotency-Key: campaign-draft-2026-001
Content-Type: application/json
```
Required scope: `campaigns:write`. This endpoint creates a draft only; it never schedules, queues or sends messages. A unique `Idempotency-Key` is required. The request uses the same campaign fields as the workspace campaign builder: `name`, `templateName`, `language`, `category`, `phoneNumberId`, `wabaId`, optional campaign-level `variables`, and a `recipients` array. Each recipient must include `phone`, `optedIn: true`, a past `consentAt` timestamp and a non-empty `consentSource`; optional per-recipient `variables` may override campaign defaults. The API derives the workspace from the API key and verifies that the WhatsApp number is connected, the template is approved in the requested language/category, variables match the template body, and opted-out recipients are suppressed. Invalid/ineligible recipients are skipped or rejected according to the campaign consent validator. Recipient phone numbers and consent evidence are stored only inside that workspace's campaign recipient subcollection and are not returned by the campaign summary API.

### List campaign summaries
```http
GET /public/v1/campaigns?limit=50
Authorization: Bearer YOUR_JOY_API_KEY
```
Required scopes: `campaigns:read` for reports, `campaigns:write` for draft creation, and `campaigns:control` for state changes. The endpoint returns campaign summary fields and delivery counters for campaigns in the API key workspace only. It never returns recipient phone numbers or consent records. Results are ordered by creation time (newest first), with a page size from 1–100. Pass `pagination.nextCursor` as `cursor` to retrieve the next page.

### Control a campaign

Use the separate `campaigns:control` scope for campaign state changes. The draft-creation permission `campaigns:write` does not grant campaign control.

```http
POST /public/v1/campaigns
Authorization: Bearer YOUR_JOY_API_KEY
Idempotency-Key: campaign-control-123
Content-Type: application/json
```

Send `campaignId` and one supported `action`: `start`, `schedule`, `pause`, `resume` or `cancel`. For `schedule`, also send `scheduledAt` as a future ISO-8601 timestamp:
```json
{ "campaignId": "campaign-document-id", "action": "schedule", "scheduledAt": "2026-12-01T10:00:00.000Z" }
```

Every mutation requires a unique `Idempotency-Key`. State transitions are checked transactionally in the API key's workspace. Start, schedule and resume require at least one eligible recipient. The existing campaign worker rechecks current template approval, recipient consent, opt-out suppression and workspace message quota before sending. A successful `start` or `schedule` response queues or schedules the campaign; it does not guarantee Meta acceptance or device delivery.

## Approved WhatsApp templates

### List templates
```http
GET /public/v1/templates?phoneNumberId=PHONE_NUMBER_ID&wabaId=WABA_ID
Authorization: Bearer YOUR_JOY_API_KEY
```
Required scope: `templates:read`. Both IDs must belong to a connected WhatsApp number in the API key's workspace. The response returns template IDs, names, approval status, language, category and components. Set `limit` from 1–100 (default 50). When `pagination.nextCursor` is present, pass it as `cursor` with the same connected number and WABA ID to fetch the next page. `hasNext` indicates whether Meta reports another page.

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
- Supported scopes: `contacts:read`, `contacts:write`, `leads:read`, `leads:write`, `messages:write` (text, media, interactive and approved text-header template sends), `templates:read`, `campaigns:read`, `campaigns:write` (draft creation), and `campaigns:control` (start/schedule/pause/resume/cancel). Campaign control is intentionally separate from draft creation.
- Per-key rate-limit tiers are 60 (default), 120 and 300 requests per minute. Unsupported values are rejected. Older keys without a stored tier continue to use 60 requests per minute. Enable Firestore TTL on `publicApiRateLimits.expiresAt` and `publicApiUsageDaily.expiresAt` before production.
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
