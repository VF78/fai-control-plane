# Phase A operator workspace

This is the local, web-first Phase A prototype contract. It authorizes neither
schema changes nor production changes.

## Information architecture

The workspace follows the familiar GitHub mental model: a global header,
project breadcrumb, contextual horizontal tabs and dense, inspectable rows.
There is no permanent product rail, dashboard-card grid, workflow canvas or
mobile bottom navigation.

```text
/prototype/dashboard
/prototype/projects
/prototype/tasks?project=all|msa|ascon
/prototype/chats?project=all|msa|ascon
/prototype/projects/:projectId/overview
/prototype/projects/:projectId/tasks
/prototype/projects/:projectId/tasks/:taskId
/prototype/projects/:projectId/protocol
/prototype/projects/:projectId/runs
/prototype/projects/:projectId/runs/:runId
/prototype/projects/:projectId/chats
/prototype/projects/:projectId/access
/prototype/agents
/prototype/agents/:agentId
```

Top level is **Dashboard · Projects · Tasks · Chats · Agents**. Within one project, the
contextual tabs are **Overview · Tasks · Protocol · Runs · Chats · Access**.
This retains the five product areas: Portfolio (Dashboard/Projects), Delivery
(Overview/Protocol/Tasks/Runs), Conversations (Chats), People & Access
(Access), and Agents & Systems (Agents). Global Tasks and Chats accept
`project=all|msa|ascon`; an absent project filter normalizes to `all`, while an
explicit invalid filter fails closed. Their selected project is visible in the
scope row. Project is fixed in project URLs, while environment/time query
values are restorable. Invalid IDs fail closed.

## Interaction model

The golden flow is visible as a linked, governed path:

```text
Dashboard signal → project/task → delivery stage → responsible human/agent
→ policy/approval → action/run → receipt/evidence → next action
```

Tasks use a dense list, then a main-detail/metadata-rail page on desktop and
tablet. On mobile the detail is a separate route and its details follow the
main content. Runs use the same pattern, with an Actions-like receipt timeline.
At 1440, 1024, 390 and 320 pixels the shell stays within the page width; tabs
and filters scroll locally when needed. Controls have visible focus and a
minimum 44px mobile target.

## Architecture and future portability

Next.js/React, semantic HTML, scoped CSS and `lucide-react` remain the only UI
stack. Phase A deliberately does **not** add React Native Web, Expo, a native
application or a shared component runtime.

`packages/operator-contracts` holds serializable screen, command and receipt
references. `packages/operator-tokens` holds small framework-neutral visual
tokens. The web layer maps these concepts to URLs, DOM and CSS. A later native
client can reuse the contracts, state vocabulary and data view models without
forcing a second rendering stack into this prototype.

## Confirmed data and explicit gaps

Used only when present in PostgreSQL: configured projects, synchronization
observations, risk signals, canonical task status/title/summary/owner, exact
governed handoffs, run/approval/receipt observations, actor records and
configured agent profiles. Compact `Unknown`, `Not observed` and `Not
configured` states appear where no canonical fact exists.

The prototype does not invent deadlines, message traffic, effective grants,
protocol stages/ownership, agent liveness, health scores, forecasts or next
actions. Chats and protocol remain compact honest states until their canonical
records exist.
