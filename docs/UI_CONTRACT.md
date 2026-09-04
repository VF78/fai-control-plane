# Operator UI contract

The operator workspace follows the approved GitHub Dashboard, Project and
repository Settings grammar: calm white surfaces, compact density, restrained
borders, familiar navigation and progressive disclosure. Linear, Vercel and
LangSmith may extend this grammar only in the roles fixed by
`docs/design/REFERENCE_MAP.md`.

1. Product authority and operator safety remain in `docs/AI_CONTEXT.md` and
   ADR 0006.
2. `apps/web/src/ui` owns canonical visual primitives.
3. `apps/web/src/mvp/async-command.tsx` remains the single asynchronous
   mutation contract.
4. Feature code composes these owners and never recreates their visual or
   interaction grammar.

## Measurable foundation

| Concern | Contract |
| --- | --- |
| Shell | 240px desktop sidebar, 56px top bar and one content scroller; content width 1120px, wide task board 1600px |
| Typography | system sans; body 14px/1.5, supporting text 12px/1.45, H1 24px/1.25, H2 20px/1.3, H3 16px/1.35; weights 400/500/600 |
| Spacing | canonical 4px grid: 4, 8, 12, 16, 20, 24, 32, 40 and 48px |
| Colour | canvas #f6f8fa, surface #ffffff, text #1f2328, muted #59636e, border #d0d7de, action/focus #0969da, success #1a7f37, warning #9a6700, danger #cf222e |
| Borders | 1px neutral dividers; controls 6px radius; bounded surfaces 8px; pills only for semantic status |
| Controls | 32px compact controls and 44px isolated/touch targets; visible hover, focus, disabled and pending states |
| Motion | state-only 120–180ms transitions, disabled for reduced motion |
| Responsive | identical information order at 1440×900, 1280×800 and 390×844 |

Blue is the single generic action/navigation accent. Green communicates only
confirmed healthy or successful state; yellow attention; red critical or
destructive state; gray neutral or unknown state. A page or bounded workflow
has one primary action.

Prefer rows, lists, dividers, whitespace and typography. Cards are used only
when the whole surface is one interactive object. No nested cards, card grids,
decorative gradients, ornamental animation, native-looking controls, raw
feature-level visual values or parallel component systems are allowed.

## Navigation and project scope

The ordered top-level list is: **Обзор**, **Задачи**, **Процесс**, **Чаты**,
**Агенты и системы**, **Проекты**, **Роли и доступы**. A project is not a
sidebar level or global shell mode.

Overview, Process, Chats, Agents and systems, Projects, and Roles and access
remain portfolio-wide. Only Tasks has the compact GitHub-style project
selector. Existing `view=settings` URLs remain compatible even though the
visible section name is **Проекты**.

## Projects and project setup

The default Projects page shows one compact divider list of project rows. Each
row exposes name, semantic health/setup status, setup fraction, repository,
tracker, agent readiness, last confirmed synchronization and one navigation
affordance. Two current projects fit fully at 1440×900. No inline document
editor, agent form or delete action appears in a portfolio row.

Project detail uses one header with health, setup progress, one primary next
action; five tabs: **Обзор**, **Интеграции**,
**Контекст**, **Агент**, **Доступ**; and the visible setup summary:

`Репозиторий → Таск-трекер → Документы → Чаты → ИИ-агент → Проверка`.

The existing process, team, communications, context, tracker preparation,
approval and readiness commands remain reachable inside those groups without
API, permission or idempotency changes. Starting the first task is the next
explicit safe action after readiness, not a hidden setup-completion condition.
The Chats step uses the same channel-settings component as the portfolio-wide
Chats page. It exposes internal Telegram and a separate client contour with
Telegram or Matrix/Element, and may be explicitly deferred without appearing healthy.

Documents use one obvious upload workflow. Delete exists only in the final
Danger Zone, requires the exact project name in an accessible dialog and
remains server-authorized.

## States and commands

Every data surface owns default, loading, empty, partial, configured,
warning/error, degraded and read-only states. The shell owns offline and route
error. Confirmed facts remain visible when other facts are unavailable; unknown
facts use safe operator wording. Never expose raw provider IDs, hashes, error
codes, receipts, logs, payloads, credential references or runtime consoles.

Every mutation uses `useAsyncCommand` and `AsyncButton`: pending state starts
immediately, duplicate requests are disabled, `aria-busy` and a readable
pending label are exposed, and an explicit success or safe error notice
follows.

## Visual acceptance

Each UI slice must render and be inspected at 1440×900, 1280×800 and 390×844
with before, after and diff evidence plus focused keyboard, accessible-name and
reduced-motion checks. Golden snapshots may change only after an exact
`UI-APPROVED:` message. Visual approval, merge and deploy are separate gates.
