# UI governance audit

Status: historical audit evidence for the discarded
`codex/ui-foundation-full-migration` working tree on 2026-08-31. The Product
Owner subsequently approved D3, D4, D6, the bounded reference map and the
Projects + Setup hierarchy for PR 1. This audit does not approve rendered
screens, replace a golden baseline or authorize merge/deploy.

## Evidence and baseline distinction

- `references/current/projects-settings-before.png` is a **legacy production
  screenshot** of `/?view=settings`. It shows two permanently expanded project
  blocks, nested bordered surfaces, Documents and AI agent side by side, four
  competing document actions, a green add action, a blue upload action, and a
  routine delete action. It is evidence of the starting problem, not a design
  target.
- The working tree is a separate **unapproved branch candidate**. Its render is
  governed by `apps/web/app/page.tsx`, `src/mvp/phase-a-ui-foundation.tsx`,
  `src/mvp/phase-b-ui.tsx`, `src/mvp/project-wizard.tsx`, `src/ui/foundation.tsx`
  and `app/styles/{tokens,foundation,pages}.css`. It has a calmer shared shell
  and row/divider grammar, but it is not visually accepted and must not replace
  the legacy image or any future golden.
- The local candidate fixture rendered successfully at 1440x900 and 390x844:
  18/18 capture cases passed. Every fixture surface was also rendered at
  1280x800 with local Chrome. Copies for all three viewports are under
  `artifacts/ui-review/before/`; they are ignored audit evidence, not a golden
  baseline. The 1280x800 viewport is not yet a configured Playwright project
  and therefore is not an automated gate.
- The candidate images under `references/candidates/` are not in an
  `references/approved/` pack in the audit branch. The Product Owner later
  approved the bounded `REFERENCE_MAP.md`; GitHub remains the primary grammar,
  while Linear portfolio/graph, Vercel operation/confirmation and LangSmith
  dashboard/trace images remain supplementary by their mapped roles only.

## Current implementation shape

`apps/web/app/page.tsx:20-79` is the only page router. `view` selects seven
sections; only Tasks consumes `project`; Settings consumes `setup`. The server
loads all page data before rendering and has no `app/loading.tsx`,
`app/error.tsx`, or offline boundary. Any `requireSession()` error is converted
to the signed-out screen at `page.tsx:22-25`; later query failures fall through
to the framework error surface.

The current canonical layer is small and real:

- `apps/web/src/ui/foundation.tsx`: `AppShell`, `PageHeader`, `SettingsPage`,
  `SettingsSection`, `SettingRow`, `Status`, `Notice`, `EmptyState`,
  `DividerList`.
- `apps/web/src/mvp/async-command.tsx`: `useAsyncCommand`, `AsyncButton`,
  `CommandNoticeView`; this is the command contract and must be promoted or
  explicitly retained, never cloned.
- `apps/web/app/styles/tokens.css` and `styles/foundation.css`: shared tokens,
  controls, shell, rows and state styling.

Feature composition remains concentrated in two large files:
`phase-a-ui-foundation.tsx` owns shell, Overview, Tasks and Process, while
`phase-b-ui.tsx` owns Chats, Systems, Projects Settings and Access. The
ten-step setup implementation lives separately in `project-wizard.tsx`.

## Findings

### P0 — approval and safety blockers

1. **The branch candidate does not implement the approved Projects vertical
   slice.** `phase-b-ui.tsx:35-54` still renders every project as an expanded
   `SettingsSection` containing repository/tracker rows, Documents editor and
   AI-agent activation. `.fcp-portfolio-blocks` and nested
   `SettingsSection`s make the first incomplete project consume nearly the
   entire 1440x900 viewport. Both projects do not fit, violating
   `screens/PROJECTS_AND_SETUP.md` criterion 1.
2. **Semantic color is internally contradictory and currently wrong for the
   master brief.** `tokens.css:14-16` aliases `--fcp-primary` to green success;
   `.fcp-primary` at `tokens.css:100` drives every generic command, including
   `.fcp-add-project` at `phase-b-ui.tsx:65`. `UI_CONTRACT.md` explicitly calls
   for a green Add button, while `UI_SYSTEM_MASTER.md` and the screen hard gate
   reserve green for success. This needs an exact human decision and one
   contract update before code.
3. **Delete is a routine action and confirmation is insufficient.**
   `ProjectDeleteControl` is rendered in every project row
   (`phase-b-ui.tsx:41`) and at the top of the setup wizard
   (`project-wizard.tsx:173`). Its inline `role="alert"` at
   `operator-controls.tsx:41-48` is not a modal dialog, has no focus trap or
   return-focus behavior, and does not require the project name. This violates
   the screen specification and exposes a destructive action on mobile near
   the page start.
4. **Read-only settings are not represented safely.** Settings always renders
   Add, delete, document upload and agent activation controls
   (`phase-b-ui.tsx:41,48,51,65`) without a membership capability supplied to
   the component. Server denial is necessary but not sufficient; the required
   read-only state is absent. Process and Access hide some controls but provide
   inconsistent explanation (`operator-controls.tsx:146-149,186`).

### P1 — structural and state gaps

5. **Portfolio information is missing.** Settings shows setup complete/not
   complete but no compact `ProjectListRow`, setup fraction, repository +
   tracker + agent summary, health, last synchronization or navigation
   affordance. `portfolio-view.ts` computes a richer health projection but is
   unused by production UI and exposes raw `errorCode` in `healthReason`
   (`portfolio-view.ts:80-89`), which conflicts with the operator contract.
6. **Setup structure diverges from the approved five-stage rail.**
   `project-wizard.tsx:167-186` exposes ten steps and only renders the active
   step. It combines Repository and GitHub Project in step 1, then prepares
   Project in step 8. There are no project detail tabs (Overview, Integrations,
   Context, Agent, Access), overflow menu, or stable project detail header.
   Existing behavior must be regrouped, not deleted or duplicated.
7. **Loading/error/partial/offline states are incomplete.** Command pending,
   success and error exist through `AsyncButton` and `Notice`; wizard polling
   has local spinners. There is no page skeleton, route error recovery, offline
   notice, stale/partial project treatment, or explicit integration error row.
   `TaskExecutorControl` collapses user-fetch error into an empty list
   (`operator-controls.tsx:204-207`). Systems reduces Hermes to a boolean
   (`phase-b-ui.tsx:28`), so offline/degraded/last heartbeat cannot be read.
8. **Empty states are uneven.** Project, tasks, process and document empties
   exist, but board empty is repeated text in six columns, an invalid `task`
   silently returns the board, and invalid `setup` silently opens the create
   wizard because `selected` becomes null (`phase-b-ui.tsx:60-67`). Empty
   actions often say “settings” even if the intended label becomes Projects.
9. **No data-level loading fixture exists.** `tests/visual/fixture-app.tsx:14`
   labels a state as loading, but only renders a disabled command button. The
   visual suite covers two projects plus a partial wizard; it does not cover
   zero/one project, completed setup, integration error, loaded documents,
   agent offline, read-only, route error or offline. Its configured projects
   still omit 1280x800 even though separate audit captures now exist.

### P1 — responsive and accessibility gaps

10. **Mobile navigation loses session control.** At
    `foundation.css:85`, `.fcp-logout` is hidden and the mobile disclosure in
    `AppShell` contains only section links (`foundation.tsx:17-25`). Logout is
    unreachable at 390x844. The current section name and access context are
    also hidden.
11. **Tasks mobile is not the required one-column information order.**
    `.fcp-board` remains six horizontal columns (`pages.css:43,168`); the
    390x844 render exposes only a clipped horizontal slice. An intentional
    board scroller may remain on desktop, but mobile needs an approved compact
    list or controlled stage switch without page overflow.
12. **Tabs/toggles lack complete semantics.** `.fcp-wizard-tabs` has
    `role="tablist"`, but child buttons lack `role="tab"`, `aria-selected`,
    `aria-controls` and keyboard arrow behavior (`project-wizard.tsx:157`,
    `operator-controls.tsx:193`). Category and role choices rely on `.active`
    color without `aria-pressed` (`operator-controls.tsx:84,191-194`).
13. **The mobile menu and project selector use native `details` but lack
    dismissal/state polish.** They are keyboard focusable, yet no explicit
    expanded-state styling, Escape/return-focus behavior, collision handling,
    or automated keyboard flow is covered. This is lower risk than the tabs
    and destructive confirmation.
14. **Raw visual values remain in shared CSS.** The candidate correctly keeps
    feature JSX mostly token-based, but shared CSS still repeats raw blues,
    greens, warning colors, shadow alpha and the orange tab underline
    (`tokens.css:62,84,100`; `foundation.css:17,27,89`;
    `pages.css:8-18,36,41,68,86,104-105,124,138,154,158`). These need semantic
    tokens before they spread.

### P2 — ownership, duplication and dead code

15. `portfolio-view.ts` plus its test are production-dead. Either adopt a
    provider-neutral, privacy-safe projection in the Overview/Projects slice
    or delete both in the same PR. Do not leave a second dormant portfolio
    model.
16. `Header`, `EmptyProjects`, and `ProjectBlock` in `phase-b-ui.tsx:23-25`
    merely alias foundation primitives; keep only if they encode a stable
    domain composition. `ContextTabs`, local wizard tabs, role toggles and
    document-category toggles are separate interactive patterns that should
    converge on canonical `Tabs`/`SegmentedControl` semantics.
17. The working tree deletes legacy `app/styles.css` and
    `src/mvp/phase-a-ui.tsx` while adding split styles and
    `phase-a-ui-foundation.tsx`. That is a valid cutover shape only if all
    imports, tests and retained-path documentation move atomically. The dirty
    branch is not evidence that retirement is complete.
18. The canonical-component list in `UI_SYSTEM_MASTER.md` is largely
    unimplemented: no standalone `SidebarNav`, `Topbar`, button variants,
    `Tabs`, `HealthBadge`, `ProjectListRow`, `SetupRail`, `IntegrationRow`,
    `DocumentList`, `DataTable`, `Inspector`, `Drawer`, `Dialog`,
    `OverflowMenu`, `DangerZone`, `Skeleton`, or `ErrorState`. Add only
    components required by an accepted slice; a checklist-driven component
    library would itself become a parallel design system.

## Reference-pack gap summary

The current branch borrows GitHub's neutral shell, settings rows, divider
density and board columns reasonably well. It does not yet meet the GitHub
Settings model for progressive disclosure or danger-zone separation. Linear
may inform compact portfolio rows and health hierarchy, Vercel may inform
setup progress/confirmation, and LangSmith should remain unused until an agent
run inspection surface is approved. None of those supplementary candidates
authorizes dark branding, cards, dashboard chrome, trace logs in normal pages,
or changes to the GitHub-derived Tasks grammar.

## Audit conclusion

The discarded candidate was useful audit evidence, not an accepted full
migration, and must not be merged as one visual change. D3, D4, D6, the
reference map and the Projects + Setup hierarchy are now recorded as approved
in `DESIGN_DECISIONS.md`. The exact PR 1 rendered package and its golden update
were approved on 2026-08-31. The next gate is review of the integrable diff and
explicit merge approval; deploy remains a separate decision.
