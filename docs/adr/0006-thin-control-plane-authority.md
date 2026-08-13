# ADR 0006: Thin Control Plane over GitHub Project and Hermes

- Status: Accepted product direction; implementation gated by issue #159
- Date: 2026-08-12
- Issue: #158
- Supersedes: workflow/runner scope in ADR 0001, task/workflow/run authority in
  ADR 0002, runner-specific product scope in ADR 0003/0005, and Control-Plane
  execution architecture in ADR 0004

## Context

The initial implementation made PostgreSQL authoritative for project tasks and
added local WorkItem/DAG/materialization, run, QA, deployment and access
lifecycles. That duplicated capabilities already owned by GitHub Project and
Hermes, increased operating and security surface, and obscured progress toward
a usable product.

The product is intended to unite existing tools. GitHub already owns repository
delivery and project tracking. Hermes already performs role-based work and can
use GitHub, terminal tools and Codex CLI through supported Hermes capabilities.
The Control Plane needs to provide source context, approvals, orchestration and
visibility, not another tracker or agent platform.

## Decision

### Authority

| Concern | Sole authority | Control Plane behaviour |
| --- | --- | --- |
| Code, branches, commits, PRs, checks, releases | GitHub repository | Link, observe and display |
| Project tasks, assignees, dates, dependencies, status | GitHub Project | Observe/update the same item; retain only bounded sync facts |
| Planning, development, QA, DevOps execution | Hermes | Submit one bounded role request through a supported authenticated Hermes surface |
| Hermes use of Codex CLI | Hermes | No Control Plane composition or runtime |
| Project source documents and configuration | Control Plane/PostgreSQL | Store with provenance and expose bounded references |
| PO/client approvals | Control Plane/PostgreSQL | Record explicit human decisions and bind them to external references |
| Trigger correlation and audit | Control Plane/PostgreSQL | Retain idempotency, provider cursor/freshness and request/session references only |

### Orchestration rule

An observed GitHub Project transition may request one next-role action from
Hermes. The request contains the role, repository and GitHub item identity,
bounded approved project context, acceptance criteria, approval fact when
required, and an idempotency/correlation reference. Hermes performs the work
and updates the same GitHub item/PR/check/release. The Control Plane observes
that external result; it does not reconstruct Hermes' internal lifecycle.

### Prohibited duplication

The target product contains no Control-Plane-owned:

- task, WorkItem, status, milestone, dependency DAG or materialized plan truth;
- TaskPacket, AgentRun, claim/heartbeat/completion runner platform;
- Hermes controller-to-Codex executor, custom transport or bundle lifecycle;
- QA packet/review/risk state machine beyond external result/evidence display;
- deployment registration/job/lease/claim/host daemon;
- Hermes Kanban;
- chat history/workflow or automated SSH/IAM grant reconciler.

Provider cursors, delivery attempts and idempotency records are allowed only
when they are bounded infrastructure facts and cannot become a second business
workflow.

### Acceptance contour

ASCON is the first real acceptance contour. Its internal project chat is
Telegram and its client chat is the existing Bitrix24 conversation. Both use a
provider-neutral messenger boundary; issue #174 supplies the provider adapters,
identity bindings and activation. Matrix/Element for MSA later uses the same
boundary. The required path is:

`three approved source documents -> Hermes manager plan in GitHub Project ->
PO plan approval -> human or Hermes development -> Hermes QA -> PO deployment
approval -> Hermes DevOps via the project runbook/GitHub Actions -> PO result
acceptance -> client UAT`.

## Migration and deletion

Issue #159 must inventory every table, command, route, UI control, worker,
systemd unit and script as `delete now`, `keep as read mirror`, `keep for
documents/approval/audit`, or `defer disabled`. Vladimir must approve that map
and the target component diagram before product implementation begins.

Issue #162 builds a fresh 16-table MVP database and removes contradicting
reachable code rather than leaving a competing disabled architecture. It does
not read, migrate or delete the legacy database. The legacy commit and database
remain the rollback boundary until the ASCON cutover is accepted.

## Consequences

- GitHub Project remains visibly and technically the only task/status truth.
- Hermes remains the executor and can evolve independently of the Control
  Plane.
- The product and its production/security surface become substantially smaller.
- Temporary feature loss is acceptable where the removed feature duplicated an
  external tool.
- A new table, daemon or lifecycle requires an explicit authority analysis and
  Vladimir's approval that it does not recreate prohibited duplication.
