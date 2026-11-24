# Joy Inbox outbound webhooks

The initial outbound webhook implementation supports workspace-managed HTTPS subscriptions and the `contact.upserted` event.

## Configure

1. Open the workspace inbox and select **Developer**.
2. Add a webhook name and HTTPS endpoint.
3. Subscribe to `contact.upserted`.
4. Copy the signing secret once and store it in your server-side secret manager.

The endpoint must use HTTPS, a public hostname and port 443. Localhost, private IPs, metadata endpoints and private DNS resolutions are rejected.

## Event delivery

Each event is placed in a durable server-side queue. A scheduled Lambda worker sends deliveries with:
- `X-Joy-Event`: event name.
- `X-Joy-Delivery`: stable delivery ID.
- `X-Joy-Timestamp`: Unix timestamp in seconds.
- `X-Joy-Signature`: HMAC-SHA256 signature over the exact raw JSON request body, formatted as `sha256=<hex>`.

Example Node.js verification:

```js
const crypto = require("crypto");

function verifyJoyWebhook(rawBody, signatureHeader, secret) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = Buffer.from(String(signatureHeader || ""));
  const expectedBytes = Buffer.from(expected);
  return received.length === expectedBytes.length && crypto.timingSafeEqual(received, expectedBytes);
}
```

Verify the signature against the exact raw request body before parsing JSON. Do not verify against re-serialized JSON.

## Retries and idempotency

- Delivery IDs are deterministic per workspace, subscription, event and source event ID.
- Duplicate event enqueue attempts do not create duplicate deliveries.
- Non-2xx responses and network failures are retried with exponential backoff.
- A delivery is marked failed after eight unsuccessful attempts.
- Revoked subscriptions cancel queued but not-yet-delivered events.
- Delivery records carry a 90-day `expiresAt` field. Enable Firestore TTL on `webhookDeliveryQueue.expiresAt` before production.

## Current scope and remaining work

- Implemented event: `contact.upserted` from the workspace contact manager and public contacts API.
- Message event names are reserved but must be connected to inbound/outbound message and status webhook paths before they are offered to customers.
- Delivery history UI, manual replay, endpoint secret rotation and configurable retry policies remain to be added.
- The scheduled worker currently processes a bounded batch of deliveries alongside SLA and automation checks; isolate it into its own schedule after staging load tests.
