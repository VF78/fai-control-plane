# f(AI) Control — Paperclip internal MVP

The implemented target is unchanged Paperclip Core and native GUI with one
`@vf78/fai-control` plugin. Core owns issues, runs, approvals, memberships and
costs; the plugin owns scoped setup configuration and persistent Hermes host
bindings. This checkout does not prove production cutover or product acceptance.

Start with [ADR 0007](docs/adr/0007-paperclip-core-and-extension.md),
[plugin setup](plugins/fai-control/README.md) and the
[release runbook](docs/ops/PAPERCLIP_RELEASE_RUNBOOK.md).
Use the pinned Core and plugin-local package/toolchain instructions there.
Root `dev`/`verify:mvp` commands still target the retained legacy application.

The resumable plugin wizard covers GitHub repository/ref verification, explicit
tracker/process mode, required passport/specification documents, one persistent
Hermes with device authentication/context/repository access, team roles and
optional chats, readiness and the native first-task entry. Native Paperclip
issues are the internal MVP task authority. External GitHub Project mode remains
blocked until its write connector and single-authority round trip are accepted.

Separate native `codex_local` QA and a human acceptance gate are required; one
Hermes persists across delivery roles. A green setup projection or staged chat
configuration is not evidence of useful execution, notification delivery or QA.
Unknown native usage is not zero. The runbook defines acceptance and removal.

Old Next.js/worker source and deployment remain retained until separately
approved cutover. [Legacy operations](docs/ops/PRODUCTION_RUNBOOK.md) apply only
to that deployment. Never launch both controllers for one item or delete legacy
data or modify protected marketing/MSA/VPN services.
