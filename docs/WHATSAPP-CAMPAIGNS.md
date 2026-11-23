# WhatsApp Campaign Draft API

The campaign draft API is an organization-scoped foundation. It does not send messages yet.

## Permissions

Only workspace owners and admins with `settings:manage` can create or list campaigns.

## Create a draft

`POST /organizations/campaigns`

Required fields:
- `organizationId`
- `name`
- `phoneNumberId` and `wabaId` for a connected number
- `templateName`, `language`, and `category`
- `recipients` (1–5,000 entries)

Each recipient must provide:
- `phone` (international number)
- `optedIn: true`
- `consentAt` (parseable date/time)
- `consentSource` (for example, website form or checkout)

Optional campaign-level `variables` provide default BODY text variables. Each recipient may override them with its own `variables`.

The API removes duplicate phone numbers and skips recipients without valid consent evidence. It verifies that the selected number belongs to the organization and asks Meta to confirm the template is approved for the selected language and category. The first version supports BODY text variables only; media headers and dynamic URL buttons are rejected.

New campaigns are saved as `draft`. Recipients are persisted under the campaign in batches of 400. The current endpoint does not enqueue, schedule, pause, or send a campaign.

## List drafts

`GET /organizations/campaigns?organizationId=...`

Returns the latest 50 campaign summaries.

## Example request body

```json
{
  "organizationId": "workspace_id",
  "name": "November update",
  "phoneNumberId": "123456789",
  "wabaId": "987654321",
  "templateName": "november_update",
  "language": "en",
  "category": "MARKETING",
  "variables": ["November"],
  "recipients": [
    {
      "phone": "+919876543210",
      "optedIn": true,
      "consentAt": "2026-11-20T10:00:00.000Z",
      "consentSource": "website signup"
    }
  ]
}
```

## Before production sending

Add an authoritative organization-wide opt-out/suppression list, recipient-level delivery idempotency, queue scheduling and rate limits, pause/cancel controls, delivery webhook reconciliation, and a campaign worker. Never send marketing messages to recipients without valid WhatsApp opt-in. Use approved templates for business-initiated messages outside the customer-service window.
