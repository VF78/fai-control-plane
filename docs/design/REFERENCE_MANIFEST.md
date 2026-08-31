# Approved Reference Candidate Manifest

## Rule

Codex may use only official public pages listed here to collect candidate
visual references.

The Product Owner has separately approved the official authenticated GitHub
surfaces below as the primary current-product reference. Store their local
captures with source metadata; never store credentials or private page data
outside this repository.

It must not use random image-search results, Dribbble shots, unofficial
recreations, or authenticated private product pages as the primary
reference.

For every selected screenshot, create a record containing:

- source product;
- official source URL;
- capture date;
- visible state;
- exact f(AI) Control surface it governs;
- patterns to borrow;
- patterns/assets not to copy.

Save candidates under:

`docs/design/references/candidates/<product>/`

After human approval, copy only approved screenshots to:

`docs/design/references/approved/<product>/`

Then create:

`docs/design/REFERENCE_MAP.md`

## GitHub — primary current-product reference

- Dashboard: https://github.com/dashboard
- Repository Settings: https://github.com/VF78/fai-control-plane/settings
- GitHub Project board: https://github.com/users/VF78/projects/1/views/1

Use for the app shell, settings grammar and task board. Do not copy GitHub
branding, repository-only navigation or raw provider identifiers.

## Linear

### Candidate 1 — Project overview

URL:
https://linear.app/docs/project-overview

Capture/use for:

- project header;
- overview information hierarchy;
- project properties;
- resources/documents;
- details sidebar;
- project graph placement.

Do not copy:

- Linear logos;
- exact icons;
- issue-tracker terminology unrelated to f(AI) Control.

### Candidate 2 — Initiatives

URL:
https://linear.app/docs/initiatives

Capture/use for:

- portfolio overview;
- compact project/initiative rows;
- health status;
- active project rollups;
- quick scanning by leadership.

### Candidate 3 — Project graph

URL:
https://linear.app/docs/project-graph

Capture/use for:

- health/progress visualization;
- scope and completion trend;
- compact chart treatment.

## Vercel

### Candidate 1 — Projects overview

URL:
https://vercel.com/docs/projects

Capture/use for:

- project-first dashboard model;
- portfolio to project navigation;
- project status and operational context.

### Candidate 2 — Managing deployments

URL:
https://vercel.com/docs/deployments/managing-deployments

Capture/use for:

- runs/deployments list;
- status, filtering, and overflow actions;
- operational timeline patterns.

### Candidate 3 — Project settings

URL:
https://vercel.com/docs/project-configuration/project-settings

Capture/use for:

- project settings navigation;
- integration/configuration grouping;
- calm settings hierarchy;
- separation of routine and sensitive actions.

## LangSmith

### Candidate 1 — Dashboards

URL:
https://docs.langchain.com/langsmith/dashboards

Capture/use for:

- trace count;
- latency;
- errors;
- tokens and cost;
- tool metrics.

### Candidate 2 — View traces

URL:
https://docs.langchain.com/langsmith/view-traces

Capture/use for:

- runs table;
- side panel;
- messages/turns/details structure;
- input/output/timing/token/error inspection.

### Candidate 3 — Manage a trace

URL:
https://docs.langchain.com/langsmith/manage-trace

Capture/use for:

- trace comparison;
- logs;
- debugging actions;
- audit context.

## Reference acquisition procedure

1. Confirm internet and browser access.
2. Open each official page.
3. Locate the embedded product UI image or a public product screen.
4. Capture the relevant region at readable resolution.
5. Do not capture cookie banners, browser chrome, or irrelevant marketing
   content.
6. Save source metadata.
7. Build a candidate contact sheet or markdown gallery.
8. Present:
   - 2-3 Linear candidates;
   - 2-3 Vercel candidates;
   - 2 LangSmith candidates.
9. Recommend one primary screenshot per target surface.
10. Stop for `APPROVE_UI_FOUNDATION`.

If the product UI image cannot be captured reliably, keep the URL and
request a manual screenshot. Do not substitute a made-up design.
