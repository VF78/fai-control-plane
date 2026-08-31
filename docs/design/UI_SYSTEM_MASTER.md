# f(AI) Control — UI System Master Brief v1.0

## 1. Product context

f(AI) Control is a control plane for software delivery performed by
people and AI agents. It is not a generic admin panel and not a new task
tracker.

The interface must help Product Owners and Delivery Leads answer, within
seconds:

- Which project requires attention?
- What is currently blocked or stuck?
- What is waiting for QA, acceptance, or approval?
- Which agent is working, what did it do, and what did it cost?
- Which integration, credential, report, or scheduled job is unhealthy?
- What is the next safe action?

The UI should feel like a premium professional operating tool:
calm, fast, precise, lightweight, and trustworthy.

## 2. Current failure mode

The current screen has accumulated local decisions without a canonical
UI system:

- large permanently expanded project blocks;
- nested borders and card-within-card structure;
- competing blue, green, and orange accents;
- weak primary-action hierarchy;
- destructive actions shown too prominently;
- excessive chrome despite large empty areas;
- setup, documents, agent configuration, and deletion competing on one
  visual level;
- no strong visualization of delivery health or agent activity.

The solution is not another local redesign. The solution is a persistent
repository-wide UI system plus deterministic visual acceptance.

## 3. Visual source-of-truth

Text alone is not enough.

Before implementation, Codex must create a local, reviewable reference
pack from the official pages listed in `REFERENCE_MANIFEST.md`.

Priority:

1. approved local screenshots;
2. approved screen specifications;
3. canonical tokens/components;
4. written reference map;
5. public URLs.

Codex must not code from public URLs without first saving and reviewing
the relevant visuals locally.

Product Owner decision: the already approved GitHub Dashboard, GitHub Project
and repository Settings grammar is the base layer for the current product.
The Linear, Vercel and LangSmith pack extends that base only where GitHub does
not express the required portfolio, setup or agent-run behavior. It does not
authorize a new visual language or a replacement task board.

## 4. Reference roles

### GitHub — primary product grammar

Use for:

- shell density and calm operational hierarchy;
- repository settings rows and dividers;
- GitHub Project task board and task details;
- familiar controls, focus states and progressive disclosure.

Do not copy provider-specific navigation or expose technical identifiers that
do not help the operator.

### Linear — portfolio and project health extension

Use for:

- app shell;
- sidebar;
- top-level navigation;
- typography and density;
- project portfolio;
- project health;
- project overview;
- details inspector;
- compact rows and lists;
- milestones and progress graph.

Do not copy:

- Linear brand identity;
- issue-tracker-specific language;
- their exact icons or assets;
- unnecessarily tiny text.

### Vercel — bootstrap and operations extension

Use for:

- project bootstrap;
- integrations and connection status;
- operational project settings;
- environment/run status;
- project-first navigation;
- setup forms;
- overflow menus;
- Danger Zone.

Do not copy:

- Vercel's black-and-white brand wholesale;
- infrastructure-specific terminology not relevant to f(AI) Control;
- developer-only complexity on Product Owner screens.

### LangSmith — agent-run inspection extension

Use only for:

- agent runs;
- trace tree and nested tool calls;
- duration, tokens, cost, errors;
- input/output and artifact inspection;
- audit timeline;
- master-detail debugging views.

Do not use LangSmith as the global product shell.

## 5. Design principles

### 5.1. Calm hierarchy

- One primary workspace.
- One navigation layer.
- One secondary context layer or inspector where needed.
- One action accent.
- Minimal chrome.
- Dense but readable information.

### 5.2. Cardless by default

Use:

- page sections;
- rows;
- lists;
- dividers;
- whitespace;
- alignment;
- columns;
- contextual side panels.

Use cards only when the entire card behaves as one object.

### 5.3. Operational copy

UI text must orient, report state, and enable action.

Good:

- «Последняя синхронизация»
- «Требует настройки»
- «Ожидает подтверждения»
- «Агент не отвечает»
- «3 задачи в QA»

Avoid marketing copy, metaphors, long explanations, and repeated
subtitles on operational screens.

### 5.4. One primary action

Each screen or clearly bounded region has one primary action.
Secondary and destructive actions must not compete with it.

### 5.5. Semantic color

- Accent: primary action/navigation only.
- Green: healthy/success.
- Yellow: at risk/attention.
- Red: critical/destructive.
- Gray: neutral/unknown/inactive.

Never use green as a generic primary CTA.

### 5.6. Motion

Motion must clarify:

- selection;
- state transition;
- expanding detail;
- running process;
- new event.

Motion must be fast, restrained, and optional for reduced-motion users.
No ornamental animation on settings forms.

## 6. Suggested token foundation

Codex must inspect the existing stack and map these roles into the
current token mechanism instead of adding raw values to feature code.

Required semantic token groups:

- `bg.canvas`
- `bg.surface`
- `bg.subtle`
- `bg.selected`
- `border.subtle`
- `border.strong`
- `text.primary`
- `text.secondary`
- `text.muted`
- `action.primary`
- `action.primaryHover`
- `status.success`
- `status.warning`
- `status.critical`
- `status.neutral`
- `focus.ring`

Spacing scale:

- 4, 8, 12, 16, 20, 24, 32, 40, 48

Radius roles:

- control;
- surface;
- dialog;
- pill only for semantic status or compact metadata.

Elevation roles:

- none by default;
- popover;
- dialog;
- temporary floating inspector.

Typography roles:

- page title;
- section title;
- body;
- secondary body;
- metadata;
- label;
- numeric/KPI;
- code/identifier.

Prefer the existing production font if it is coherent.
Do not add a font dependency without approval.

## 7. Canonical component layer

The audit must locate, consolidate, or create one canonical version of:

- `AppShell`
- `SidebarNav`
- `Topbar`
- `PageHeader`
- `PrimaryButton`
- `SecondaryButton`
- `IconButton`
- `Tabs`
- `StatusIndicator`
- `HealthBadge`
- `ProjectListRow`
- `SetupRail`
- `IntegrationRow`
- `DocumentList`
- `EmptyState`
- `InlineAlert`
- `DataTable`
- `Inspector`
- `Drawer`
- `Dialog`
- `OverflowMenu`
- `DangerZone`
- `Skeleton`
- `ErrorState`

A generic `Card` must not become the default wrapper for every region.

## 8. Information architecture direction

Top-level navigation:

- Обзор
- Задачи
- Процесс
- Чаты
- Агенты и системы
- Проекты
- Роли и доступы

The existing label «Настройки проектов» should become a project
portfolio and project detail/setup experience.

A project context should expose:

- Обзор
- Интеграции
- Контекст
- Агент
- Доступ

Future operational surfaces may include:

- Runs / Запуски
- Approvals / Согласования
- Audit / Журнал
- Health / Состояние

## 9. Where the wow belongs

Do not try to make a settings form visually spectacular.

Premium differentiation should come from real operational
visualizations:

### 9.1. Live Delivery Rail

`Work Item -> PR -> QA -> Staging -> Acceptance -> Done`

The active node, stuck node, owner, agent, and blocker are visible from
real events.

### 9.2. Project Health Graph

Show:

- current green/yellow/red health;
- 7/30-day trend;
- stuck items;
- QA/report SLA;
- milestone forecast.

### 9.3. Agent Run Trace

Show:

`event -> task packet -> tools -> approval -> artifact -> result`

Each node can reveal duration, tokens, cost, errors, and output.

### 9.4. Command palette

Support fast operational navigation and actions through Cmd/Ctrl+K.

These features belong in Overview/Runs, not in project settings.

## 10. Scope discipline

The first accepted vertical slice is Projects + Project Setup.
It establishes the design system for all future screens.

No other screen is redesigned until this slice is visually accepted and
its golden snapshots are approved.
