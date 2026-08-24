# ADR 0006: Thin Control Plane over GitHub Project and Hermes

- Status: Accepted and implemented by the thin 16-table MVP
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

`approved source documents -> plan in GitHub Project -> PO plan approval ->
human or explicitly submitted Hermes work -> QA evidence -> PO deployment
approval -> approved project runbook -> PO result acceptance -> client UAT`.

## Migration and deletion

Issues #159/#162 completed the authority inventory and hybrid rebuild. The
active product uses the fresh 16-table MVP database and one reachable
architecture; it does not read, migrate or delete the retained legacy database.
Their historical execution plans are not current implementation instructions.

## Consequences

- GitHub Project remains visibly and technically the only task/status truth.
- Hermes remains the executor and can evolve independently of the Control
  Plane.
- The product and its production/security surface become substantially smaller.
- Temporary feature loss is acceptable where the removed feature duplicated an
  external tool.
- A new table, daemon or lifecycle requires an explicit authority analysis and
  Vladimir's approval that it does not recreate prohibited duplication.

## 2026-08-24 amendment: project routing policy

The Control Plane may retain one immutable, versioned Hermes routing policy as
a `project_source_artifacts` configuration document. It maps bounded task
classes to either direct Hermes reasoning or a composition-allowlisted CLI
executor plus model/effort, mandatory Hermes result acceptance and an optional
exact human gate. This is project configuration, not run/task lifecycle.

Hermes still owns executor runtime, delegation and acceptance. `codex-cli` is
the only currently configured CLI adapter; a later `claude-code-cli` adapter
uses the same contract and UI structure without schema/workflow changes. There
is no generic provider registry, and an unavailable adapter cannot become an
active route. Repository-changing implementation always uses a CLI executor;
direct Hermes may plan, decide, manage provider-native Project facts, or invoke
an exact-approval broker. Merge, Actions, release, deploy and production never
run inside a coding CLI.
