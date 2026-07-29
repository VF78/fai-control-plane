# Phase A operator workspace

This document records the prototype contract for the unified operator
workspace. It is a design and data inventory, not production authorization.

## Route and information architecture

The local prototype is available at
`http://127.0.0.1:4017/prototype/portfolio`.

```text
/prototype/portfolio
/prototype/delivery/overview
/prototype/delivery/protocol
/prototype/delivery/tasks/:taskId
/prototype/delivery/runs/:runId
/prototype/conversations
/prototype/people-access/:actorId
/prototype/agents-systems
```

Project, environment and time remain one explicit scope contract and are
preserved in links. A detail ID that is absent or unknown fails closed instead
of selecting another record.

The five product areas contain six functions:

- Portfolio: project signals and the Attention Queue.
- Delivery: Overview, Protocol, Tasks and Runs; task control stays here.
- Conversations: internal and client channels.
- People & Access: people, agents, roles and effective access.
- Agents & Systems: fleet, instructions, integrations, recovery and audit.

## Navigation and interaction model

- Desktop uses a labelled product rail; tablet uses accessible icon navigation;
  mobile keeps Portfolio, Delivery and Conversations primary and places People
  & Access and Agents & Systems under More.
- Portfolio is the only all-project surface. Entering Delivery fixes one
  project scope.
- Desktop and tablet use master-detail. Mobile task, actor and run details are
  full-width route states.
- Overview is visual-summary-first. Tasks owns task master-detail. Runs owns
  run, decision, receipt and evidence detail.
- Missing facts use `Unknown`, `Not configured` or `Not observed`; an invalid
  entity ID never falls back to the first entity.

The governed journey is:

```text
Portfolio signal or configured project
→ project/task
→ task stage
→ assigned responsibility or explicit Unknown
→ policy/approval
→ exact associated run
→ receipt/evidence
→ canonical next action or explicit Unknown
```

An observed execution agent is shown separately from task responsibility. A
run actor is not presented as an assigned owner unless PostgreSQL records that
assignment.

## Visual system

- Neutral canvas, one rule/elevation grammar, compact typography and semantic
  color only for state.
- Lucide icons with accessible names; icons complement rather than replace
  meaning.
- Stage and governed-flow rails, fact strips and receipt timelines replace
  explanatory dashboard cards.
- No nested cards, gradients, workflow canvas or decorative metrics.
- Reduced-motion, visible-focus and touch-target rules are included.

The portable product contract is the TypeScript read model, route/scope state,
semantic status vocabulary, icon vocabulary and interaction sequence. Next.js
links and CSS are web adapters; a future native client should reuse the
contract, not the DOM component implementation. Phase A does not add a second
Expo or React Native client.

## Confirmed PostgreSQL-backed data used

- Configured projects, synchronization observation, project health projection,
  unresolved risk counts and persisted Attention Queue signals.
- Work-item ID, title, summary, canonical status, blocker state, owner when
  recorded, provider observation link and persisted handoff target.
- Exact run ID, work-item ID, observed run agent, runtime profile, attempt,
  lifecycle timestamps and failure code.
- Approval request ID, policy version, decision state, action category,
  surface, environment and decision time when recorded.
- Receipt timestamp, terminal outcome, SHA-256, duration, artifacts, redaction
  observation and receipt-acceptance eligibility.
- Actor identity/type/role/capabilities/disabled state and Hermes profile
  configuration.
- Integration provider/mode and observation timestamp. These observations are
  not labelled as integration health.

## Facts intentionally absent

- Configured environment and time-window dimensions.
- Editable delivery protocol, per-stage responsibility and protocol exceptions.
- Conversation threads, participants, messages and binding health.
- Project membership and effective-access derivation.
- Task responsibility when no owner or assignment is recorded.
- Agent fleet health and runtime liveness.
- Approval or policy facts not associated with the selected run.
- A next action not established by canonical receipt eligibility or policy.

## Local visual evidence

- `/private/tmp/fcp-phase-a-screenshots/portfolio-desktop-1440x1000.png`
- `/private/tmp/fcp-phase-a-screenshots/delivery-task-tablet-1024x1366.png`
- `/private/tmp/fcp-phase-a-screenshots/run-receipt-mobile-390x844.png`

The local database currently has no unresolved Portfolio signals, so the
verified journey starts from a configured project and continues through an
exact task, associated run and receipt.
