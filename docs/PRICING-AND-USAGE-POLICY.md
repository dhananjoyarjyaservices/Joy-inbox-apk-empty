# Joy Inbox pricing and usage policy

**Status:** Approved product design; not yet a production billing configuration.
**Billing currency:** INR
**Billing cadence:** Monthly only at launch
**WhatsApp charges:** Paid directly by each customer to Meta; excluded from Joy Inbox subscription fees.

## Monthly plans

| Plan | Price / month | Messages / month | Active agents | Media transfer / month | Searchable history |
|---|---:|---:|---:|---:|---:|
| Lite | ₹299 | 10,000 | 1 | 1 GB | 3 months |
| Starter | ₹599 | 40,000 | 2 | 3 GB | 6 months |
| Growth | ₹999 | 100,000 | 5 | 6 GB | 12 months |
| Business | ₹1,499 | 150,000 | 5 | 6 GB | 12 months |
| Pro | ₹1,999 | 300,000 | 10 | 15 GB | 12 months |

All plans include the same core product features. Plan differences are usage limits, agent seats and history retention. Amounts are before applicable taxes. No annual billing or paid overage is offered at launch.

## Seven-day free trial

- One seven-day trial per organization/workspace.
- Trial starts when Stripe creates the subscription, not when the user first visits the pricing page.
- Trial plan is selected at checkout; the customer can use the features included in that plan.
- Trial usage allowance is 25% of each monthly plan quota, rounded up to the next whole unit (messages, GB transfer); agent seat limit and history policy remain the selected plan's full limits.
- At the end of the trial, Stripe converts the subscription according to its configured payment-method and trial-end behavior. Configure and test this behavior in Stripe test mode before launch.
- A workspace that has already used its trial does not receive another free trial on a later subscription.
- If the trial allowance is exhausted early, the same outbound block rules below apply.

## Usage measurement and reset

- Message usage counts unique inbound WhatsApp messages accepted by the webhook plus outbound messages accepted by Meta. Deduplicate inbound messages by provider message ID. Do not count failed outbound attempts or duplicate webhook deliveries.
- Media transfer counts bytes actually transferred through Joy Inbox's media proxy/upload/download path, not the size of media merely referenced by a Meta media ID.
- Active agents count active workspace members who consume an agent seat; pending invitations do not consume a seat until accepted.
- Usage periods follow the Stripe subscription billing period. Trial usage is tracked separately and resets to the full monthly allowance when the paid period begins.
- Usage is organization-scoped. Never aggregate or expose usage across organizations.

## Hard-limit behavior (no automatic overage)

- Notify workspace owners at 80%, 95% and 100% of each quota.
- At the message limit, block new outbound sends from every channel (text, media, template, interactive and quick reply) with a clear usage_limit_reached response and upgrade instructions.
- Continue accepting and storing inbound WhatsApp webhooks and keep existing conversation history readable; do not drop customer messages because an outbound quota is exhausted.
- At the media-transfer limit, block further media transfers through Joy Inbox. Text messages remain available if message quota remains.
- At the active-agent limit, prevent adding or activating another agent; existing agents retain access.
- Never silently upgrade a customer or charge an overage. An owner must explicitly choose and pay for a higher plan.
- On successful plan upgrade, apply the new plan's limits immediately. On renewal, reset usage only after confirming the new billing period.

## History retention and media handling

- Retention is measured from message creation time. The plan controls how far back messages remain searchable.
- Expired message records are eligible for deletion only after a scheduled retention job is implemented, tested and documented. Do not claim automatic deletion until that job is active.
- Customer media bytes are not permanently stored by default. Keep only the metadata and provider media identifiers required by the product; transfer limits still apply to media bytes served or uploaded by Joy Inbox.

## Implementation and launch gates

The current Stripe integration foundation supports plan discovery, Checkout, Billing Portal and signed webhook synchronization. The backend plan catalog and seven-day one-time trial are wired to this policy. However, message/media/agent quota counters, atomic quota enforcement across every send route, usage alerts, retention deletion, Stripe trial-end behavior and full staging tests are not yet complete.

**Do not enable live paid checkout or advertise these limits as enforced until all quota checks are server-side, transaction-safe, tenant-isolated, tested for concurrent sends and wired into every outbound send path.** Configure the five real monthly Stripe Price IDs only after the final prices are approved in the Stripe Dashboard.