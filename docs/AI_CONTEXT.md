# AI context

This file contains stable orientation only. GitHub Project `f(AI) Studio` #1
and repository issues contain live status and must be queried at the start of
every chat.

## Product outcome

Build a lightweight supervisory layer over GitHub Project and Hermes. It joins
the tools; it does not reproduce them.

The current product contract is issue #158, ADR 0006 and ADR 0007:

| Fact or action | Sole authority |
| --- | --- |
| Code, PRs, checks, release references | GitHub repository |
| Tasks, assignees, dates, dependencies, status | GitHub Project |
| Planning, development, QA and DevOps execution | Hermes |
| Project source documents/configuration and explicit human approvals | Control Plane/PostgreSQL |
| Trigger correlation, provider cursor/freshness and audit | Control Plane/PostgreSQL, bounded to the external item/session |

The Control Plane reads the same GitHub Project item, requests the next bounded
role task from Hermes, and displays confirmed external facts. Hermes may use
Codex CLI internally through Hermes' supported tools/skills; that composition
is not a Control Plane concern.

The first real delivery acceptance contour remains ASCON. Project conversations
use one operational agent deployment per project with two OS-isolated trust
contours: a trusted executor/internal Telegram process and a client-facing
process with only bounded client-visible tools. MSA uses Matrix/Element for the
external room; ASCON uses its Bitrix24 task chat through supported REST/events.
Full transcripts remain in the channel providers rather than PostgreSQL.
The neutral boundary, Bitrix24 adapter, runtime delivery and bounded project
tools precede the dependency-closed legacy chat/history/share/status cleanup.

## Product and architecture invariants

- Premium-minimal, GitHub-informed web UX with compact infographics and familiar
  Lucide icons, accessible labels, progressive disclosure, and no decorative
  dashboard clutter, nested cards, or workflow canvas.
- One project/environment/time scope. Desktop/tablet use master-detail; mobile
  uses a full detail route.
- Render facts from their named authority. For mirrored provider facts show the
  source link, freshness and error/stale state; never substitute local state.
- Preserve provider-neutral domain, view-model, navigation, and design-token
  boundaries. Web is primary; keep later native Android/iOS portability cheap
  without introducing React Native or a second client now.
- Human approvals remain explicit and audited. Hermes updates the same GitHub
  work item through its supported GitHub capability and never bypasses a human
  approval boundary.
- External-room membership does not itself grant approval-decision authority.
  Vladimir decides plans, releases/production and irreversible actions;
  Vladimir or Vitaliy may decide internal operational approvals; client staff
  may decide only exact-reference client UAT/acceptance. Composition resolves
  every sender to an active human project member and enforces this policy.
- Do not create or extend a second task/status/DAG, TaskPacket/AgentRun
  lifecycle, custom Hermes/Codex runtime, QA state machine, deployment
  executor/lease/daemon, Hermes Kanban, chat store or automated SSH/IAM system.
- Hermes subagents are temporary work units, not caller IAM, durable channel
  handlers or a security boundary. Runtime/provider names stay in composition;
  the same bounded conversation and execution contracts must remain replaceable
  by OpenClaw and Codex CLI/Claude CLI adapters.
- Use native runtime gateways for Telegram and Matrix. Bitrix24 uses verified
  REST/events; browser polling, DOM scraping and browser cookies are not a
  supported transport.
- Existing implementations of those surfaces are legacy to inventory/delete in
  #159/#162. Never infer target architecture from merged legacy code.
- No production, DNS, VPS, `f-ai.studio`, Hermes, MSA contour, or secret change
  without Vladimir's explicit authorization.
- Russia network accessibility remains outside the current scope.

## Start query

Use concise `gh` queries to resolve:

1. `origin/main` and the current production baseline recorded in the Project;
2. open PRs;
3. the sole Project item with `Status = In progress`;
4. issue #158, the approved #159 deletion map, and the selected sub-issue;
5. that issue's unchecked acceptance and next dependency-ordered item.

If local state conflicts with GitHub, stop and reconcile Project truth before
implementation. Do not infer completion from an unmerged commit. Do not start
product implementation until the exact #159 inventory and target diagram are
approved by Vladimir.

## Release boundary

Local implementation, PR merge, and production release are separate decisions.
Nothing in a merged PR authorizes deployment. Read
`docs/ops/PRODUCTION_RUNBOOK.md` and request Vladimir's explicit release
approval for the exact commit and production diff. Use only
`scripts/deploy-prod.sh` for an approved production release.
