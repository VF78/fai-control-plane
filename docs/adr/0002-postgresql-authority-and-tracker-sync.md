# ADR 0002: PostgreSQL Authority and Bidirectional Tracker Sync

- Status: Accepted
- Date: 2026-07-25
- Issue: #2

## Context

The control plane must coordinate workflow state reliably while users continue
to work in GitHub. Treating GitHub as a database would make control-plane
correctness depend on API availability and tracker semantics. Treating GitHub
as a write-only projection would discard legitimate edits made in the tracker.
Unqualified bidirectional synchronization would create loops and
last-writer-wins data loss.

## Decision

PostgreSQL is the canonical source of truth for all durable control-plane state.
Every state transition is committed there before external effects are attempted.
Drizzle migrations are the only supported schema-change mechanism.

GitHub is accessed through a provider-neutral `TrackerAdapter`. Domain code
does not call GitHub SDKs or APIs directly. The adapter is bidirectional and
uses two durable PostgreSQL boundaries:

- The inbox stores webhook and poll observations before processing. A provider
  delivery ID or stable event fingerprint enforces idempotency.
- The outbox stores desired tracker effects in the same transaction as the
  domain change that requested them. Workers retry delivery with bounded
  backoff and record the provider result.

Inbox processing serializes updates per tracker object, compares provider
version metadata, and records conflicts instead of silently overwriting data.
Outbox delivery carries an idempotency key and suppresses echoes caused by the
control plane's own writes. Reconciliation polling repairs missed webhooks.

### Authority Matrix

| Data | Authority | Synchronization rule |
| --- | --- | --- |
| Workflow phase, run state, approvals, policy decisions | PostgreSQL | May be projected to namespaced GitHub labels or comments; inbound GitHub edits cannot mutate it |
| Run requests, results, artifact metadata, share grants | PostgreSQL | Never reconstructed from GitHub |
| Queue state, inbox/outbox state, cursors, delivery attempts | PostgreSQL | Internal only |
| Secret references and credential metadata | PostgreSQL | Values remain outside the database and are never synchronized |
| Repository, issue, and pull request provider IDs | GitHub for identity; PostgreSQL for the durable mirror | Inbound creates or refreshes the mirror; IDs are immutable after binding |
| Issue or pull request title, body, assignees, milestone, open/closed state | GitHub | Accepted inbound into the PostgreSQL mirror; control-plane edits are explicit outbox commands |
| Non-namespaced labels | GitHub | Accepted inbound and preserved by outbound writes |
| `fai:*` labels and control-plane status comments | PostgreSQL desired state | Written through the outbox; conflicting inbound edits are restored or flagged |

An authority classification is required before adding a synchronized field.
There is no generic merge and no timestamp-only last-writer-wins policy.

## Failure Semantics

- A database commit may succeed while GitHub is unavailable; the outbox keeps
  the desired effect pending.
- A webhook is acknowledged only after durable inbox storage.
- Poison events and exhausted deliveries move to a reviewable dead-letter
  state; they are not discarded.
- Reconciliation compares authoritative fields according to the matrix and
  emits metrics for drift, age, retries, and conflicts.
- Deleting a tracker object does not cascade-delete control-plane history.

## Consequences

- Control-plane behavior remains available and auditable during GitHub outages.
- Users may keep editing GitHub-owned fields without creating two authorities.
- Synchronization is eventually consistent and the UI must expose pending or
  conflicted effects where relevant.
- Additional tracker providers can implement the same port without leaking
  provider-specific concepts into the domain.
