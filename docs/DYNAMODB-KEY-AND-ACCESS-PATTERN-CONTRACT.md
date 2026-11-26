# DynamoDB key and access-pattern contract

Status: proposed application contract for the three existing empty tables. The AWS console inspection on 2026-11-26 confirmed the table names, `PK`/`SK` string key attributes, Mumbai region, on-demand billing, and zero GSIs. It did not expose any item data. No live table settings or data are changed by this contract.

## Existing tables

| Environment variable | Existing table | Purpose |
|---|---|---|
| `DYNAMODB_WORKSPACES_TABLE` | `JoyInboxWorkspaces` | Workspace records, memberships, and reverse user-to-workspace membership pointers |
| `DYNAMODB_CUSTOMERS_TABLE` | `JoyInboxCustomers` | Workspace customer records and conversation summary records |
| `DYNAMODB_MESSAGES_TABLE` | `JoyInboxMessages` | Immutable-ish message records grouped by conversation |

All items use string `PK` and `SK`. Region must be configured as `ap-south-1`.

## Key patterns

### Workspaces table

| Record | PK | SK |
|---|---|---|
| Workspace | `ORG#{organizationId}` | `WORKSPACE` |
| Workspace member | `ORG#{organizationId}` | `MEMBER#{uid}` |
| User membership pointer | `USER#{uid}` | `ORG#{organizationId}` |

The reverse pointer supports listing a user's workspaces without a GSI. It is an index record maintained transactionally alongside the workspace membership record. The authenticated Firebase UID is always taken from the verified ID token, never from an untrusted request field.

### Customers table

| Record | PK | SK |
|---|---|---|
| Customer | `ORG#{organizationId}` | `CUSTOMER#{customerId}` |
| Conversation summary | `ORG#{organizationId}` | `CONVERSATION#{conversationId}` |

A conversation summary contains only the list/detail fields needed by the inbox (for example customer ID, status, assignment, last-message preview, and timestamps). The canonical message history remains in the messages table.

### Messages table

| Record | PK | SK |
|---|---|---|
| Message | `ORG#{organizationId}#CONVERSATION#{conversationId}` | `MESSAGE#{timestampPadded}#{messageId}` |

Timestamps are integer epoch milliseconds, left-padded to 16 decimal digits so lexicographic order matches chronological order. Message IDs are unique within a conversation.

## Access patterns supported without GSIs

1. Get workspace by ID: exact `PK=ORG#id, SK=WORKSPACE`.
2. Get one workspace member: exact `PK=ORG#id, SK=MEMBER#uid`.
3. List workspace members: query workspace partition with `SK begins_with MEMBER#`.
4. List workspaces for a verified user: query `PK=USER#uid`.
5. List workspace customers: query `PK=ORG#id` with `SK begins_with CUSTOMER#`.
6. List workspace conversation summaries: query `PK=ORG#id` with `SK begins_with CONVERSATION#`.
7. List messages in one conversation: query its conversation partition, ordered by `SK`.

No GSI is specified in this first contract. Search by arbitrary phone/name, global inbox ordering across conversations, status/assignee filtering at scale, campaign audience segmentation, and analytics are not served efficiently by these base-table keys. Those require a separately designed and reviewed index/materialized-view strategy before those features are moved to DynamoDB. Do not use table scans as a substitute.

## Consistency and write rules

- Workspace membership and reverse user pointer must be created, updated, or removed in one DynamoDB transaction.
- Every workspace-scoped read/write must derive organization ID from a server-verified membership context and validate the partition prefix.
- Never trust a client-provided `PK`, `SK`, or organization ID as authorization.
- Message writes must be idempotent using the provider message ID as the message ID where available, with a conditional put.
- Conversation summary updates and message writes should use a transaction only when the full transaction fits DynamoDB limits; otherwise use an idempotent outbox/reconciliation workflow.
- Keep Firebase Authentication. Do not migrate auth identities into DynamoDB.
- Do not delete or disable Firestore until parity tests, backfill verification, staged cutover, and rollback have passed.

## Operational gates

- The three existing tables currently have PITR Off. Enable PITR only with the AWS account owner's approval after reviewing the added cost.
- No GSIs are currently provisioned. Do not create indexes until query volume and access patterns are reviewed.
- Tables were empty at inspection time; verify again before any writes/backfill.
- This contract is an application design proposal, not evidence of deployed data or a completed Firestore migration.
