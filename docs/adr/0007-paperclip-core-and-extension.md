# ADR 0007: Paperclip Core with one f(AI) extension

- Status: Accepted; public cutover separately authorized and completed; live acceptance pending
- Date: 2026-09-15
- Issue: #399
- Replaces: the product direction in ADR 0006, retained as historical context.

## Context

The current Control Plane duplicates product services that Paperclip already
provides. Keeping its GUI and controller beside Paperclip would create two
task/run/approval systems and two operational truth paths. The approved target
is a self-hosted, single-node Paperclip pilot, not a SaaS-scale promise and not
a fork by default.

## Decision

Use **Paperclip Core, its native GUI, and one `fai-control` plugin**. Paperclip
is the sole owner of native task, run, approval, membership and cost services.
The plugin is a conventional extension with setup, context, persistent Hermes
runtime, chats, connectors and usage modules. It uses supported SDK/API,
namespace state and UI slots; it neither writes core tables directly nor adds a
second controller, scheduler, task state machine, generic provider registry,
or façade duplicating Paperclip.

GitHub repository support is mandatory from the first pilot: private repository,
native `git`/`gh` credentials, branches, PRs and result links. A first limited
pilot may use native Paperclip issues. GitHub Project remains a planned external
tracker connector and requires a separate validated slice before any claim of
full functional replacement. External mode has one owner of business fields and
a linked native execution issue, never two editable status truths. GitLab and other
repositories remain future separate adapters.

Keep all four external boundaries provider-neutral: repository and tracker
connectors, messenger bindings, and native Paperclip agent adapters (Hermes now,
another agent later). Provider identifiers/configuration stay at these edges;
do not add a generic abstraction over the entire Paperclip engine.

Each project has one persistent isolated Hermes: its workspace, memory,
sessions, OAuth and credentials survive setup updates and restarts. Hermes owns
internal Telegram plus restricted client Telegram or Matrix/Element chats. The
plugin configures and displays their state only; it must not add another bot,
poller, history store or chat engine. Client conversations may answer, clarify
and report bugs but cannot access internal context/tools, deployment or
approvals. Codex/Claude CLI remain project-policy executors, not role-specific
replacement Hermes instances.

The setup is one resumable wizard: project/repository; tracker/process;
documents; project agent, context and accesses; team/chats; verification; first
task. Dependency order may change and optional steps may be deferred/reopened
through the same components. Passport and specification are required and may be
combined. Documents are DOCX/PDF/MD/TXT with compact versioned context. If no
architecture exists, Hermes proposes it for approval; full archives are not
re-sent on each task.

Native Paperclip GUI and plugin-host components are the target UI. The legacy
UIFoundation/global styling contract applies only to the current deployed app;
it is not copied or imposed on Paperclip. All visible changes still require
explicit visual approval.

## Open native gates

Paperclip v2026.831.1 skips self-review by the same agent identity. Before
operational acceptance, the first real task must prove an independent QA path with one persistent
Hermes and independent Codex QA. Do not disguise self-review with names, create
a second Hermes by role, or build a plugin QA state machine. If native separate
QA execution identity or a change in CLI-orchestration ownership is required,
present one concrete option and tradeoff for approval before implementing it.

Pin a compatible core/plugin pair and verify native document
upload/reference for DOCX without a base64 workaround; plugin custom routes are
JSON-only. Acceptance covers a useful task, human gate, controlled recovery and
no duplicate launch. The owner explicitly excluded a separate LLM spike. Architecture approval does not itself authorize a
production change, merge, deploy or silent reassignment of CLI ownership.

## Consequences

Migrate in proven slices and remove old GUI/API/controller/persistence paths
only after their equivalent works. Do not delete mixed runtime/data code merely
by name. The public cutover was separately approved and completed; protected
neighbouring services and credentials remain out of scope.
Live sequencing, status and acceptance remain in epic #399 and its child
issues, not this ADR.

## Implementation boundary

The internal slice implements the wizard and one persistent Hermes binding,
with native `codex_local` as the separate QA identity and native human approval.
This records the implemented design, not successful live QA or PO acceptance.
Internal issues are explicitly selected; external Project mode cannot be called
ready until its write connector is accepted. Optional chat configuration does
not prove transport, notification or client authorization behavior.

README and release operations describe this target. Cleanup is limited to
replaced f(AI) runtime/code; the owner authorized its removal without backups.
A release still requires its own approval and scoped production verification.

## Operational clarification — 2026-09-19

The owner separately authorized the public cutover and old-runtime cleanup.
Earlier wording about an unchanged legacy deployment records the decision-time
boundary; it is not the current operational architecture. New releases still
require their own exact authorization. The owner rejected an isolated LLM spike;
QA/document/recovery gates are to be proved on the first useful real task.

GitHub credentials are configured centrally at the Core host for reuse by
authorized projects. Do not require repeated entry per Hermes, expose tokens in
plugin state, or automatically propagate unrelated client SSH/DevOps access.
For the development project, internal Telegram is required and client chat is
not applicable. Element is for the subsequent commercial project.

Native tasks are the selected simple tracker direction. Move active work once
after owner-led project creation and record the authority cutover in #399.
Until then GitHub Project tracks migration; afterwards transferred work has
only native editable status. External Project sync is deferred.

Each project has its own `codex_local` QA identity with project-scoped native
instructions, no heartbeat and one concurrent run. It stays distinct from that
project's Hermes, which keeps PM, Dev CLI orchestration, DevOps and chats.
Hermes/Developer and QA share only that project's isolated Codex login; every
project performs its own device authentication. No company-global Codex login
is seeded or copied between projects.
Reviewer selection and human approval remain explicit native task actions; the
plugin does not invent default review policy. QA may correct only deterministic
lint/format defects with no behavior, public-copy or test-expectation change;
functional defects return to Developer in one consolidated report. Native
`maxReviewRounds=2` permits one automatic correction cycle, then escalates a
second rejection to the responsible human. Code audit and live acceptance
status stay in the Project.
