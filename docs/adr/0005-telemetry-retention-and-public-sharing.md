# ADR 0005: Telemetry, Retention, and Public Sharing

- Status: Accepted
- Date: 2026-07-25
- Issue: #2

## Context

Web requests, background jobs, tracker effects, and isolated runs cross process
boundaries and need end-to-end diagnostics. Telemetry and retained artifacts
can expose source code, prompts, client data, credentials, or share tokens if
collected indiscriminately. Clients also need a constrained way to inspect
selected results without gaining control-plane access.

## Decision

Use OpenTelemetry for traces, metrics, and structured log correlation. Propagate
W3C trace context through HTTP, `pg-boss` jobs, inbox/outbox processing, and
runner envelopes. Standard attributes include service, environment, tenant
identifier, operation, job type, tracker provider, and outcome. High-cardinality
run or delivery IDs may appear in traces and logs but not as metric dimensions.

Instrumentation is data-minimal:

- do not record secrets, authorization headers, cookies, share tokens, source
  bodies, prompts, artifact contents, or raw tracker payloads;
- use allowlisted structured fields and centralized redaction;
- truncate and classify error details before export;
- sample successful high-volume traces while retaining errors according to
  policy;
- expose queue age, retry count, sync drift, run duration, and failure counts.

Retention is policy-driven by data class, tenant, and environment. PostgreSQL
records deletion eligibility and legal holds; workers perform deletion from
telemetry backends and artifact storage and record the outcome. A default
retention period is not hard-coded into domain behavior. Deleting expired data
must preserve only the minimum audit tombstone required by policy.

Public client sharing is disabled by default. When enabled, a share is a
read-only projection backed by a PostgreSQL grant with:

- explicit tenant, resource, and field scope;
- an expiry and optional view limit;
- a random bearer token whose digest, not plaintext, is stored;
- immediate revocation and an auditable access record;
- response headers that prevent indexing and caching of sensitive responses;
- no route to mutation, navigation outside the projection, or identifier
  enumeration.

The share projection excludes internal comments, prompts, raw logs, source,
credentials, telemetry, and artifacts unless each item is explicitly
allowlisted. Artifact downloads use short-lived, scope-bound URLs issued only
after the share grant is revalidated. Revocation must invalidate future page
views and artifact URL issuance immediately.

## Consequences

- Operators can correlate a user request with jobs, tracker effects, and runner
  work without copying payload bodies into telemetry.
- Retention and deletion require workers and observability backends that expose
  lifecycle APIs.
- Shared views are useful to clients but intentionally less capable than
  authenticated product views.
- Compromise of the database alone does not reveal active share bearer tokens.
- Previously issued artifact URLs may remain valid for their short lifetime, so
  their maximum TTL is part of the revocation risk budget.
