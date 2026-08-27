# Operator UI contract

The operator workspace follows the existing GitHub/Primer grammar for tasks and
task detail, and the legacy Shell/Dashboard/Process composition (`7b4e9d1`).
This document is a reference hierarchy, not a second design system.

1. Product authority and operator safety in `docs/AI_CONTEXT.md` and ADR 0006.
2. Existing Shell, Dashboard and Process composition.
3. GitHub Project task-board and task-detail grammar.
4. Shared primitives in `apps/web/src/mvp/async-command.tsx` and workspace
   tokens in `apps/web/app/styles.css`.

Every operator mutation uses `useAsyncCommand` and `AsyncButton`. A command
immediately enters pending state, prevents a duplicate request, disables its
control, exposes `aria-busy`, shows a spinner and readable pending label, and
then presents an explicit safe success or error notice. Forms mirror pending
state with `aria-busy` and disable editable fields.

Use only the workspace tokens (`--fcp-*`), existing compact card/list/detail
grammar, and the shared primary/secondary action treatment. Validate desktop
at 1440×900 and mobile at 390×844: no horizontal page overflow, and no scroll
added merely to expose a single action.

Forbidden in operator UI:

- one-off async button/form state, raw `<button>` mutation controls, or a
  second component library/design system;
- ad-hoc colours, fonts, shadows, spacing scales, or new visual language;
- raw database/provider IDs, hashes, receipt references, provider error codes,
  transport payloads, stack traces, or internal diagnostics;
- tracker lifecycle, provider configuration, or runtime controls that do not
  correspond to a canonical operator command.

Future screens start with the existing GitHub/legacy grammar: calm white
surfaces, compact density and token-based separators before any new treatment.
State the operator goal first and expose its create/add action as a direct
primary button, never a disclosure control. Keep forms progressively disclosed
after that button; pending state locks duplicate submission and every outcome
is explicit. Use operator language: do not expose internal nouns such as
source, receipt, audit, provenance or provider IDs unless an operator must act
on that exact fact. Task screens do not contain debug or event feeds, and
settings show only editable or decision-useful facts. Verify each changed
screen at 1440×900 and 390×844: no horizontal overflow, primary controls are
at least 44px, and closed forms do not add scroll merely to reveal an action.

Navigation has two levels. The global state is **Все проекты** and shows the
portfolio list plus only global settings. Selecting any project always opens
its overview; it never retains a prior section or behaves as a global filter.
Within a project, show its identity, a visible **Все проекты** return link,
and only project-scoped navigation. The desktop top bar, breadcrumbs and
mobile menu must express the same `Все проекты → проект → раздел` hierarchy.
