# Screen Specification — Projects and Project Setup Vertical Slice

## Purpose

Turn the current overloaded «Настройки проектов» screen into:

1. a compact portfolio screen called «Проекты»;
2. a focused project detail/setup experience;
3. the canonical visual standard for subsequent f(AI) Control screens.

## User goals

A Product Owner must be able to:

- see all projects and their health in seconds;
- identify incomplete setup;
- open a project;
- understand the next required setup action;
- inspect repository, tracker, documents, agent, and access;
- avoid accidental destructive actions.

## Portfolio screen

### Header

Title:

`Проекты`

Optional supporting line only if it adds operational value.

Primary action:

`Добавить проект`

No other competing primary CTA.

### Project representation

Projects are compact interactive rows, not permanently expanded
mega-cards.

Each row shows:

- project name;
- current health or setup status;
- repository;
- tracker;
- agent connection status;
- last synchronization;
- clear navigation affordance.

Example information pattern:

```text
ASCON                         Настройка 3/5        Требует внимания
VF78/ascon · GitHub Project · OpenClaw
Последняя синхронизация 8 минут назад                          >
```

At 1440x900, both current projects must fit completely without vertical
scroll.

### Empty state

When no projects exist:

- one clear explanation;
- one primary action;
- no decorative card grid.

## Project detail/setup

### Header

Show:

- project name;
- semantic health/status;
- setup progress;
- one primary next action;
- overflow menu.

The delete action must not be permanently visible in the normal header.

### Tabs

- Обзор
- Интеграции
- Контекст
- Агент
- Доступ

### Setup rail

Show a compact progress rail:

`Репозиторий -> Трекер -> Документы -> Агент -> Проверка`

States:

- completed;
- active;
- pending;
- error.

The rail must communicate the next step without a long explanatory
paragraph.

## Integrations tab

Rows, not nested cards:

- GitHub Repository;
- GitHub Project or configured tracker;
- Telegram/notification channel;
- Agent Runtime.

Each row shows:

- status;
- connected identity/resource;
- last check;
- one contextual action.

## Context tab

### Empty

- short explanation;
- one dropzone or file picker;
- accepted formats and limits;
- one upload action.

### Loaded

Display documents as a clean list:

- name;
- type;
- size;
- processing/index status;
- updated time;
- overflow action.

Avoid separate competing buttons such as:

- add document;
- clear;
- upload documents;

unless the workflow truly requires them. Default to one primary upload
path.

## Agent tab

Show:

- agent profile/name;
- runtime;
- connection status;
- last heartbeat;
- permissions summary;
- last run;
- one primary configuration action.

Offline/degraded state must be immediately readable.

## Access tab

Show:

- human roles;
- agent identity/permissions;
- credential health;
- pending access requests;
- temporary access expiry where applicable.

## Danger Zone

Located at the bottom of the appropriate settings/access surface.

Delete project requires:

- explicit destructive styling;
- confirmation dialog;
- entering the project name or equivalent strong confirmation.

## Responsive behavior

### Desktop 1440x900

- full sidebar;
- compact project rows;
- clear content column;
- optional contextual inspector.

### Compact desktop 1280x800

- preserve the same hierarchy;
- avoid horizontal overflow;
- keep primary action visible.

### Mobile 390x844

- collapsible navigation;
- project rows become stacked but compact;
- tabs can scroll horizontally or become a controlled menu;
- no desktop two-column form forced into mobile;
- touch targets remain accessible.

## Required states

- two projects;
- one project;
- no projects;
- loading;
- partial setup;
- completed setup;
- integration error;
- documents empty;
- documents loaded;
- agent offline;
- agent connected;
- read-only permissions.

## Hard acceptance criteria

1. Two current projects are fully visible at 1440x900 without scrolling.
2. Only one primary CTA exists on the portfolio screen.
3. Projects are compact rows, not expanded settings forms.
4. Within three seconds, a user can identify:
   - which project needs attention;
   - what remains unconfigured;
   - the next action.
5. No nested bordered-card structure deeper than one meaningful surface.
6. Green is not used as a generic primary action color.
7. Delete is hidden from routine actions.
8. Documents have one obvious upload workflow.
9. Agent status is readable without opening raw technical logs.
10. All visual values use canonical tokens.
11. No duplicate Button/Tabs/Badge/EmptyState/Row implementations are
    introduced.
12. Desktop, compact desktop, and mobile screenshots are generated.
13. Functional behavior, auth, permissions, APIs, and integrations remain
    unchanged unless separately approved.
