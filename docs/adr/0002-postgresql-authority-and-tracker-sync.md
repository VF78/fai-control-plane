# ADR 0002: PostgreSQL Authority and Inbound Tracker Reconciliation

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

GitHub Project Status is an authorized command surface, not a second canonical
store: PostgreSQL remains canonical, and each GitHub status observation must
pass policy, domain transition validation, CAS, audit, and command receipt
handling before it can change a WorkItem. No outbound GitHub write is required
for that inbound transition.

GitHub is accessed through a provider-neutral `TrackerAdapter`. Domain code
does not call GitHub SDKs or APIs directly. Week one provides inbound
reconciliation into canonical PostgreSQL state through a durable inbox; the
WorkItem UI is display-only:

- The inbox stores webhook and poll observations before processing. A provider
  delivery ID or stable event fingerprint enforces idempotency.
- The outbox and GitHub writer are deferred and disabled. A future writer must
  be explicitly approved, use the same transaction boundary, and record
  bounded retry results.

Inbox processing serializes updates per tracker object, compares provider
version metadata, and records conflicts instead of silently overwriting data.
Reconciliation polling repairs missed webhooks. A future outbox delivery must
carry an idempotency key and suppress echoes caused by the control plane's own
writes.

### Authority Matrix

| Data | Authority | Synchronization rule |
| --- | --- | --- |
| Workflow phase, run state, approvals, policy decisions | PostgreSQL | Mapped GitHub Project Status observations can transition canonical state only through policy/domain/CAS/audit/receipt command handling; the WorkItem UI is display-only and the outbound writer is deferred |
| Run requests, results, artifact metadata, share grants | PostgreSQL | Never reconstructed from GitHub |
| Queue state, inbox/outbox state, cursors, delivery attempts | PostgreSQL | Internal only |
| Secret references and credential metadata | PostgreSQL | Values remain outside the database and are never synchronized |
| Repository, issue, and pull request provider IDs | GitHub for identity; PostgreSQL for the durable mirror | Inbound creates or refreshes the mirror; IDs are immutable after binding |
| Issue or pull request title, body, assignees, milestone, open/closed state | GitHub | Accepted inbound into the PostgreSQL mirror; no control-plane write occurs in week one |
| Non-namespaced labels | GitHub | Accepted inbound and retained for display; no outbound preservation is active |
| `fai:*` labels and control-plane status comments | PostgreSQL desired state | Writer is deferred and disabled; inbound values do not change canonical state |

An authority classification is required before adding a synchronized field.
There is no generic merge and no timestamp-only last-writer-wins policy.
Read adapters may return an explicitly defined subset of provider-owned fields;
the initial repository snapshot omits issue and pull request bodies until a
consumer requires and secures that untrusted, potentially sensitive content.

Repository snapshot ingestion has two distinct operations. An explicit,
audited, idempotent bootstrap may create canonical WorkItems and immutable
tracker bindings. Steady-state synchronization requires the repository
binding's prior snapshot version, updates only existing WorkItem bindings and
provider-owned mirror fields, and records each mapped GitHub Project Status as
an immutable observation with its expected canonical version. A processor turns
only pending observations into canonical commands. The deferred outbound writer
must handle echoes without an inbound command, and persist outbound races or
failed CAS/domain transitions as conflicts when it is explicitly approved. The
reconciler never infers or silently creates a
canonical WorkItem. Bootstrap may set an initial status only while creating a
new WorkItem; steady-state synchronization never writes `work_items.status`
directly. Each
repository snapshot, including its issue, pull request, and check projections,
is committed in one PostgreSQL transaction. Snapshot operation receipts store
only structured identifiers, versions, counters, and reason codes; raw GitHub
bodies and credential material are not persisted.

## Failure Semantics

- A database commit does not write GitHub in week one; the deferred writer has
  no delivery path until explicitly approved.
- A webhook is acknowledged only after durable inbox storage.
- Poison events and exhausted deliveries move to a reviewable dead-letter
  state; they are not discarded.
- Reconciliation compares authoritative fields according to the matrix and
  emits metrics for drift, age, retries, and conflicts.
- Deleting a tracker object does not cascade-delete control-plane history.

## Consequences

- Control-plane behavior remains available and auditable during GitHub outages.
- Users may keep editing GitHub-owned fields without creating two authorities.
- Inbound reconciliation is eventually consistent and the WorkItem UI is
  display-only; no GitHub write effect is pending in week one.
- Additional tracker providers can implement the same port without leaking
  provider-specific concepts into the domain.
