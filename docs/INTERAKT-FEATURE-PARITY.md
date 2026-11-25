# Interakt feature-parity audit — Joy Inbox

**Audit date:** 2026-11-25  
**Audited branch:** `feature/saas-foundation`  
**Audited code head:** `57d8aad9d7a7e6d3d41cd5d56625be9d66f8234c`  
**Scope:** Repository code and automated-test evidence only. This is not a live-provider acceptance test.

## Executive finding

Joy Inbox has a substantial multi-tenant WhatsApp inbox/SaaS foundation, but it does **not** currently implement every capability publicly advertised by Interakt. It must not be described as feature-equivalent or production-ready.

Interakt's public product pages currently advertise capabilities across WhatsApp and Instagram shared inbox, RCS, AI agents/chatbots, sales CRM/pipeline, campaign analytics, Click-to-WhatsApp ads, catalogs/commerce/payments, forms, APIs/webhooks, voice/calling and integrations. This audit compares repository evidence against those public categories; plan availability varies by Interakt tier.

Reference pages:
- https://www.interakt.shop/
- https://www.interakt.shop/pricing-us/
- https://www.interakt.shop/resource-center/

## Feature matrix

Legend:
- **Implemented (code):** Feature has a code path and relevant tests/UI evidence in this branch.
- **Partial:** A narrower version exists; the complete Interakt-style workflow is not present.
- **Missing:** No complete implementation was found in the reviewed repository.
- **External validation pending:** Code foundation exists, but real provider setup and staging verification are still required.

| Interakt capability | Joy Inbox status | Repository evidence / gap |
|---|---|---|
| WhatsApp shared team inbox | Implemented (code) | Tenant Inbox, organization-scoped chats/messages, member roles and tenant APIs. |
| WhatsApp self-service onboarding | Implemented (code) / external validation pending | Meta Embedded Signup v4-compatible UI and backend authorization-code exchange, WABA/phone ownership validation, server-generated two-step PIN, phone registration, WABA webhook subscription and encrypted tenant credential storage. Requires Meta app/config IDs, server app secret, Tech Provider/Solution Partner eligibility, App Review and real staging validation. |
| Chat assignment/reassignment and open/pending/resolved | Implemented (code) | Tenant chat assignment/state APIs and UI. |
| Pin, archive, search and paginated message history | Implemented (code) | Tenant Inbox and pagination services. |
| Customer profile, contacts, notes, tags and typed custom fields | Implemented (code foundation) | Workspace-defined text, number, date, boolean and select fields are validated server-side and saved directly on tenant contact profiles; fields are also available on CRM leads and CSV import. Customer profile UI exposes typed editors. Full browser-level and real-workspace acceptance remains pending. |
| Internal team notes | Implemented (code) | Authenticated tenant internal-notes API/UI. |
| Quick replies, including saved images | Implemented (code) | Searchable quick replies and image upload/proxy/send paths. |
| Rich WhatsApp text/media/templates | Implemented (code) | Tenant text/media/template paths; actual Meta delivery needs staging tests. |
| Interactive buttons, lists, CTA URL and carousel | Implemented (code) | Backend validates button/list/CTA/carousel payloads; real Meta compatibility still needs staging validation. |
| WhatsApp catalog/product messages | Missing | No catalog sync/management or catalog-message workflow found. |
| Payment links / WhatsApp Pay / order management | Missing | Stripe is for Joy Inbox subscription billing, not customer checkout or WhatsApp-native commerce. |
| Greeting / welcome automation | Implemented (code) | Tenant greeting settings and inbound webhook trigger. |
| Out-of-office, delayed reply and FAQ automation | Partial | Greeting plus keyword-triggered rules exist, with up to five ALL/ANY trigger conditions, six match operators, timezone-aware weekday/time windows, and up to five conditional reply branches with separate reply sequences. The tenant automation screen exposes schedule and branch editing. Backend rules support a validated out-of-office fallback message selected only when a matching rule is outside its configured local business-hours window. Out-of-office replies can be paused independently from the parent keyword rule, without disabling its normal replies. They have a per-customer 24-hour cooldown and a short transactional send lock to prevent duplicate replies during concurrent inbound messages; execution history records cooldown/in-progress skips. Full workspace-wide OOO state, independent OOO schedules and pause/override controls remain incomplete. A tenant FAQ knowledge base now supports up to 100 entries, validated question/answer/keyword fields, ALL/ANY keyword matching, priority, enable/pause/edit/delete controls, and deterministic automatic replies only when no keyword rule matches and the WhatsApp 24-hour service window is open. This is keyword matching, not AI-generated answering. Workspace-wide OOO state, independent OOO schedules and global pause/override controls, visual canvas/drag-and-drop builder, and richer delay controls remain incomplete. |
| Visual no-code chatbot builder, branching, API calls and intent routing | Partial / missing | Backend and tenant automation UI support up to five ALL/ANY keyword trigger conditions (`contains`, `exact`, `starts_with`, `ends_with`, `not_contains`, `not_exact`), priority ordering, timezone-aware weekday/time schedules, and up to five ordered conditional branches, each with its own conditions and up to five delayed reply steps. The UI provides form-based branch editing with 1–5 conditions (ALL/ANY) and 1–5 delayed reply steps per branch, plus a synchronized workflow diagram that previews trigger, schedule, branch and reply paths as the form changes. Branches, trigger conditions, branch conditions and reply steps can be reordered by dragging their handles or using arrow controls; reordering updates the underlying editor state. This is a constrained sequence editor, not a free-position graph canvas: arbitrary node placement and custom connector editing are not supported. Execution history records the selected branch and per-step queued/sent/failed/uncertain/skipped outcomes. Still missing: free-position drag-and-drop graph canvas and custom connector editing, API/action nodes, FAQ knowledge base and intent routing. |
| Campaigns/broadcasts and consent safeguards | Implemented (code) | Draft/schedule/pause/cancel, approved-template revalidation, opt-in evidence, STOP/START suppression, delivery reconciliation. Provider acceptance remains pending. |
| Campaign click/conversion attribution and advanced segmentation | Partial | Delivery/read/failure reporting exists; no complete click/conversion attribution or advanced campaign segmentation found. |
| SLA monitoring and agent performance | Implemented (code) | SLA settings/worker, notifications and historical agent response metrics. |
| Team management, roles and invitations | Implemented (code) | Owner/admin/agent permissions, hashed invitations, verified-email acceptance and seat enforcement. Email sending provider is not configured. |
| Notification center, push and sound | Implemented (code) | Tenant notifications, push-device registration/preferences and notification sound hooks; real-device acceptance pending. |
| Subscription plans, 7-day trial and usage enforcement | Partial / external validation pending | Monthly/annual plan logic, trial policy, quotas and Stripe Checkout/Portal/webhook code exist. Actual ten Stripe Price IDs, test checkout lifecycle and live payment activation are not configured. |
| Public developer APIs and customer-configurable outbound webhooks | Partial / implemented code foundations | Versioned contacts and CRM leads read/write endpoints use hashed, expiring scoped API keys, cursor pagination, 24-hour mutation idempotency and daily per-key usage analytics. `POST /public/v1/messages` supports text, Meta-hosted media upload, validated interactive button/list/CTA/carousel sends and approved text-header template sends with `messages:write`, required idempotency, quota enforcement and template consent/opt-out checks. `GET /public/v1/templates` supports cursor pagination; `GET /public/v1/campaigns` provides paginated tenant-scoped summaries; campaign draft/control endpoints and signed outbound webhooks with HMAC, retry, history, filters, cursor pagination, replay and secret rotation are implemented. Still missing: public template create/update/delete, media-header template sends, advanced campaign analytics and full staging verification. |
| Instagram inbox and Instagram automation | Missing | No Instagram channel integration or inbox implementation found. |
| RCS channel and WhatsApp-to-RCS fallback | Missing | No RCS provider/channel implementation found. |
| Click-to-WhatsApp ads launcher/conversion analytics | Missing | No CTWA ad management or Meta conversion-event pipeline found. |
| Sales CRM pipeline, lead stages and owner routing | Implemented code foundation / partial advanced parity | Tenant-scoped pipeline, custom stages and typed lead fields, contact linking, member assignment, follow-up dates/reminders, CSV import, sales reports, append-only activity history, weighted forecasting, saved filters and transactional duplicate-contact merge with audit records are implemented. Real workspace validation and advanced segmentation/conversion attribution remain open. |
| Shopify/WooCommerce and other commerce integrations | Missing | No production commerce integration/sync workflow found. |
| WhatsApp Forms / lead capture forms | Partial / implemented code foundation | Workspace form builder and hosted public form page support 1–10 validated fields, editable labels/types/select options, configurable consent and CRM conversion, publish/disable, honeypot, IP-hash rate limits, transactional idempotent submissions, CRM contact upsert from submitted phone numbers, linked CRM lead creation and tenant-scoped response history. Meta WhatsApp Flows/forms message sending and real staging/privacy acceptance remain missing. |
| AI Copilot, AI AnswerBot, AI agents and intent automation | Missing | No AI generation/runtime, knowledge base ingestion, agent tool execution or AI workflow code found. |
| WhatsApp voice calling / voice AI | Missing | No calling or voice-agent implementation found. |
| Cross-channel omnichannel inbox | Missing | Current product is WhatsApp-focused; no Instagram/RCS unified conversation model found. |

## Repository-only release gates still open

Even implemented code is not accepted for launch until the external staging checks are complete:
- Firebase project connection, Auth/Firestore rules/index deployment (including leadFormSubmissions composite index), TTL policies for form idempotency/rate-limit collections, tenant-isolation and rollback verification.
- Meta app credentials, phone-number/WABA mapping, webhook subscriptions, template/media send and real inbound/status delivery.
- Stripe test secrets, ten monthly/annual recurring Price IDs, Checkout/Portal, trial-end, cancellation and failed-invoice lifecycle.
- AWS staging Lambda/EventBridge deployment, IAM isolation and scheduled-worker execution.
- Transactional email provider and invitation delivery/retry tests.
- Backup/restore rehearsal, concurrency/load/security testing, mobile/accessibility review, legal/privacy/consent and billing/tax review.

Firebase remains intentionally deferred until all repository-only work is complete, as requested by the project owner. Do not request Firebase credentials during code-only work. Never commit secrets or place server secrets in Vite variables.

## Recommended implementation order for missing product scope

1. **CRM foundation:** custom fields, lead records, sales pipeline stages, owner assignment, filtering and reports.
2. **Public API/webhooks:** extend current contacts/leads API with message, campaign and template endpoints, configurable rate tiers, and richer delivery filters/analytics.
3. **Automation builder:** branch/condition nodes, schedules, OOO/delayed replies, FAQ knowledge entries and safe API action nodes.
4. **Commerce:** catalog/product sync and customer payment-link/order lifecycle (separate from subscription billing).
5. **Forms and campaign attribution:** WhatsApp Forms/lead capture and CRM contact/lead conversion now have an initial implementation; remaining work is Meta WhatsApp Flows integration, response-to-custom-field mapping, click/conversion events and advanced segmentation.
6. **Additional channels:** Instagram first, then RCS; requires provider permissions, channel-specific data model and end-to-end tests.
7. **AI and voice:** opt-in AI assistant/agent runtime with data boundaries, review controls and cost/abuse protections; voice only after provider and compliance review.

The missing items above are product work, not something that can be made complete by changing environment variables. They require new UI, APIs, data models, workers, tests and provider integrations. Do not mark them complete until implemented and verified.
