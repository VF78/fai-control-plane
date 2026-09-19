# ADR 0007: Paperclip Core with one f(AI) extension

- Status: Accepted target; not a production cutover
- Date: 2026-09-15
- Issue: #399
- Replaces on cutover: the product direction in ADR 0006; ADR 0006 remains the
  historical record of the deployed Control Plane until then.

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
migration, the spike must prove a real independent QA path with one persistent
Hermes and independent Codex QA. Do not disguise self-review with names, create
a second Hermes by role, or build a plugin QA state machine. If native separate
QA execution identity or a change in CLI-orchestration ownership is required,
present one concrete option and tradeoff for approval before implementing it.

The spike also pins a compatible core/plugin pair and verifies native document
upload/reference for DOCX without a base64 workaround; plugin custom routes are
JSON-only. It verifies a useful task, human gate, controlled recovery and that
no duplicate launch occurs. Architecture approval does not itself authorize a
production change, merge, deploy or silent reassignment of CLI ownership.

## Consequences

Migrate in proven slices and remove old GUI/API/controller/persistence paths
only after their equivalent works. Do not delete mixed runtime/data code merely
by name. The existing deployment remains unchanged until an explicitly approved
cutover; protected neighbouring services and credentials are out of scope.
Live sequencing, status and acceptance remain in epic #399 and its child
issues, not this ADR.

## Implementation boundary

The internal slice implements the wizard and one persistent Hermes binding,
with native `codex_local` as the separate QA identity and native human approval.
This records the implemented design, not successful live QA or PO acceptance.
Internal issues are explicitly selected; external Project mode cannot be called
ready until its write connector is accepted. Optional chat configuration does
not prove transport, notification or client authorization behavior.

README and release operations describe this target while the legacy deployment
remains protected. No legacy data migration or public activation follows from
this ADR. The release runbook defines the deferred removal boundary.
