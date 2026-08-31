# f(AI) Control — Approved Reference Map

Status: UI Foundation references approved by the Product Owner on 2026-08-31.
This approval governs implementation; it is not approval of a rendered product
screen or permission to update visual baselines.

Capture date: 2026-08-31.

## Reference hierarchy

1. GitHub Dashboard, GitHub Projects and repository Settings are the primary
   grammar for shell density, task board, settings rows, controls and
   progressive disclosure.
2. Linear extends that grammar only for portfolio scanning, project detail and
   delivery-health visualization.
3. Vercel extends it only for operational filters, integration state and
   sensitive-action confirmation.
4. LangSmith extends it only for agent metrics and run inspection.

No source authorizes copying branding, exact icons, product-specific labels,
provider identifiers or a second visual language.

## Approved mapping

| Local reference | Official source | Visible state | f(AI) Control surface | Borrow | Do not copy |
| --- | --- | --- | --- | --- | --- |
| `references/approved/github/project-board-desktop.png` | [GitHub Project](https://github.com/users/VF78/projects/1/views/1) | Populated board | `Задачи` | Board density, column rhythm, compact issue metadata and unobtrusive controls | GitHub branding, repository-only navigation, raw Project item identifiers |
| `references/approved/github/repository-settings-desktop.png` | [GitHub repository Settings](https://github.com/VF78/fai-control-plane/settings) | General settings, desktop | Shell and all settings/detail surfaces | Restrained content width, section navigation, row/divider hierarchy, clear labels and progressive disclosure | GitHub product navigation, exact icons and repository-specific options |
| `references/approved/github/repository-settings-mobile.png` | [GitHub repository Settings](https://github.com/VF78/fai-control-plane/settings) | General settings, mobile | Responsive shell and settings/detail surfaces | Compact navigation, readable single-column rows and touch-safe controls | GitHub mobile chrome and provider-specific labels |
| `references/approved/linear/initiatives.png` | [Linear initiatives](https://linear.app/docs/initiatives) | Portfolio roll-up | `Проекты` and multi-project `Обзор` | Compact project rows, health scanning, restrained semantic status and hierarchy | Dark theme, exact tree/icons, initiative terminology and tiny metadata |
| `references/approved/linear/project-overview.png` | [Linear project overview](https://linear.app/docs/project-overview) | Populated project detail | Project `Обзор`, `Контекст`, `Агент`, `Доступ` | Strong project header, compact properties/resources, tabs and meaningful grouping without nested cards | Linear branding, exact assets, issue-tracker terminology and ornamental backdrop |
| `references/approved/linear/project-graph.png` | [Linear project graph](https://linear.app/docs/project-graph) | Progress chart with risk interval | Dashboard project-health graph | Scope/progress relationship, small legend, risk interval and compact KPI treatment | Exact colors, dark theme, synthetic numbers or Linear glyphs |
| `references/approved/vercel/deployments-filter.png` | [Vercel managing deployments](https://vercel.com/docs/deployments/managing-deployments) | Multi-select status filter | Runs/deployments and integration health | Compact filter, semantic status dots, selected-state clarity and contextual disclosure | Vercel deployment terminology outside DevOps, exact color/shape details |
| `references/approved/vercel/redeploy-confirmation.png` | [Vercel managing deployments](https://vercel.com/docs/deployments/managing-deployments) | Production confirmation dialog | Approval dialog and project Danger Zone | Explicit consequence, scoped target, separated confirmation action and cancel path | Literal production copy, domain names or permissive one-click destructive behavior |
| `references/approved/langsmith/dashboard.png` | [LangSmith dashboards](https://docs.langchain.com/langsmith/dashboards) | Metric definition and trace table | `Агенты и системы`, agent health and run metrics | Metrics linked to the underlying run list, filters and readable operational hierarchy | LangSmith shell, builder complexity on Product Owner screens and exact palette |
| `references/approved/langsmith/trace-logs.png` | [LangSmith manage a trace](https://docs.langchain.com/langsmith/manage-trace) | Server log inspection | Future agent-run inspector | Master/detail inspection, timestamped evidence, scoped filter and copy action | Raw logs on overview screens, LangSmith branding and infrastructure-specific noise |

## Approved primary reference by target

- Shell and settings: GitHub repository Settings desktop/mobile.
- Task board: GitHub Project board.
- Project portfolio: Linear initiatives, rendered in the established light
  GitHub grammar.
- Project detail/setup: Linear project overview, using GitHub row and control
  styling.
- Dashboard health graph: Linear project graph, using f(AI) semantic tokens.
- Operational status filters and confirmations: approved Vercel references.
- Agent health and run inspection: approved LangSmith references, never as the global
  shell.

The source candidate gallery is
`references/candidates/reference-gallery.png`.

## Missing official visuals

The official Vercel Projects and Project Settings documentation pages did not
expose a stable, readable embedded product screenshot during capture. The
official LangSmith View Traces page likewise did not expose a usable embedded
trace-detail screenshot. Their URLs remain in `REFERENCE_MANIFEST.md`, but no
replacement or invented visual has been added. A manual official screenshot is
needed only if those exact surfaces must become approved references.

## Current UI evidence

`artifacts/ui-review/before/` contains:

- the Product Owner supplied legacy problem screenshot;
- the unapproved current branch candidate at 1440×900 and 390×844 for every
  fixture route;
- additional 1280×800 captures for the Projects and Setup vertical slice.

The current branch candidate is evidence for the audit, not an approved
baseline and not the target defined by this reference map.
