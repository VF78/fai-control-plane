# ADR 0007: Vendor-neutral project conversations

- Status: Accepted
- Date: 2026-08-13
- Issues: #158, #162, #167, #168, #169, #170
- Extends: ADR 0006
- Supersedes: only the ADR 0006 decision to defer MSA and Telegram
  conversations

## Context

Each project needs two conversations:

- an internal conversation for f(AI) Studio staff, project notifications,
  natural-language task intake and clarification, and human approvals;
- a client-facing conversation for delivery notices, test/debug questions and
  automatic defect intake into the same GitHub Project.

Hermes is the current agent runtime, but neither the domain nor persistence may
depend on Hermes. OpenClaw must be able to replace it at composition time.
Codex CLI and Claude CLI are execution adapters used by the trusted runtime;
they are not task stores or conversation authorities.

Hermes `delegate_task` children cannot separate internal and client access.
They are temporary work units, inherit parent capabilities and do not survive
as durable channel handlers. Hermes also treats OS-level isolation as the
security boundary for untrusted input.

## Decision

### One deployment, two trust contours per project

One operational agent deployment is maintained per project: one image/version,
Compose project, update procedure and monitoring surface. It contains two
OS-isolated processes:

1. `trusted-main` owns project execution and the internal Telegram channel. It
   may receive the bounded `AgentRoleRequest` already defined by ADR 0006.
2. `client-edge` owns the client-facing channel. It has no repository checkout,
   shell/terminal, production credentials, unrestricted GitHub credential,
   internal history or project-status mutation capability.

Subagents may perform bounded temporary work inside `trusted-main`; they never
select a trust contour, authorize a caller or own a chat binding.

### Channel map

| Project | Internal | Client-facing |
| --- | --- | --- |
| MSA | Telegram | Matrix room, normally used through Element |
| ASCON | Telegram | Bitrix24 task chat for task `154312` |

Element is a Matrix client, not a provider in the domain model.

Use native Hermes Telegram and Matrix gateways. Do not build parallel general
Telegram or Matrix gateways in Control Plane. The ASCON Bitrix24 boundary uses
official `OnTaskCommentAdd`, `tasks.task.get`, `im.dialog.messages.get` and
`tasks.task.chat.message.send`; the public page is the human UI, not an
automation protocol. Browser polling, DOM scraping and browser-session cookies
are prohibited runtime dependencies.

### Authority and data flow

Channel providers own full conversation history. GitHub Project owns task,
assignee, date, dependency and status truth. Control Plane owns only:

- a provider/runtime-neutral transient inbound message envelope;
- authorization of a bounded conversation action by a composition-owned trust
  contour;
- source, correlation and idempotency references;
- the resulting GitHub issue/source/approval or agent-delivery evidence;
- exact external-reference human approvals.

Control Plane must not persist raw messages, transcripts, participant state or
a local chat workflow.

Allowed `client-edge` capabilities are limited to:

- read client-visible project facts;
- create one deduplicated issue intake;
- clarify an existing issue;
- attach bounded source context;
- request an exact external-reference approval.

An approval request is not an approval decision. A client-facing actor does
not acquire `APPROVE`/`REJECT` authority merely by being allowed into the
external room. Decision authority is composition-owned and every sender must
resolve to an active human project member. The fixed policy is:

- Vladimir decides plans, production/release and irreversible actions;
- Vladimir or Vitaliy may decide internal operational approvals;
- client staff may decide only exact-reference client UAT/acceptance.

No natural-language decision, room role or channel membership broadens these
rights.

Only `trusted-main` may submit an `AgentRoleRequest`. Natural-language status
answers read the GitHub provider projection; no local `/status` state machine
or WorkItem-derived report is retained.

### Runtime neutrality

Domain and application contracts contain no Telegram, Matrix, Bitrix24,
Element, Hermes, OpenClaw, Codex or Claude field. Provider identities become
opaque keyed references at concrete adapters. The trust contour is supplied by
process composition and is never accepted from a message, caller or subagent.

Replacing Hermes with OpenClaw changes process composition and runtime
adapters only. Replacing Codex CLI with Claude CLI changes the trusted execution
adapter only. Neither replacement changes GitHub authority, conversation
capabilities, approvals or persisted evidence.

## Delivery order

1. #167: land the neutral message/action/evidence contract, deny-by-default
   authorization and application dispatcher.
2. #168: add the bounded Bitrix24 adapter without route or production
   activation.
3. Add composition and narrow GitHub/source/approval capability adapters for
   the two isolated processes.
4. #169: remove the old conversation/history/share/local-status routes,
   workers, schema, UI, tests and configuration after the replacement path is
   verified.
5. Apply the dependency-closed cleanup after `0059` as separately reviewed
   migrations: `0060` removes legacy conversation/share state and `0061`
   removes the obsolete environment-access IAM contour. Any later delivery
   cleanup uses a new migration and never rewrites `0000`–`0061`. Before any
   destructive production execution, create and verify an encrypted PostgreSQL
   backup and retain it for 30 days. Preserve approval/audit evidence, export
   no duplicate chat transcripts, and revoke/delete legacy share tokens.

Runtime credentials, webhook registration, Matrix room configuration,
production deployment and host cleanup require separate explicit approvals.
Telegram and Matrix remain native runtime gateway configuration; Control Plane
must not add wrapper ingress routes for them. The generic ingress-to-process
binder exists for transports such as the bounded Bitrix24 adapter.

## Consequences

- There are two processes per project, but not two separately operated agent
  products.
- Internal execution and client input cannot share credentials or host access.
- Chat history and task truth are not duplicated in PostgreSQL.
- Useful Telegram transport-security primitives may be retained only when the
  replacement path actually uses them; legacy chat/status behavior is deleted.
- The architecture remains replaceable without a generic plugin registry,
  provider router or new orchestration database.
