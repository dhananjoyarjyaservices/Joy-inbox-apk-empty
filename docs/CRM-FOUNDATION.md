# Joy Inbox CRM foundation

This repository now includes an initial tenant-scoped sales CRM module. It is a first implementation milestone, not full Interakt CRM parity.

## Included in code

- Workspace-scoped sales pipeline with five initial stages: New, Qualified, Proposal, Won and Lost.
- Up to 20 pipeline stages per workspace.
- Stage order, active state, and Won/Lost outcome markers.
- Up to 30 custom CRM field definitions per workspace.
- Custom field types: text, number, date, boolean and select.
- Required-field validation, option validation, type validation and inactive-field protection.
- Tenant-scoped leads with title, stage, source, value/currency, owner UID, optional linked contact ID, follow-up timestamp, notes and custom field values.
- Lead stage movement and deletion.
- Server-side Firebase ID-token authentication, active organization membership checks and role permission checks.
- Owner/admin-only custom field and pipeline configuration; workspace contacts permission required to read CRM definitions and manage leads.
- Leads can only link to contacts and owners belonging to the same workspace.
- Agent CRM access is limited server-side to leads assigned to that agent; agents cannot reassign or delete another agent's leads or configure pipeline/custom fields.

## API

All routes are internal authenticated application APIs. They are not public API-key endpoints.

- GET /organizations/crm/fields?organizationId=...
- POST /organizations/crm/fields with { organizationId, data }
- PUT /organizations/crm/fields with { organizationId, resourceId, data }
- DELETE /organizations/crm/fields with { organizationId, resourceId } — soft-deactivates the field to preserve historical lead values.
- GET /organizations/crm/stages?organizationId=... — initializes the default pipeline when none exists.
- POST /organizations/crm/stages with { organizationId, data }
- PUT /organizations/crm/stages with { organizationId, resourceId, data }
- DELETE /organizations/crm/stages with { organizationId, resourceId } — refuses to delete the default stage or a stage still used by leads.
- GET /organizations/crm/leads?organizationId=...
- POST /organizations/crm/leads with { organizationId, data }
- PUT /organizations/crm/leads with { organizationId, resourceId, data }
- DELETE /organizations/crm/leads with { organizationId, resourceId }

## Data layout

- organizations/{organizationId}/crmFields/{fieldKey}
- organizations/{organizationId}/crmStages/{stageId}
- organizations/{organizationId}/crmLeads/{leadId}

No cross-organization queries are used. The backend verifies linked contact and owner membership before writing a lead.

## Current UI

The Tenant Inbox now has a Sales CRM workspace view with:
- Create leads and set a starting stage, source and deal value.
- Edit leads and move them between pipeline columns.
- Set follow-up dates and visually flag overdue follow-ups on lead cards.
- Link leads to existing workspace contacts and assign them to active workspace members.
- Add custom field definitions and capture values when creating leads.
- Add pipeline stages.
- Delete leads.

## Remaining CRM work

The initial CRM slice now includes scheduled follow-up reminders, validated CSV lead import (up to 200 rows per upload), sales reporting, lead activity history and probability-weighted pipeline forecasts. Remaining product work is:

- Contact-profile integration for typed custom fields and richer lead/contact deduplication across imports.
- Saved filters, reusable segments, custom events and conversion attribution.
- CRM-specific permission roles beyond the current owner/admin/agent model.
- Full browser-level workflow tests and real-workspace validation of forecast probabilities and report accuracy.

## Security and rollout

All data remains under the authenticated workspace path. Custom field keys and stage IDs are normalized and constrained. Stage deletion is blocked while leads still reference it; custom field deletion is a soft deactivation. Firebase connection and staging verification remain deferred until the repository-only phase is complete, as requested. Do not put service credentials in the frontend.

## Automated follow-up reminders

- Leads with a due `nextFollowUpAt` are scanned by the scheduled worker.
- A reminder is sent to the assigned active workspace member only; unassigned leads are left for manual triage.
- Won, lost and inactive-stage leads are excluded.
- The worker writes an in-app notification and sends a push notification, using a deterministic notification ID. Members can disable CRM follow-up alerts in Notification preferences; sound and desktop delivery preferences are also respected. CRM follow-ups appear in the Notification Center and open Sales CRM when selected.
- Reminder claims are transactional and keyed to the exact follow-up timestamp to avoid duplicate sends across overlapping scheduler invocations. Failed deliveries release the claim for retry.
- The existing EventBridge `src/index.slaScheduledHandler` now runs this worker alongside SLA and automation checks. Schedule it at a five-minute cadence in staging after deploying the updated Lambda package.


## CSV bulk import

Owners and admins can import up to 200 leads per upload from the Sales CRM screen. The importer accepts quoted CSV cells and requires a `title` header. Supported optional columns are `stage_id` (defaults to `new`), `contact_id`, `owner_uid`, `source`, `value`, `currency` (defaults to INR), `next_follow_up_at` and `notes`.

Every row is validated against the workspace's active pipeline stages, contacts, active members and configured custom fields. Invalid rows are reported with their CSV row number while valid rows are committed together in a single Firestore batch. Imports emit the same signed `lead.created` webhook events as individual lead creation.


## Sales performance reporting

The Sales CRM screen includes a workspace-scoped report for total, open, won and lost leads; open pipeline value; won revenue; closed-deal win rate; pipeline stage totals; lead-owner performance; and lead sources. Owners/admins see workspace totals. Agents see only leads assigned to themselves. Reports scan the 1,000 most recently updated leads at most and display a capped-sample warning when that limit is reached. INR totals power the headline cards. Other currencies are shown in separate currency buckets and are never added together or converted automatically.


## Lead activity timeline

Each lead stores an append-only activity history in its own `crmLeads/{leadId}/activity` subcollection. Lead creation, tracked-field updates and deletion write an actor-attributed event. Update events list the fields that changed and retain a limited before/after snapshot (title, stage, owner, deal value/currency, source, follow-up date and linked contact). Free-form notes and custom-field values are deliberately excluded from the audit snapshot. The authenticated timeline endpoint checks workspace membership and agent lead assignment before returning the latest 1–100 events. The pipeline card exposes the timeline on demand.


## Probability-weighted pipeline forecast

Each CRM pipeline stage supports an integer win probability from 0 to 100. New stages default to 50%; closed-won and closed-lost stages default to 100% and 0%. Workspace admins can choose the probability when creating a stage. Sales reporting adds an expected open-pipeline amount by multiplying each open lead value by its stage probability. Currency totals remain separated; no foreign-exchange conversion is implied. Forecasts are directional estimates, not guaranteed revenue.
