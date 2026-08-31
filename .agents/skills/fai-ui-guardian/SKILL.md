---
name: fai-ui-guardian
description: Use for every frontend, UI, UX, CSS, layout, navigation, dashboard, form, component, responsive, visualization, or visual-regression task in f(AI) Control. Enforces the approved design system, reference mapping, component reuse, minimal scope, and screenshot-based verification. Do not use for backend-only tasks.
---

# f(AI) Control UI Guardian

## Objective

Keep every frontend change consistent with the approved f(AI) Control
UI system and prevent local screen changes from creating design drift.

## Required inputs

Read:

- `docs/UI_CONTRACT.md` and the canonical primitives in `apps/web/src/ui`;
- `docs/design/UI_SYSTEM_MASTER.md`
- `docs/design/REFERENCE_MAP.md`
- `docs/design/VISUAL_ACCEPTANCE.md`
- the target screen specification;
- approved local reference screenshots;
- current canonical tokens and components.

GitHub Dashboard, GitHub Project and repository Settings are the approved
primary grammar for the current product. Use approved Linear, Vercel and
LangSmith references only for the additional surfaces assigned to them in the
reference map; never replace the GitHub task-board grammar or introduce a
second component/token system.

## Required workflow

### 1. Orient

Identify:

- user goal;
- primary action;
- information hierarchy;
- all required states;
- current data flow and behavior;
- existing canonical components;
- reference screens governing this surface.

### 2. Plan

Before coding, write:

- visual thesis;
- information hierarchy;
- interaction thesis;
- component reuse and retirement plan;
- exact scope boundaries;
- visual verification plan.

For design-system, app-shell, navigation, or multi-screen work:
stop after audit/plan until the explicit human approval gate is received.

### 3. Implement

- Reuse canonical primitives and tokens.
- Make the smallest coherent change.
- Preserve all product behavior outside the explicit scope.
- Do not introduce a new UI dependency without approval.
- Do not add a second implementation of an existing primitive.
- Do not fix unrelated visual issues opportunistically.
- Keep all visible product copy in Russian.

### 4. Verify

- Run the app in a real browser.
- Capture before and after states.
- Compare to approved local reference screenshots.
- Verify required viewports and states.
- Run functional, visual, and accessibility checks.
- Inspect actual, expected, and diff images.

## Failure conditions

The task is incomplete if:

- build/lint passed but UI was not inspected;
- screenshots were not generated;
- browser tooling failed and no deterministic fallback was used;
- local approved reference screenshots do not exist;
- a parallel component/token system was introduced;
- unrelated screens changed;
- visual baselines were silently updated;
- visible behavior changed without being requested;
- the result violates the approved reference map.

## Final response

Report:

- what changed;
- what stayed unchanged;
- components reused;
- components added and why;
- components retired;
- checks run and results;
- before/after/diff artifact paths;
- any deviation from the approved reference and its reason.
