# AI context

f(AI) Control runs on self-hosted Paperclip Core, its native GUI, and one
`fai-control` extension. ADR 0007 is the architecture contract. ADR 0006 and
retained legacy source are historical, not a second active controller.
Public entry: https://app.f-ai.studio.

Read AGENTS.md, ADR 0007 and the current task. Do not load old chats or repeat
the market audit. Code, branches, PRs and releases remain in VF78/fai-control-plane.

## Ownership

One persistent isolated Hermes per project owns PM, Developer CLI orchestration,
DevOps and conversations. Core owns tasks/runs/review/approval/membership/costs.
The extension uses native APIs and slots; no duplicate controller or chat engine.
Independent QA uses a distinct project-specific native `codex_local` identity,
with project-scoped instructions/workspace context, no periodic heartbeat and
one concurrent run. Reviewer selection remains explicit on each native task;
QA may fix only deterministic lint/format defects without behavior, public-copy
or test-expectation changes. Functional defects return to Developer in one report.
With native `maxReviewRounds=2`, one correction cycle is automatic; a second
rejection escalates to the responsible human. The plugin does not set this policy.

GitHub access is provisioned once for Core using standard gh/git credentials.
Authorized projects reuse it; explicit project credentials take precedence.
Never put tokens in documents, task bodies, plugin business state or UI fields.
Client SSH/DevOps permissions must not silently inherit from another project.

## Tracker and onboarding

Native Core tasks are the intended working tracker for this product. GitHub
Project remains migration coordination until the owner manually creates the
fresh project and active work is transferred once. Record cutover and native
links in #399. Thereafter stop editing transferred GitHub task statuses: no
synchronization service or duplicate live board. External Project is deferred.

The owner creates the new project manually to evaluate the wizard. Do not
pre-create it or start the acceptance task on their behalf. Upload documents
are in docs/project/. Live findings/status remain in the active tracker.
This development project uses internal Telegram only; no client channel.
The future commercial project will configure its own restricted Element profile.

## Acceptance and operations

Manual setup → actual document/context use by Hermes → useful Dev task →
independent QA → owner acceptance → separately authorized merge/deploy →
Telegram statuses. Recovery preserves identity/context and avoids duplicate work.
File presence and running containers are not proof of access or delivery.
Use docs/ops/PAPERCLIP_RELEASE_RUNBOOK.md. Protect MSA Hermes, marketing, VPN
and other services. No isolated LLM spike: prove the cycle on the first real task.
