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
- Move leads between pipeline columns.
- Add custom field definitions and capture values when creating leads.
- Add pipeline stages.
- Delete leads.

## Remaining CRM work

- Link a lead to a selected contact through a searchable contact picker (current API supports contactId, but initial UI leaves it blank).
- Edit existing lead details and custom field values from the UI.
- Assign/reassign lead owners from a member picker.
- Follow-up reminders and overdue queues.
- Bulk contact/lead import and deduplication.
- Saved filters, segments, lead activity timeline, custom events and conversion analytics.
- Sales reporting, forecast totals, stage conversion and agent performance by pipeline.
- Permission scopes for CRM-only roles beyond the current owner/admin/agent model.
- Automated integration tests for Firestore CRM CRUD and full browser-level CRM workflows.

## Security and rollout

All data remains under the authenticated workspace path. Custom field keys and stage IDs are normalized and constrained. Stage deletion is blocked while leads still reference it; custom field deletion is a soft deactivation. Firebase connection and staging verification remain deferred until the repository-only phase is complete, as requested. Do not put service credentials in the frontend.