# Sequential UI migration plan

Status: PR 1 (Projects + Setup) and PR 2 (Shell, Login, Tasks, Overview and
Process) were visually approved, merged and deployed on 2026-08-31. Their
approved baselines are stored under `apps/web/tests/visual/golden/`. PR 3 is
the only remaining migration slice: Chats, Agents and systems, Roles and
access, plus final legacy UI cleanup. Issue #300 owns live status and evidence.

## Global constraints

- Preserve routes, API calls, server data loading, permissions, integrations,
  command semantics and Russian operator copy unless a slice receives separate
  product approval.
- GitHub Dashboard/Project/Settings is primary. Linear, Vercel and LangSmith
  remain bounded supplementary references.
- Use three coherent implementation PRs. Each PR deletes every implementation
  and selector it replaces; no compatibility layer, parallel token/component
  system, unused primitive or dead CSS is allowed.
- Every PR renders 1440x900, 1280x800 and 390x844 and records before, after and
  diff evidence outside approved goldens. Snapshot update remains forbidden
  until an exact `UI-APPROVED:` message.

## Gate 0 — foundation decision — complete

Approve or amend D3 (`Проекты`), D4 (blue action accent; semantic green), D6
(five visible setup groups preserving all existing commands), and the exact
Projects + Setup hierarchy. Promote only approved candidate references to
`references/approved/` and write the bounded `REFERENCE_MAP.md`.

Acceptance:

- label, color semantics, visible setup grouping and route compatibility are
  consistent across `UI_CONTRACT.md`, the screen specification and reference
  map;
- GitHub remains the shell, settings and Tasks grammar;
- no product code or visual baseline is changed in the decision step.

## PR 1 — canonical foundation + Projects and Setup vertical slice

This is one vertical slice so every new primitive has a production consumer in
the same PR.

Scope:

- normalize semantic tokens and shared controls in `apps/web/src/ui`;
- add only the immediately used accessible Button styling, Tabs,
  `StatusIndicator`, `ProjectListRow`, `SetupRail`, `Dialog`, `DangerZone`,
  `Skeleton` and `ErrorState`;
- replace the default expanded `/?view=settings` blocks with compact project
  rows;
- retain existing `view=settings&setup=...` compatibility while adding the
  approved project header, tabs and five-group setup summary;
- regroup all existing ten-step facts and commands without changing their
  endpoints, approvals, idempotency or explicit first-task start;
- provide integration rows, one document upload path, loaded document rows,
  useful agent states, capability-aware access and the single Danger Zone;
- add 1280x800 to the deterministic visual gate and fixtures for all required
  Projects/Setup states.

Acceptance:

- `Проекты` has one generic primary action and green is used only for healthy
  or successful state;
- two fixture projects fit fully at 1440x900; attention, remaining setup and
  next action are identifiable in three seconds;
- zero/one/two projects; loading; partial/completed setup; integration error;
  documents empty/loaded; agent connected/offline/degraded; read-only; command
  pending/success/error all render deterministically;
- invalid setup/project URLs show a recoverable not-found state;
- tabs, dialog focus lifecycle, keyboard order, accessible names and reduced
  motion pass focused checks;
- delete is absent from portfolio/header, requires the exact project name and
  remains server-authorized;
- no duplicate button/tab/status/row/dialog/old wizard implementation remains;
- network/API/auth/permission/dependency behavior is unchanged.

## Gate 1 — exact Projects + Setup visual acceptance — complete

Present all three viewports and required states with before/after/diff,
interaction/accessibility results, changed component ownership and explicit
confirmation that routes, APIs, auth, permissions, dependencies and baselines
did not change outside scope. Stop for Product Owner review.

Only `UI-APPROVED:` permits golden updates. Visual approval does not authorize
merge or deploy.

Approval record:

`UI-APPROVED: Projects + Setup PR 1`

## PR 2 — Tasks, Overview and Process

Status: complete. Exact approval:
`UI-APPROVED: Shell + Login + Задачи + Обзор + Процесс PR 2`.

Scope:

- preserve the accepted GitHub Project board/detail grammar and Tasks-only
  project selector;
- use canonical Tabs, expose invalid/partial/error/read-only states and replace
  the clipped mobile six-column board with the approved stage switch/list;
- make Overview scan project health, task-count progress and risk without raw
  provider errors;
- keep every project Process, execution mode, routing and context action in
  progressive rows;
- either adopt a privacy-safe provider-neutral projection from
  `portfolio-view.ts` or delete it and its test in this PR.

Acceptance:

- Tasks board/detail/blocked/empty/loading/partial/error/read-only pass at all
  viewports with no page overflow;
- desktop Tasks still reads as the approved GitHub board;
- Overview and Process retain confirmed facts during stale/partial states and
  never expose raw IDs, logs or codes;
- no duplicate tab, portfolio model, task command path or dead selector remains.

## PR 3 — Chats, Agents and systems, Roles and access, shell cleanup

Status: next implementation slice under #300. Do not reopen PR 1/PR 2 design
or change their approved baselines unless a concrete regression requires a
new exact visual decision.

Scope:

- migrate the remaining portfolio-wide sections to the same project rows,
  integration/status patterns and read-only notice;
- preserve Telegram, Bitrix, Hermes and membership behavior;
- add skip-to-content, mobile session action, shell-preserving loading/error
  recovery and offline notice;
- remove every remaining legacy file, selector, trivial wrapper and unused
  export after its final consumer moves.

Acceptance:

- configured/unconfigured/degraded/offline/read-only/empty states render at all
  viewports;
- mobile navigation contains every section and logout;
- the shell remains usable during loading, route error and browser offline;
- no run traces, raw logs, identifiers or runtime console are added;
- one canonical owner remains for tokens, buttons, tabs, status, notices, rows,
  setup rail and dialogs;
- `rg` finds no stale import/selector and no dormant production projection.

## Final gates

1. Exact all-screen visual package approval.
2. Golden snapshot update in a dedicated `UI-APPROVED:` commit.
3. Integrable diff and explicit merge approval.
4. Separate release/deploy approval under the production runbook.

Failure at a gate stops the sequence. It does not authorize a compensating
redesign, backend change, baseline rewrite or broad unrelated cleanup.
