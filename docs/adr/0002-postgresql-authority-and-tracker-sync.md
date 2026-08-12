# ADR 0002: PostgreSQL Authority and Gated Tracker Reconciliation

- Status: Superseded in part by ADR 0006 on 2026-08-12
- Date: 2026-07-25
- Issue: #2

## Context

> Historical decision notice: ADR 0006 supersedes every statement below that
> makes PostgreSQL canonical for project tasks, workflow status, run/QA state
> or execution. This ADR remains applicable to Control-Plane-owned documents,
> approvals, provider observation/correlation and audit facts until the #159
> inventory maps each legacy object.

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

GitHub is accessed through provider-neutral task-tracker and repository
observation ports. Domain code does not call GitHub SDKs or APIs directly.
Inbound reconciliation enters canonical PostgreSQL state through a durable
inbox:

- The inbox stores webhook and poll observations before processing. A provider
  delivery ID or stable event fingerprint enforces idempotency.
- An approved Status-only writer uses a separately gated credential, an outbox
  mutation marker, expected canonical/provider versions, read-after-write
  confirmation and echo suppression.
- Other fields remain read-only until a field-authority decision and provider
  capability are implemented.

Inbox processing serializes updates per tracker object, compares provider
version metadata, and records conflicts instead of silently overwriting data.
Reconciliation polling repairs missed webhooks. Every outbox delivery carries
an idempotency key and suppresses echoes caused by the control plane's own
writes.

### Authority Matrix

| Data | Authority | Synchronization rule |
| --- | --- | --- |
| Workflow phase, run state, approvals, policy decisions | PostgreSQL | Mapped GitHub Project Status observations can transition canonical state only through policy/domain/CAS/audit/receipt command handling; approved canonical Status transitions may write back through the separately gated adapter |
| Run requests, results, artifact metadata, share grants | PostgreSQL | Never reconstructed from GitHub |
| Queue state, inbox/outbox state, cursors, delivery attempts | PostgreSQL | Internal only |
| Secret references and credential metadata | PostgreSQL | Values remain outside the database and are never synchronized |
| Repository, issue, and pull request provider IDs | GitHub for identity; PostgreSQL for the durable mirror | Inbound creates or refreshes the mirror; IDs are immutable after binding |
| Issue or pull request title, body, assignees, milestone, open/closed state | GitHub | Accepted inbound into the PostgreSQL mirror; no control-plane write until each field receives an explicit authority/capability decision |
| Non-namespaced labels | GitHub | Accepted inbound and retained for display; no outbound preservation is active |
| `fai:*` labels and control-plane status comments | PostgreSQL desired state | Not implemented; inbound values do not change canonical state |

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
only pending observations into canonical commands. The Status writer handles
echoes without creating a second inbound command and persists outbound races or
failed CAS/domain transitions as conflicts. The reconciler never infers or
silently creates a
canonical WorkItem. Bootstrap may set an initial status only while creating a
new WorkItem; steady-state synchronization never writes `work_items.status`
directly. Each
repository snapshot, including its issue, pull request, and check projections,
is committed in one PostgreSQL transaction. Snapshot operation receipts store
only structured identifiers, versions, counters, and reason codes; raw GitHub
bodies and credential material are not persisted.

## Failure Semantics

- A database commit does not imply confirmed GitHub state; the gated writer
  reports pending, confirmed, stale, retryable or failed delivery explicitly.
- A webhook is acknowledged only after durable inbox storage.
- Poison events and exhausted deliveries move to a reviewable dead-letter
  state; they are not discarded.
- Reconciliation compares authoritative fields according to the matrix and
  emits metrics for drift, age, retries, and conflicts.
- Deleting a tracker object does not cascade-delete control-plane history.

## Consequences

- Control-plane behavior remains available and auditable during GitHub outages.
- Users may keep editing GitHub-owned fields without creating two authorities.
- Inbound reconciliation and gated Status write-back are eventually
  consistent; the UI must distinguish canonical, pending confirmation,
  externally confirmed, stale and conflicting state.
- Additional tracker providers can implement the same port without leaking
  provider-specific concepts into the domain.
