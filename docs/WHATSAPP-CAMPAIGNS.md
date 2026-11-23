# WhatsApp Campaign API and Delivery Worker

The campaign API is organization-scoped. It creates drafts; sending starts only after an owner/admin explicitly calls the start action. A separate scheduled Lambda worker sends approved template messages in bounded batches.

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

New campaigns are saved as `draft`. Recipients are persisted under the campaign in batches of 400; the campaign is not published as a draft until every recipient batch is stored successfully. Partial preparation failures are marked `failed`.

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

The organization-scoped opt-out/suppression list is implemented for inbound STOP-style replies and draft filtering. Before production sending, the worker must re-check suppression immediately before each send, enforce recipient-level delivery idempotency, queue scheduling and rate limits, pause/cancel controls, delivery webhook reconciliation, and uncertain-delivery handling. Never send marketing messages to recipients without valid WhatsApp opt-in. Use approved templates for business-initiated messages outside the customer-service window.


## WhatsApp opt-out suppression

Inbound text replies matching standard opt-out keywords (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REMOVE and OPT OUT) create an organization-scoped suppression record. The webhook does not run greeting or keyword automation for that opt-out message. Campaign draft creation checks suppression records in bounded batches and excludes opted-out recipients while increasing the skipped-recipient count. Suppression is scoped to the organization and keyed by a SHA-256 hash of the normalized phone number.

This is a compliance safeguard for campaign preparation; a complete sending worker, campaign controls, and delivery reconciliation are still required before campaigns can be launched.


### Explicit WhatsApp re-subscription

A customer can explicitly send START, UNSTOP, or SUBSCRIBE to reactivate the organization-scoped suppression record. This is treated as a compliance event and does not trigger greetings or keyword automations. The record stores the inbound message ID, timestamp, and explicit inbound opt-in source; it does not store the raw phone number in the suppression document. Campaign drafts still require the recipient's separately supplied valid consent timestamp and source.
