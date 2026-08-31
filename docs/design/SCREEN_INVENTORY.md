# Screen and state inventory

Status: audit of the 2026-08-31 unapproved branch candidate. Query URLs are
current implementation paths, not newly approved information architecture.

## Reachable surfaces

| Surface | Current URL | Owner and root selector | Current states | Gaps before acceptance |
| --- | --- | --- | --- | --- |
| Signed-out | `/` when `requireSession()` throws | `app/page.tsx:22-25`; `.fcp-login` | sign-in CTA | Auth/provider failure is indistinguishable from signed out; no recovery/error detail |
| Shell | every signed-in URL | `Shell` -> `AppShell`; `.fcp-app-shell`, `.fcp-app-nav`, `.fcp-app-topbar`, `.fcp-app-main` | seven selected sections, desktop/mobile nav | mobile logout absent; no skip link; no global offline/degraded state |
| Overview | `/` or `/?view=dashboard` | `Dashboard`; `.fcp-dashboard-progress` | zero projects; one block per project; task-count progress | no loading/error/stale/partial state; no explicit portfolio health/decision focus |
| Tasks board | `/?view=tasks&project=<slug>` | `Tasks`; `.fcp-task-page`, `.fcp-task-project-selector`, `.fcp-context-tabs`, `.fcp-board` | default first project; selected project; six stages; per-column empty | invalid project falls back silently; mobile horizontal board; source freshness absent |
| Blocked tasks | `/?view=tasks&project=<slug>&filter=blocked` | `Tasks`; `.fcp-context-tabs a[aria-current=page]` | blocked subset; empty columns | no single useful blocked-empty state; unknown filter silently becomes board |
| Task detail | `/?view=tasks&project=<slug>&task=<itemId>` | `TaskDetail`, `TaskExecutorControl`; `.fcp-task-facts`, `.fcp-task-executor` | status/assignee/block; user loading; assign; confirm; run started/completed/failed; retry; unavailable | invalid item silently returns board; user-fetch error becomes empty; no page loading/error boundary |
| Process | `/?view=process` | `Process`; `.fcp-process-steps`, `.fcp-project-tools` | zero projects; zero/configured stages; manual/autonomous; routing/context read-only or editable | no source error/partial state; collapsed controls do not summarize readiness consistently |
| Chats | `/?view=conversations` | `Conversations`; `.fcp-channel-grid` | zero projects; Telegram ready/not configured; Bitrix ready/unavailable; owner configuration | no loading/error/degraded/offline; Telegram form expands inline without a dedicated disclosure |
| Agents and systems | `/?view=systems` | `Systems`; `.fcp-system-summary` | zero projects; Hermes ready/requires setup | boolean only; missing installing/auth required/offline/degraded/error/heartbeat/read-only states |
| Projects portfolio (currently Settings) | `/?view=settings` | `Settings`, `SettingsProject`; `.fcp-portfolio-blocks`, `.fcp-project-setup-actions` | zero/two or more; complete/incomplete; documents empty/loaded; agent states | not compact rows; one-project state untested; two projects do not fit 1440x900; no health/setup fraction/sync; destructive action exposed |
| New project setup | `/?view=settings&setup=create` | `ProjectSetupWizard(null)`; `.fcp-project-wizard`, `.fcp-wizard-steps`, `.fcp-wizard-form` | registration default/pending/success/error | Add CTA remains visible; no cancel/back path; invalid setup slug aliases this state |
| Resume first incomplete | `/?view=settings&setup=new` | `Settings` selection at `phase-b-ui.tsx:60` | first incomplete project or new registration if none | magic query is not visible IA; completed portfolio unexpectedly opens create flow |
| Existing project setup | `/?view=settings&setup=<slug>` | `ProjectSetupWizard(item)` | ten sequential steps; completed/current/pending; install, auth, context, approval, blocked and first-task sub-states | no Overview/Integrations/Context/Agent/Access tabs; delete in header; rail differs from approved five stages |
| Roles and access | `/?view=people` | `People`, `AccessControls`; `.fcp-people-list`, `.fcp-team-editor` | zero projects; no members; active/inactive; owner editor; non-owner note; directory/new member | role/tabs lack ARIA selection semantics; no explicit credential health, pending request or expiry views |

`view` values outside `dashboard`, `tasks`, `process`, `conversations`, `people`,
`systems`, `settings` fall back to Overview (`app/page.tsx:20`). There are no
separate project detail routes, dialogs, inspectors or not-found screens.

## Required state coverage

Legend: **Y** rendered by production composition; **P** partially represented;
**N** absent. Visual fixture coverage is separate from code reachability.

| Required state | Current | Fixture | Required owning surface / selector |
| --- | --- | --- | --- |
| Two projects | Y | Y | Projects `.fcp-portfolio-blocks`; must become compact rows |
| One project | Y by array shape | N | Projects `ProjectList` |
| No projects | Y | state-only approximation | Projects `EmptyState` with one Add action |
| Page loading | N | N | shell-preserving `Skeleton`/route loading boundary |
| Command pending | Y | Y | `AsyncButton[aria-busy=true]`, form `[aria-busy=true]` |
| Command success/error | Y | Y | `Notice[role=status|alert]` |
| Partial setup | Y | Y | setup summary + rail |
| Completed setup | Y | P | Projects row and setup detail |
| Integration error | P tracker-preparation blocked only | N | `IntegrationRow` + page-level partial notice |
| Documents empty | Y | Y | `EmptyState` within document surface |
| Documents loaded | Y | N | `DocumentList` rows with status/metadata |
| Agent offline | N | N | `AgentSummary`/`IntegrationRow` warning or danger state |
| Agent connected | Y boolean/profile | Y | `StatusIndicator` with last heartbeat when known |
| Read-only permissions | P | N | explicit `ReadOnlyNotice`; mutation controls removed/disabled by capability |
| Stale source | N in UI | N | safe warning with last confirmed observation, no raw code |
| Partial source data | N | N | retain confirmed facts and mark unavailable fields `Unknown` |
| Provider/server error | N at page level | N | recoverable `ErrorState`, preserve shell |
| Offline browser | N | N | global `OfflineNotice`, commands unavailable with reason |
| Destructive confirmation | P inline alert | N | modal `Dialog` inside `DangerZone`, typed project name |
| Reduced motion | Y CSS | N | `prefers-reduced-motion` plus deterministic test |
| Keyboard/focus order | P | N | nav, selector, tabs, dialog, wizard and form checks |

## Setup-state mapping to preserve

Current behavior in `project-setup-state.ts:8-14` must remain provider-neutral
while presentation changes:

| Current fact/command | Current step | Proposed visible group |
| --- | --- | --- |
| repository + tracker registration | 1 | Repository / Tracker |
| active required documents | 2 | Documents |
| process confirmation | 3 | Verification details under Setup |
| team configured or intentionally skipped | 4 | Access |
| communications configured or intentionally skipped | 5 | Integrations |
| Hermes runtime ready | 6 | Agent |
| context current / architecture decision | 7 | Context |
| GitHub Project prepared and verified | 8 | Tracker / Verification |
| readiness summary | 9 | Verification |
| explicit first-task submission | 10 | next safe action after verification, not a hidden setup requirement |

The Product Owner approved the rail wording
`Repository -> Tracker -> Documents -> Agent -> Verification` on 2026-08-31.
Presentation may group these facts, but no accepted command, approval or
explicit-start safeguard may be removed.

## Viewport inventory

- 1440x900: candidate renders all fixture surfaces, but Projects fails the
  two-project-fit gate and Tasks uses a wide internal board scroller.
- 1280x800: required by policy and candidate audit images for every fixture
  surface exist under `artifacts/ui-review/before/`. The viewport is still
  missing from `playwright.config.ts`, so it is evidence but not an automated
  regression gate.
- 390x844: candidate renders without observed page-level horizontal overflow,
  but mobile Tasks exposes a horizontally clipped board, mobile logout is
  unreachable, and the setup wizard places destructive action before its
  progress content.

The exact Projects + Setup package received
`UI-APPROVED: Projects + Setup PR 1` on 2026-08-31. Its baseline is stored in
`apps/web/tests/visual/golden/projects-setup/`; any later update requires a new
exact `UI-APPROVED:` message.
