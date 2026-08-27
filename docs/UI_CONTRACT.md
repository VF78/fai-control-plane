# Operator UI contract

The operator workspace follows the GitHub dashboard and repository UI grammar:
calm white surfaces, compact density, restrained borders, familiar navigation
and progressive disclosure. This document is a hierarchy contract, not a
second design system.

1. Product authority and operator safety in `docs/AI_CONTEXT.md` and ADR 0006.
2. GitHub dashboard sections-first shell and repository interaction grammar.
3. GitHub Project task-board and task-detail grammar.
4. Shared primitives in `apps/web/src/mvp/async-command.tsx` and workspace
   tokens in `apps/web/app/styles.css`.

## Navigation and scope

The sidebar always contains one complete ordered list: **Обзор**, **Задачи**,
**Процесс**, **Чаты**, **Агенты и системы**, **Настройки проектов**, **Роли и
доступы**. A project is not a navigation level, global mode, shell mode or
sidebar filter. Do not place a selected project, project list or **Все
проекты** above or around the section navigation.

**Обзор** is portfolio-wide by default. **Процесс**, **Чаты**, **Агенты и
системы**, **Настройки проектов** and **Роли и доступы** are also
portfolio-wide: each page presents one clearly separated, compact block per
available project. Desktop and mobile preserve this same sections-first
hierarchy and project-block order.

Only **Задачи** has a project selector. It is a compact, keyboard-accessible
GitHub-style disclosure next to the page heading, never a native select and
never a list above sidebar navigation. Its choice changes the Tasks project
URL. When the Tasks URL has no valid `project` parameter, the first available
project is selected deterministically. Project parameters do not change the
scope of any other section.

## Page composition

**Обзор** keeps the approved graphical task-count metric and visibly separates
projects. **Процесс** shows the configured process for every project and keeps
project-scoped execution mode, AI-agent routing and context actions reachable
through compact progressive sections.
**Чаты** shows only useful channel readiness, access state and available
actions. **Агенты и системы** and **Роли и доступы** use the same compact
per-project composition and expose only operator decisions or actions.

**Настройки проектов** starts with a portfolio heading and a direct green
**Добавить проект** button. Each project then has one compact block containing
repository and GitHub Project links, active documents only, and AI-agent setup.
Create and edit forms are progressively disclosed inline.

Do not show logs, receipts, audit or event lists, evidence feeds, provider or
internal IDs, hashes, credential references, freshness diagnostics, error
codes, payloads, stack traces or runtime consoles in the operator UI. Backend,
schema and adapter capabilities may retain these facts; they are not page
content. Do not add a tracker lifecycle, provider configuration surface or
runtime control without a canonical operator command.

## Commands, visual system and responsive behaviour

Every operator mutation uses `useAsyncCommand` and `AsyncButton`. A command
immediately enters pending state, prevents a duplicate request, disables its
control, exposes `aria-busy`, shows a spinner and readable pending label, and
then presents an explicit safe success or error notice. Forms mirror pending
state with `aria-busy` and disable editable fields.

Use only the workspace tokens (`--fcp-*`), existing compact card/list/detail
grammar, and shared primary/secondary actions. Primary controls are at least
44px. Transitions are limited to the existing subtle 120–180ms treatment and
must be disabled by `prefers-reduced-motion`.

Validate at 1440×900 and 390×844. There must be no horizontal page overflow,
no second competing page scroller, no action hidden behind avoidable scroll,
and no mobile-only change to information hierarchy. Mobile stacks the same
portfolio project blocks and keeps the Tasks selector in the heading flow.
