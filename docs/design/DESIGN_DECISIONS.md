# UI Foundation decisions

Status: D3, D4, D6, the reference map and the Projects + Setup hierarchy were
approved by the Product Owner on 2026-08-31 for PR 1 implementation. The exact
rendered PR 1 package was subsequently approved on the same date. GitHub
Dashboard, Project board and repository Settings are primary; supplementary
references never override them.

## Product and visual thesis

f(AI) Control is a sections-first supervisory workspace. It should read like a
calm GitHub operational surface: compact rows, dividers, direct language,
progressive detail and one obvious safe action. Portfolio health and next
action are visible before configuration detail. Cards are exceptional, and
settings are deliberately quieter than Overview, Tasks or future run traces.

## D1 — primary grammar

**Proposed: accept.** Use GitHub Dashboard for shell density and portfolio
sections, GitHub Project for Tasks board/detail, and repository Settings for
rows, forms, progressive disclosure and danger separation. Use Linear only to
clarify compact portfolio health, Vercel only for setup/operation confirmation,
and LangSmith only for a later approved run-inspection surface. Do not import
their brand assets, dark themes or global navigation.

## D2 — section hierarchy and project scope

**Proposed: accept current contract.** Keep one ordered section list. Only
Tasks has a project selector. Overview, Process, Chats, Agents and systems,
Projects, and Roles and access stay portfolio-wide and show project blocks in
one stable order. Opening a project detail from Projects is progressive detail
inside that section, not a global shell mode or sidebar project level.

## D3 — section label

**Approved.** `UI_SYSTEM_MASTER.md` and the screen spec say **Проекты**;
`UI_CONTRACT.md` and current code say **Настройки проектов**. Proposed choice:
rename the navigation and H1 to **Проекты** because the surface becomes a
portfolio plus detail/setup experience, not a settings dump. If approved,
update the contract, visible copy, tests and screenshots in one slice. URL
compatibility remains `view=settings` unless a separate routing change is
approved.

## D4 — action accent and semantic colors

**Approved.** Use blue `--fcp-action-primary` for generic
navigation and commands; green only for confirmed healthy/success status;
yellow only for attention; red only for critical/destructive. This resolves
the master brief and screen hard criterion, but changes the current contract's
explicit green Add button. Approval must update `UI_CONTRACT.md` first. There
must be exactly one primary action per page or clearly bounded workflow.

## D5 — Projects portfolio

**Proposed: accept.** Replace expanded settings blocks with one divider list of
interactive `ProjectListRow`s. Each row shows name, semantic health/setup
status, setup fraction, repository, tracker, agent readiness, last confirmed
synchronization and a navigation affordance. Two fixture projects must fit
fully at 1440x900. No document editor, agent form or delete action appears in a
portfolio row. Empty state has one Add action.

## D6 — project detail and setup grouping

**Approved.** The screen spec names five tabs (Overview,
Integrations, Context, Agent, Access) and a five-node setup rail, while current
behavior has ten sequential steps. Proposed choice:

1. keep the five project-detail tabs;
2. show a five-node setup summary: Repository, Tracker, Documents, Agent,
   Verification;
3. preserve Process, Team, Communications, Context, Project preparation and
   first-task commands as progressive substeps in the relevant tabs;
4. treat “First task” as the next explicit safe action after readiness, not as
   a hidden requirement that prevents setup completion.

This is presentation regrouping only. The data model, APIs, approvals,
idempotency and explicit Hermes submission remain unchanged.

## D7 — setup interaction

**Proposed: accept.** The project header contains project name, health, setup
progress, one primary next action and an overflow menu. A setup rail navigates
to the next incomplete group but does not unlock unsafe future mutations.
Forms expand inline within the active tab or a bounded dialog where
confirmation is required. Invalid setup/project URLs show a recoverable
not-found state instead of silently opening creation.

## D8 — destructive action

**Proposed: accept.** Delete lives only in `DangerZone` at the bottom of Access
or Settings detail and may also be linked from an overflow menu. Confirmation
uses canonical `Dialog`, announces title/description, traps focus, returns
focus, and requires the exact project name. Red never appears on routine
portfolio rows.

## D9 — state model

**Proposed: accept.** Every data surface owns default, loading, empty, partial,
configured, warning/error, degraded and read-only states. Global shell owns
offline and route error. Confirmed facts remain visible during partial/stale
conditions; unknown facts say `Неизвестно` or `Не настроено`. Never show raw
provider IDs, hashes, error codes, receipts, logs or payloads.

## D10 — responsive model

**Proposed: accept.** Preserve the same information order at 1440x900,
1280x800 and 390x844. Desktop uses the 240px sidebar and one main scroller.
Mobile uses one fixed header/menu containing navigation and session action.
Projects stack row fields compactly. Project tabs use an accessible horizontal
tab scroller or controlled menu. Tasks requires a separately approved mobile
stage switch/list; a clipped six-column board is not accepted.

## D11 — accessibility baseline

**Proposed: accept.** All controls have accessible names, visible focus,
44px touch targets where isolated, and state not conveyed by color alone.
Tabs implement tab roles, selected state, controlled panels and arrow keys;
toggle groups use `aria-pressed` or radio semantics. Pending regions announce
their state without moving focus. Dialogs implement focus lifecycle. Add a
skip-to-content link and retain reduced-motion behavior.

## D12 — canonical implementation boundary

**Proposed: accept.** `apps/web/src/ui` owns reusable visual primitives and
tokens. Feature files own domain composition only. `useAsyncCommand` and
`AsyncButton` remain the single mutation contract; either move them into the
canonical layer with all imports changed in the same PR or leave them in MVP
and re-export—never copy them. Add a primitive only when the accepted slice
uses it immediately. Delete the replaced implementation and selectors in the
same PR.

## D13 — route compatibility and product behavior

**Proposed: accept.** Keep current `view` routes, data loading, permissions,
integrations and APIs through the visual migration. If project detail needs a
subview, use the existing Settings scope (`setup=<slug>` plus an approved
detail query) rather than making project a shell-wide scope. Route redesign,
backend mutation and copy expansion are out of scope.

## D14 — visual acceptance

**Proposed: accept.** Each slice produces deterministic before, after and diff
artifacts at all three viewports; functional, keyboard, accessible-name and
reduced-motion checks accompany screenshots. Candidate artifacts remain under
`artifacts/ui-review/after` and `diff`. Golden update requires an exact
`UI-APPROVED:` message. Visual approval does not authorize merge or deploy.

## Approval record

Product Owner message:

`APPROVE_UI_FOUNDATION: D3, D4, D6, карта референсов и иерархия Projects + Setup согласованы.`

This authorizes PR 1 implementation only. Rendered-screen acceptance, golden
snapshot update, merge and deploy remain separate gates.

Rendered-screen approval:

`UI-APPROVED: Projects + Setup PR 1`

This authorizes the Projects + Setup golden update only. Merge and deploy
remain separate gates.
