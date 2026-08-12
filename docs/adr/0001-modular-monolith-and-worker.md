# ADR 0001: Modular Monolith with a Worker

- Status: Accepted in part; workflow/runner scope superseded by ADR 0006 on 2026-08-12
- Date: 2026-07-25
- Issue: #2

## Context

> Current-scope notice: the web/worker modular-monolith choice remains an
> implementation constraint while simplification is in progress. ADR 0006
> supersedes the durable-workflow, runner-orchestration and artifact-processing
> product scope below. Those legacy modules may be removed; this ADR does not
> authorize replacing them with another internal execution platform.

The control plane needs a browser-facing application, durable workflows,
provider integrations, background synchronization, and isolated execution. The
domain is still evolving, and prematurely distributing it across services would
add network contracts, deployment coordination, and duplicated observability
before stable ownership boundaries exist.

Some work cannot run in an HTTP request. Tracker synchronization, outbox
delivery, job retries, artifact processing, retention, and runner orchestration
need independent concurrency and lifecycle management.

## Decision

Build a TypeScript modular monolith with two deployable process entry points:

- `apps/web` is a Next.js application and BFF. It owns browser delivery,
  authentication boundaries, request validation, and synchronous use-case
  invocation.
- `apps/worker` owns `pg-boss` consumers, scheduled work, tracker inbox/outbox
  processing, runner orchestration, and retention jobs. It also exposes a
  minimal operational health endpoint.

Shared behavior is organized into packages:

- `packages/domain`: provider-neutral entities, policies, use cases, and ports
- `packages/db`: Drizzle schema, migrations, repositories, and transactions
- `packages/integrations`: adapter implementations, including GitHub
- `packages/runners`: execution requests, isolation policy, and artifact ports
- `packages/observability`: OpenTelemetry initialization and redaction

Dependencies point inward. Apps and infrastructure packages may depend on the
domain; the domain does not depend on Next.js, Drizzle, GitHub, `pg-boss`, or a
runner implementation. Cross-module calls are in-process and use explicit
interfaces. Web and worker share PostgreSQL but do not communicate through
private HTTP APIs.

Background work uses `pg-boss` so queue state and application state can
participate in PostgreSQL transactions. Job handlers must be idempotent and
safe under at-least-once delivery.

## Consequences

- Domain changes can remain atomic without distributed transactions.
- One build produces the web and worker runtime from the same source revision.
- The worker can scale and restart independently from browser traffic.
- Module boundaries require review discipline because the compiler alone
  cannot prevent every accidental cross-module dependency.
- A module may be extracted into a service later only when independent scaling,
  trust boundaries, or ownership justify the operational cost.
