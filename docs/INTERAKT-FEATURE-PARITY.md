# Interakt feature-parity audit — Joy Inbox

**Audit date:** 2026-11-24  
**Audited branch:** `feature/saas-foundation`  
**Audited head before this audit:** `fa045719159cd83bbd94de195f32cd41482e47bb`  
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
| Customer profile, contacts, notes and tags | Partial | Contact fields, notes, tags and bulk tag operations exist; typed custom fields are now available on CRM leads, but not yet fully integrated into contact profiles. |
| Internal team notes | Implemented (code) | Authenticated tenant internal-notes API/UI. |
| Quick replies, including saved images | Implemented (code) | Searchable quick replies and image upload/proxy/send paths. |
| Rich WhatsApp text/media/templates | Implemented (code) | Tenant text/media/template paths; actual Meta delivery needs staging tests. |
| Interactive buttons, lists, CTA URL and carousel | Implemented (code) | Backend validates button/list/CTA/carousel payloads; real Meta compatibility still needs staging validation. |
| WhatsApp catalog/product messages | Missing | No catalog sync/management or catalog-message workflow found. |
| Payment links / WhatsApp Pay / order management | Missing | Stripe is for Joy Inbox subscription billing, not customer checkout or WhatsApp-native commerce. |
| Greeting / welcome automation | Implemented (code) | Tenant greeting settings and inbound webhook trigger. |
| Out-of-office, delayed reply and FAQ automation | Partial | Greeting plus keyword-triggered short sequential rules exist; no complete schedule-aware OOO/delayed/FAQ suite. |
| Visual no-code chatbot builder, branching, API calls and intent routing | Missing | Current automation is keyword matching with up to five reply steps; no visual flow builder, branching conditions, API action nodes or intent model. |
| Campaigns/broadcasts and consent safeguards | Implemented (code) | Draft/schedule/pause/cancel, approved-template revalidation, opt-in evidence, STOP/START suppression, delivery reconciliation. Provider acceptance remains pending. |
| Campaign click/conversion attribution and advanced segmentation | Partial | Delivery/read/failure reporting exists; no complete click/conversion attribution or advanced campaign segmentation found. |
| SLA monitoring and agent performance | Implemented (code) | SLA settings/worker, notifications and historical agent response metrics. |
| Team management, roles and invitations | Implemented (code) | Owner/admin/agent permissions, hashed invitations, verified-email acceptance and seat enforcement. Email sending provider is not configured. |
| Notification center, push and sound | Implemented (code) | Tenant notifications, push-device registration/preferences and notification sound hooks; real-device acceptance pending. |
| Subscription plans, 7-day trial and usage enforcement | Partial / external validation pending | Monthly/annual plan logic, trial policy, quotas and Stripe Checkout/Portal/webhook code exist. Actual ten Stripe Price IDs, test checkout lifecycle and live payment activation are not configured. |
| Public developer APIs and customer-configurable outbound webhooks | Missing | Internal application routes are not a documented, versioned public API product; no customer webhook subscription/delivery management found. |
| Instagram inbox and Instagram automation | Missing | No Instagram channel integration or inbox implementation found. |
| RCS channel and WhatsApp-to-RCS fallback | Missing | No RCS provider/channel implementation found. |
| Click-to-WhatsApp ads launcher/conversion analytics | Missing | No CTWA ad management or Meta conversion-event pipeline found. |
| Sales CRM pipeline, lead stages and owner routing | Partial | Initial tenant-scoped pipeline, five default stages, custom stages, typed lead fields, contact linking, member owner assignment, lead editing and follow-up dates now exist. Automated reminders, bulk import, lead activity timeline, forecasting and sales reporting remain missing. |
| Shopify/WooCommerce and other commerce integrations | Missing | No production commerce integration/sync workflow found. |
| WhatsApp Forms / lead capture forms | Missing | No form builder, form send workflow or response-management module found. |
| AI Copilot, AI AnswerBot, AI agents and intent automation | Missing | No AI generation/runtime, knowledge base ingestion, agent tool execution or AI workflow code found. |
| WhatsApp voice calling / voice AI | Missing | No calling or voice-agent implementation found. |
| Cross-channel omnichannel inbox | Missing | Current product is WhatsApp-focused; no Instagram/RCS unified conversation model found. |

## Repository-only release gates still open

Even implemented code is not accepted for launch until the external staging checks are complete:
- Firebase project connection, Auth/Firestore rules/index deployment, tenant-isolation and rollback verification.
- Meta app credentials, phone-number/WABA mapping, webhook subscriptions, template/media send and real inbound/status delivery.
- Stripe test secrets, ten monthly/annual recurring Price IDs, Checkout/Portal, trial-end, cancellation and failed-invoice lifecycle.
- AWS staging Lambda/EventBridge deployment, IAM isolation and scheduled-worker execution.
- Transactional email provider and invitation delivery/retry tests.
- Backup/restore rehearsal, concurrency/load/security testing, mobile/accessibility review, legal/privacy/consent and billing/tax review.

Firebase remains intentionally deferred until all repository-only work is complete, as requested by the project owner. Do not request Firebase credentials during code-only work. Never commit secrets or place server secrets in Vite variables.

## Recommended implementation order for missing product scope

1. **CRM foundation:** custom fields, lead records, sales pipeline stages, owner assignment, filtering and reports.
2. **Public API/webhooks:** versioned API keys with scopes/rotation, rate limits, idempotency, signed outbound webhook delivery, retries and audit logs.
3. **Automation builder:** branch/condition nodes, schedules, OOO/delayed replies, FAQ knowledge entries and safe API action nodes.
4. **Commerce:** catalog/product sync and customer payment-link/order lifecycle (separate from subscription billing).
5. **Forms and campaign attribution:** lead forms, response mapping, click/conversion events and segmentation.
6. **Additional channels:** Instagram first, then RCS; requires provider permissions, channel-specific data model and end-to-end tests.
7. **AI and voice:** opt-in AI assistant/agent runtime with data boundaries, review controls and cost/abuse protections; voice only after provider and compliance review.

The missing items above are product work, not something that can be made complete by changing environment variables. They require new UI, APIs, data models, workers, tests and provider integrations. Do not mark them complete until implemented and verified.
