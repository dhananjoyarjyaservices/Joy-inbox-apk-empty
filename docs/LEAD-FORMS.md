# Joy Inbox lead capture forms

Lead forms are workspace-owned CRM resources. Owners/admins and members with CRM contact-management permission can create, update, disable and review forms in **Sales CRM → Lead capture forms**.

## Public URLs

- Read a published form: GET /public/v1/forms/{formId}
- Submit a response: POST /public/v1/forms/{formId}/submissions

The workspace UI publishes a hosted page at /form/{formId}. The public page does not require a Joy Inbox account. Public API requests must originate from an origin allowed by the backend CORS_ORIGINS setting.

## Form schema

A form contains a name, description, 1–10 fields, submit-button label, success message, consent statement, enabled state and a setting to create a CRM lead from each valid submission.

Supported field types: text, email, phone, textarea, and select. Field keys are unique and values are validated server-side. Select options are defined by the workspace, not by the visitor.

Example submission:

~~~http
POST /public/v1/forms/0123456789abcdef01234567/submissions
Content-Type: application/json
Idempotency-Key: enquiry-visitor-session-0001
~~~

~~~json
{
  "values": {
    "full_name": "A User",
    "email": "person@example.com",
    "phone": "+919876543210",
    "message": "Please contact me."
  },
  "consent": true,
  "website": ""
}
~~~

The website field is a hidden honeypot. A non-empty honeypot is accepted as a no-op and does not create a lead or submission.

## Privacy and abuse controls

- The backend validates every field, rejects unknown keys, limits text length and validates email, international phone and select values.
- Consent is required by default. The exact consent text, acceptance state and timestamp are stored with the submission.
- Each source IP is represented by a SHA-256 hash; the raw IP address is not persisted.
- A transaction-backed limit allows at most five submissions per form/IP per minute.
- A required Idempotency-Key makes retries safe. The idempotency record, rate counter, submission and optional CRM lead are committed in one Firestore transaction.
- Public form configuration exposes only visitor-facing labels and options, not workspace actor metadata.
- Responses are tenant-scoped under organizations/{organizationId}/leadFormSubmissions; the owner/admin view shows the latest 100 responses and linked CRM lead IDs.
- Disabling a form prevents new reads/submissions while preserving existing responses.

## Firestore operations

Deploy firestore.indexes.json for the form response query. Configure Firestore TTL policies for:
- publicFormRateLimits.expiresAt
- publicFormIdempotency.expiresAt

These TTL policies are operational staging/production tasks; do not assume they are enabled just because the code writes expiry timestamps.

## Verification still required

Run the full backend emulator tests and frontend build. Then test a published form against an isolated staging Firebase project: public load, consent rejection, duplicate idempotency retry, rate-limit rejection, honeypot no-op, CRM lead creation, disabled-form rejection and tenant isolation. Confirm that the production CORS_ORIGINS allowlist includes the hosted app origin. Do not use real customer data until privacy and retention policies have been approved.
