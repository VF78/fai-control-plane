# AI context

This file contains stable orientation only. GitHub Project `f(AI) Studio` #1
and repository issues contain live status and must be queried at the start of
every chat.

## Product outcome

Build a simple provider-neutral control plane for industrial software delivery:
a lightweight operational layer over GitHub, GitHub Projects, Telegram,
Codex/Hermes, and later replaceable providers. PostgreSQL is canonical.

The operator workspace has five areas:

1. Portfolio — factual metrics, deadlines, risks, and Attention Queue.
2. Delivery — Overview, Protocol, Tasks, and Runs; task detail owns control.
3. Conversations — internal and client channels.
4. People & Access — humans, agents, roles, identities, and effective access.
5. Agents & Systems — fleet, instructions, integrations, recovery, and audit.

The required evidence journey is:

`Portfolio signal -> project/task -> delivery stage -> responsible human/agent
-> policy/approval -> action/run -> receipt/evidence/next action`.

## Product and architecture invariants

- Premium-minimal, GitHub-informed web UX with compact infographics and familiar
  Lucide icons, accessible labels, progressive disclosure, and no decorative
  dashboard clutter, nested cards, or workflow canvas.
- One project/environment/time scope. Desktop/tablet use master-detail; mobile
  uses a full detail route.
- Render only confirmed PostgreSQL facts. Missing facts are `Unknown` or
  `Not configured`; never fabricate metrics, conversations, roles, health, or
  activity.
- Preserve provider-neutral domain, view-model, navigation, and design-token
  boundaries. Web is primary; keep later native Android/iOS portability cheap
  without introducing React Native or a second client now.
- Canonical commands enforce policy, optimistic versions, and audit. Agents do
  not mutate tables or bypass approvals.
- No production, DNS, VPS, `f-ai.studio`, Hermes, MSA contour, or secret change
  without Vladimir's explicit authorization.
- Russia network accessibility remains outside the current scope.

## Start query

Use concise `gh` queries to resolve:

1. `origin/main` and the current production baseline recorded in issue #1;
2. open PRs;
3. the sole Project item with `Status = In progress`;
4. that issue's unchecked acceptance and latest compact evidence comment;
5. the next dependency-ordered Backlog/Ready item.

If local state conflicts with GitHub, stop and reconcile Project truth before
implementation. Do not infer completion from an unmerged commit.

## Release boundary

Local implementation, PR merge, and production release are separate decisions.
Nothing in a merged PR authorizes deployment. Read
`docs/ops/PRODUCTION_RUNBOOK.md` and request Vladimir's explicit release
approval for the exact commit and production diff. Use only
`scripts/deploy-prod.sh` for an approved production release.
