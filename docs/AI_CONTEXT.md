# AI context

Stable orientation only. GitHub Project `f(AI) Studio` #1 and repository
issues contain live status, acceptance and release evidence.

## Product

f(AI) Control is a provider-neutral supervisory workspace, not another tracker,
chat or agent platform. It must let a Product Owner:

1. see portfolio/project status, current focus and material risks;
2. follow the same GitHub Project task through delivery;
3. see the responsible human or Hermes role;
4. manage supported project sources, memberships and exact approvals;
5. observe internal/client messenger contours, agent readiness and receipts;
6. explicitly submit eligible Hermes-owned work and understand success,
   denial, stale and provider-error states.

Authority is fixed:

| Concern | Authority |
| --- | --- |
| Code, PRs, checks, release references | GitHub repository |
| Tasks, status, assignees, dates, dependencies | GitHub Project |
| Planning, project orchestration, development, QA and DevOps execution | One project-scoped Hermes using direct project credentials |
| Projects/sources, bindings, exact approvals, bounded snapshots, receipts/audit | Control Plane/PostgreSQL |

The current MVP target is self-hosted dogfood: onboard `VF78/fai-control-plane`
through the production GUI, configure its own isolated Hermes and carry one
low-risk issue through the configured process. ASCON is retained only as an
existing read-only/rollback neighbour during this acceptance and is not the
MVP debugging project. MSA follows only after MVP acceptance and reuses the
same contracts with its own bindings; it is not a fork.

## Invariants

- Modular monolith: web + one worker; PostgreSQL has the fresh 16-table MVP
  baseline and no dependency on the legacy database.
- GitHub Project is the only task/status truth. Local storage contains only
  bounded provider facts required for projection, freshness, delivery,
  idempotency and audit.
- Hermes is behind `AgentDeliveryPort`; OpenClaw may replace its adapter without
  changing core semantics. Codex CLI/Claude CLI remain executor internals.
- Hermes directly creates and updates repository and GitHub Project facts with
  persistent `git`/`gh` credentials. The worker only submits/observes, verifies
  provider readback, notifies, restarts Hermes and launches the next configured
  stage. No Control Plane GitHub/CLI broker is permitted.
- Setup installs the internal operator skill and versioned project process/routing
  files in Hermes' persistent workspace. Changed settings update only policy
  bytes. Task handoffs carry versions and compact receipt identity; they do not
  resend project documents/history or reset agent memory.
- Default mode never executes the backlog automatically. Only an authenticated
  operator may submit a non-Done item whose provider-native `Owner` is exactly
  Hermes. A separately enabled autonomous project mode may select at most one
  eligible ready/unblocked item and must stop at the first configured human
  gate or blocker.
- UI shows confirmed facts, provenance, freshness and error state. Missing data
  is `Unknown`/`Not configured`; controls exist only for canonical commands.
- Each project may have two independent messenger contours. Internal uses
  Telegram. Client uses Telegram or Matrix/Element through a separate restricted
  profile of the same project Hermes. Bindings and credentials are project-scoped;
  the client profile cannot access internal tools, context, approvals or delivery
  roles. Its only project mutation is a narrow project-scoped tool that creates a
  new client-reported Issue/bug and adds it to the bound task tracker. For client
  Telegram, configured IDs are client representatives; internal participant IDs
  are inherited automatically. Element membership is managed by the client: the
  binding stores one room link/ID and the agent's password login, with no member
  allowlist in Control Plane. Legacy client connectors are not active product requirements.
- UX is premium-minimal and manager-first: compact visualization, progressive
  disclosure, one desktop model with responsive mobile detail, no decorative
  clutter, text-heavy debug panels, dead navigation or duplicate UI.
- No second task lifecycle, agent runtime, chat store, workflow canvas, generic
  IAM/provider registry, automatic merge/deploy or speculative abstraction.

## Start query

Using local `git`/`gh`:

1. fetch and resolve exact `origin/main`;
2. list open PRs;
3. list Project items for `VF78/fai-control-plane` only;
4. read issue `#158`, then the current leaf `In progress` issue and its direct
   dependencies/latest compact evidence;
5. read the next dependency-ready issue only when current WIP is accepted.

The dependency order is recorded in #158. Do not infer it from issue numbers,
old comments or retained ASCON history.

If local state and GitHub differ, reconcile Project truth before work. A
closed issue, merged PR or deployed screen is not Vladimir's product/visual
acceptance unless the current issue records that exact approval.

## Release boundary

Implementation, merge and production release are separate decisions. The
current deployment script is active but requires exact commit/config approval.
Read `docs/ops/PRODUCTION_RUNBOOK.md`; never infer production state from old
issue comments or retained branches.
