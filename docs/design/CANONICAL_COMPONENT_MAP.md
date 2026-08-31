# Canonical component map

Status: proposed consolidation map. “Target” does not mean “build now”; create
only what the next approved slice immediately consumes.

## Existing canonical layer

| Existing component | File | DOM selector | Keep / change |
| --- | --- | --- | --- |
| `AppShell` | `apps/web/src/ui/foundation.tsx:13-25` | `.fcp-app-shell`, `.fcp-app-sidebar`, `.fcp-app-topbar`, `.fcp-app-main` | Keep; extract subcomponents only if reused; add skip link and mobile session action |
| `PageHeader` | `foundation.tsx:27-36` | `.fcp-page-header`, `.fcp-page-actions` | Keep; use for project detail header via composition |
| `SettingsPage` | `foundation.tsx:38-40` | `.fcp-settings-page` | Rename to neutral `PageStack` only with atomic migration; current name is misleading across non-settings pages |
| `SettingsSection` | `foundation.tsx:42-51` | `.fcp-settings-section` | Keep for meaningful bounded settings groups, not project/card wrapper by default |
| `SettingRow` | `foundation.tsx:53-63` | `.fcp-setting-row` | Keep; specialize by composition into integration/document/access rows |
| `Status` | `foundation.tsx:65-67` | `.fcp-status.is-{tone}` | Rename/extend to `StatusIndicator`; retain text + semantic tone; no generic badge clone |
| `Notice` | `foundation.tsx:69-72` | `.fcp-notice.is-{tone}` | Keep as `InlineAlert`; support announced status/error semantics |
| `EmptyState` | `foundation.tsx:74-76` | `.fcp-empty-state` | Keep; one explanation and at most one primary action |
| `DividerList` | `foundation.tsx:78-80` | `.fcp-divider-list` | Keep as the canonical row container |
| `AsyncButton` | `apps/web/src/mvp/async-command.tsx:26-29` | `.fcp-primary`, `.fcp-secondary`, `.fcp-danger-button`, `.fcp-icon-button` | Single command control; pair with canonical visual `Button` variants without duplicating pending logic |
| `CommandNoticeView` | `async-command.tsx:31-33` | `.fcp-notice` | Keep; consumes canonical `Notice` |

## Target map for the Projects + Setup slice

| Required role | Reuse / target component | Replaces exact current code/selectors | Retirement rule |
| --- | --- | --- | --- |
| Buttons | `Button` visual variants + `AsyncButton` behavior | raw classes in `tokens.css:87-108`; occasional raw `<button>` in `project-wizard.tsx:101` | One styling implementation; no second button file left unused |
| Portfolio list | `DividerList` + `ProjectListRow` | `SettingsProject`, `.fcp-portfolio-blocks`, `.fcp-project-setup-actions` in `phase-b-ui.tsx:35-54` | Remove expanded portfolio composition when all Projects states use rows |
| Health/setup status | `StatusIndicator` and optional `HealthBadge` only if health has more structure | `Status` calls plus ad hoc setup text | Do not create both Badge and Status for the same fact |
| Project detail header | `PageHeader` + `ProjectHeader` composition | wizard header `.fcp-project-wizard > header` | One header per page; delete duplicate title/description block |
| Tabs | canonical `Tabs` | `ContextTabs`/`.fcp-context-tabs`, `.fcp-wizard-tabs`, Access add-mode tabs | Migrate one accepted surface at a time; each migrated surface deletes its local tab implementation |
| Setup progress | `SetupRail` | `Step`, `.fcp-wizard-step`, `.fcp-wizard-rail` in `project-wizard.tsx` | Preserve state projection; retire ten-step presentation after approved grouping is complete |
| Integration row | `SettingRow` composition named `IntegrationRow` only if repeated semantics justify it | `.fcp-settings-connections`, `.fcp-system-summary`, `.fcp-channel-grid article` | Avoid a second row visual; specialize data slots only |
| Document list | `DividerList` + `DocumentList`/`DocumentRow` composition | `.fcp-phase-b-source-list`, `.fcp-document-rows article` | Upload editor stays one workflow; loaded rows and draft rows share row primitives where practical |
| Upload workflow | `ProjectDocumentsEditor` composed from canonical controls | `.fcp-document-categories`, `.fcp-document-drop`, `.fcp-document-actions` | Keep business validation and API behavior; replace three competing actions with one obvious submit path |
| Inline alert | `Notice` / target `InlineAlert` | `.fcp-wizard-error`, custom `.fcp-control-note` when it expresses state | Local validation may remain inline, but semantic alert styling has one owner |
| Empty/error/loading | `EmptyState`, new `ErrorState`, new `Skeleton`, global `OfflineNotice` | repeated `.fcp-empty`, no page boundaries | Create with first real state consumer and deterministic fixtures |
| Overflow menu | `OverflowMenu` | routine Project delete link | Menu contains secondary actions only; danger action leads to DangerZone/dialog |
| Danger zone | `SettingsSection tone="danger"` composition or `DangerZone` | `ProjectDeleteControl` in normal rows/wizard header | Exactly one implementation at bottom of Access/detail |
| Confirmation | canonical `Dialog` | `ProjectDeleteControl` inline `<div role="alert">` | Dialog and old inline confirmation cannot coexist after migration |
| Read-only state | `ReadOnlyNotice` composition + capability-filtered controls | scattered hidden controls and server-only denial | One consistent explanation; do not render unusable mutations |

## Later-screen mapping

| Surface | Canonical composition | Current local owner |
| --- | --- | --- |
| Shell navigation | `AppShell` with optional `SidebarNav`/`Topbar` internal extraction | `Shell` + `AppShell`; `.fcp-app-nav` |
| Overview project health | `DividerList`, `ProjectListRow`, compact metric/graph primitive | `Dashboard`, `.fcp-dashboard-*`; unused `portfolio-view.ts` projection |
| Tasks board | canonical `Tabs`, board-specific `TaskBoard`/`TaskCard`; not generic Card | `ContextTabs`, `TaskBoardCard`, `.fcp-board*` |
| Task detail | `PageHeader`, `SettingsSection`, `SettingRow`, `InlineAlert`, command controls | `TaskDetail`, `TaskExecutorControl` |
| Process | `ProcessRail`/`ProcessStages` domain composition + divider disclosures | `ProcessStages`, `.fcp-process-steps`, `.fcp-project-tools` |
| Chats/systems/access | `ProjectSection`, `IntegrationRow`, `StatusIndicator`, `ReadOnlyNotice` | `ProjectBlock`, `.fcp-channel-grid`, `.fcp-system-summary`, `.fcp-people-list` |
| Future run inspection | `DataTable`, `Inspector`/`Drawer` only after explicit scope approval | none; LangSmith candidates do not authorize implementation |

## Token consolidation

Canonical tokens stay in `apps/web/app/styles/tokens.css`. Proposed semantic
renames/additions are `--fcp-action-primary`, `--fcp-action-primary-hover`,
`--fcp-bg-selected`, status border/background tokens, popover/dialog shadow
tokens and chart-series tokens. Replace repeated raw values in shared CSS
before feature code uses them. Never place color, radius, shadow, spacing or
motion literals in feature components.

## Duplicate/dead-code disposition

- `apps/web/src/mvp/portfolio-view.ts`: adopt a cleaned provider-neutral
  projection in an approved Overview/Projects slice or delete it with
  `portfolio-view.test.ts`; do not leave it dormant.
- `Header`, `EmptyProjects`, `ProjectBlock` in `phase-b-ui.tsx`: retire trivial
  aliases unless they become a documented stable domain composition.
- `ContextTabs`, `.fcp-wizard-tabs`, role buttons and category buttons:
  converge on canonical accessible selection primitives; delete migrated CSS
  in the same PR.
- Deleted legacy `apps/web/app/styles.css` and
  `apps/web/src/mvp/phase-a-ui.tsx`: verify no imports/selectors remain, then
  commit deletion with the replacement. Do not retain compatibility wrappers.
- `phase-a-ui-foundation.tsx` is a feature composition file, not a second
  design system. Canonical primitives stay in `src/ui`.

The acceptance check for every slice is: one owner per token, primitive,
selector and interaction; every added component is imported by production
code; every replaced path is removed; `rg` finds no stale selector/import.
