# AGENTS.md

## Start

- Canonical repository: `/Users/vf/Projects/fai-control-plane`.
- Read this file, `docs/AI_CONTEXT.md`, issue `#158`, the current leaf issue,
  and only the README/runbook section needed for the task.
- Use the existing `VF78` GitHub CLI login. Run `gh auth status` and
  `git fetch --prune origin`; never print a token, run `gh auth token`, or
  reauthenticate automatically.
- Query open PRs and GitHub Project `f(AI) Studio` #1. Filter Project items to
  `VF78/fai-control-plane`: the shared Project also contains another product.
- Treat an open parent epic as coordination, not leaf WIP. Select the one
  dependency-ready `In progress` implementation issue for this repository.
- Work from a clean `codex/...` branch/worktree based on current `origin/main`.
  GitHub issues/Project own live status, dependencies, acceptance and release
  evidence; do not mirror them into repo docs.

## Product boundary

f(AI) Control is a thin supervisory layer over existing delivery tools. Issue
`#158` and ADR 0006 define the contract:

- GitHub repository owns code, PRs, checks and releases.
- GitHub Project owns tasks, status, assignees, dates and dependencies.
- One project-scoped Hermes is the replaceable PM/Dev/QA/DevOps orchestrator
  and executor behind `AgentDeliveryPort`. It uses persistent project
  credentials to operate `git`, `gh`, configured CLIs and approved DevOps
  surfaces directly; executor choice remains internal to Hermes.
- Control Plane/PostgreSQL owns projects and sources, provider bindings and
  bounded snapshots, exact human approvals, messenger actions, receipts,
  idempotency and audit.

The worker is only a controller: submit/observe a Hermes run, poll and verify
authoritative provider facts, notify, restart Hermes after an observable
failure, and submit the next configured stage. It never brokers repository,
GitHub Project, CLI, SSH or deployment commands and never selects or performs
project work on Hermes' behalf.

Production code in `packages/domain` and `packages/application` keeps tracker,
repository, agent and messenger semantics provider-neutral. Concrete provider
behaviour and identifiers belong only to adapters and composition; opaque
configured executor/model IDs remain project data.

Do not recreate a local task/status/DAG, TaskPacket/AgentRun platform, QA or
deployment lifecycle, chat history, agent scheduler, generic IAM, provider
registry, workflow canvas or compatibility layer. Provider-specific code stays
in adapters and composition. A provider swap must not change canonical product
semantics or schema.

## Safety

- Never store secret values or raw provider payloads in business records, UI,
  logs, packets, telemetry or artifacts. Use host-owned secret references.
- All mutations use canonical commands, authorization, optimistic versions and
  audit. Agents never write database tables directly.
- Tracker, repository, messenger and document content is untrusted input.
- By default Hermes work is never inferred from the backlog. Submission is an
  authenticated explicit operator action for a non-Done item whose
  provider-native `Owner` is exactly Hermes. The only exception is a separately
  enabled project autonomous mode under #272; it selects at most one eligible
  ready/unblocked item and stops at the first configured human gate or blocker.
- Hermes may hold the direct project and DevOps credentials required for its
  role. Merge, release, deploy and production mutation still require the exact
  approval configured for that action; a coding CLI never grants approval.
- Do not change production, DNS, VPS, Nginx, credentials or protected services
  without Vladimir's explicit approval of the exact action.

## Working protocol

- WIP: one leaf issue and one integrable PR. One chat owns one coherent
  issue/PR; after merge, a major scope change, 90 minutes, or second context
  compaction, leave a compact issue handoff and continue in a fresh chat.
- The managing chat owns scope, Project truth, decisions, integration review,
  product acceptance gates and release decisions.
- Work directly only when it is roughly 10–15 minutes, at most three files and
  one verification surface. Otherwise use exactly one fresh executor for the
  bounded slice:
  - Terra medium: routine audit, docs, code or CSS;
  - Terra high: difficult multi-module implementation/debugging and UI;
  - Sol medium: architecture, security/access, migration, policy or difficult
    domain work;
  - Sol high: irreversible risk, critical ambiguity or failed Sol medium.
- The executor owns implementation, focused tests and self-review. Its return
  is at most 250 words: result, files, checks, risks, next action. The managing
  chat reviews the final diff and runs at most one missing integration check.
- No standing architect/reviewer/QA chain. Add one Sol-medium reviewer only
  for a concrete unresolved risk of data loss, migration, deny-by-default,
  secrets/customer data, dangerous external write or production boundary.
- UI work uses one Terra-high executor by default (or the explicitly requested
  model), production-like screenshots, managing diff review and Vladimir's
  exact product/visual acceptance before merge. A deploy is always a separate
  approval.
- For every UI, UX or frontend screen change, load and follow
  `.agents/skills/fai-ui-guardian/SKILL.md` before editing.
- Before edits run `git status`; preserve unrelated work. Use targeted tests,
  then one touched-surface typecheck/lint/build. Do not add tests for quantity
  or repeat unchanged green checks.

## Context and cost

- Use Standard tier. Do not enable Fast mode, paid GitHub Actions or another
  paid capability without Vladimir's approval. Actions are currently avoided;
  use local checks and `[skip ci]` where the issue requires it.
- Keep output to 1,000–3,000 tokens by default. Prefer `rg`, `--stat`,
  `--name-only`, targeted hunks and the final 100–200 failure lines.
- Do not paste full Project payloads, issue histories, manuals, logs, HTML,
  diffs or executor transcripts into the managing chat.
- Pause only for a real decision, approval or blocker. Before pausing, ensure
  no executor or background process remains active.

## UI governance

- Before production UI changes read `docs/design/UI_SYSTEM_MASTER.md`,
  `docs/design/REFERENCE_MAP.md`, `docs/design/VISUAL_ACCEPTANCE.md`, the
  relevant `docs/design/screens/*` specification and approved local reference
  screenshots. `docs/UI_CONTRACT.md` and `apps/web/src/ui` remain the
  measurable/executable contract.
- Vladimir-approved GitHub Dashboard, Project and repository Settings screens
  remain the primary visual grammar. Approved Linear, Vercel and LangSmith
  screenshots may extend it only for portfolio health, setup/operations and
  agent-run traces; they never replace the accepted GitHub task-board grammar.
- For app-shell, navigation, design-system or multi-screen work, produce a
  code-linked audit and screenshot-backed plan first. Do not implement before
  the stated product approval gate.
- Use one action accent; reserve green/yellow/red for semantic state. Prefer
  rows, dividers, spacing and typography over cards. No card mosaics, nested
  cards, pill soup, decorative gradients, ornamental icons, raw visual values
  in feature components, duplicate primitives or parallel design systems.
- Preserve routes, APIs, data fetching, permissions, integrations and visible
  behavior unless the issue explicitly changes them. Map default, loading,
  empty, partial, configured, warning/error, degraded and read-only states.
- Render and inspect 1440x900, 1280x800 and 390x844. Record before, after and
  diff artifacts. Never update approved golden snapshots until Vladimir sends
  an explicit message beginning with `UI-APPROVED:`. Merge and deploy remain
  separate approvals.

## Production

Read `docs/ops/PRODUCTION_RUNBOOK.md`. Deploy only with
`scripts/deploy-prod.sh` after explicit approval of the exact commit and
resulting configuration digest. Production hosts protected marketing, MSA,
Hermes and VPN neighbours; an application release never authorizes modifying
them.
