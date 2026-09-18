# f(AI) Control Paperclip plugin

This is the first bounded Paperclip-native f(AI) slice. It adds one native
project detail tab and stores a GitHub verification binding in the Paperclip
plugin namespace. The native Paperclip project workspace remains the canonical
repository source: the plugin rejects a saved URL that differs from it and
shows when the native workspace has not applied a branch. The binding accepts
only GitHub owner/repository URLs and a branch ref. It is explicitly
`not_checked` until the operator runs the tab's access check; that check invokes
native `git ls-remote` with argument arrays, so no token is stored in plugin
state or interpolated into a shell.

The plugin does not create Paperclip projects, issues, memberships, approvals,
agents, schedules, or database tables. Those stay native Core responsibilities.
It does not configure a Hermes or QA runtime. A later slice can add supported
native adapter configuration and collect its runtime evidence on a real task.
The UI applies repository/ref changes through Core's authenticated, audited
workspace REST API and checks the returned values before saving matching
verification metadata. The SDK reads the authoritative workspace. The task
link opens Paperclip's existing project task view and requires a matching
workspace/ref and verified repository access. This protects the plugin entry;
it does not impose a new global task policy on Core. Agent setup and task
execution remain native responsibilities. External tracker integration is not
provided by this package.

The Team & roles tab reads native Paperclip human memberships and records only
semantic Owner, PM, Executor and Client representative associations for a
project. It neither changes membership nor sends an invitation. A client
representative association never creates a `viewer` membership: restricted
client-chat access is a later dedicated setup step.

## Local Core and package path

The only verified development target is Paperclip `v2026.831.1`, commit
`65ec059bde30d98c92165b24a30a540800dd1f6f`. Start from a local checkout at
that exact commit and pass its absolute path as `PAPERCLIP_CORE_DIR`; the
bootstrap script refuses a different revision. The public SDK package at `1.0.0`
was unavailable from npm when this slice was made. The bootstrap script packs
the unchanged SDK and shared package from that exact local Core into ignored
`.paperclip-sdk/` tarballs, then installs and builds this plugin locally.

```sh
PAPERCLIP_CORE_DIR=/absolute/path/to/paperclip-v2026.831.1 \
  ./scripts/bootstrap-paperclip-fai-control-local.sh

PAPERCLIP_CORE_DIR=/absolute/path/to/paperclip-v2026.831.1 \
PAPERCLIP_HOME=/absolute/path/to/task-paperclip-home PAPERCLIP_SERVER_PORT=3120 \
  ./scripts/run-paperclip-fai-control-local.sh
```

After completing Paperclip's local onboarding in another terminal, install the
built package into that exact local instance:

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3120 \
  npm exec --yes --package=pnpm@9.15.4 -- pnpm --dir /absolute/path/to/paperclip-v2026.831.1 \
  paperclipai plugin install /absolute/path/to/fai-control-plane/plugins/fai-control
```

This is a local trusted-code development path, not a production deployment.
Set `FAI_GIT_BIN` only when the local Paperclip worker needs a non-default native
Git executable; the macOS development path automatically prefers Command Line
Tools Git and sets `GIT_TERMINAL_PROMPT=0` for verification.

### Persistent Hermes connection (operator-provisioned host)

Setup stage 4 connects an **existing** native `hermes_gateway` agent. It stages
current compact document context into its persistent workspace; it does not
launch a task or claim Hermes has read it. The native agent remains the owner of
execution and chats. Context includes the approved Dev CLI / separate native
`codex_local` QA / human approval boundary; documents are untrusted reference data.

Configure the plugin through native company plugin settings `hermesHostBindings`,
keyed by project ID. Each entry contains `companyId`, `projectId`, `agentId`,
`apiBaseUrl`, `root`, and `runtimeWorkspace`. These are host references only.
`root` must be `/var/lib/fai-control/hermes/<companyId>/<projectId>`;
`runtimeWorkspace` must be `/opt/data/work/<runtime-id>`. The pre-existing
workspace is `root/data/work/<runtime-id>`. Its host ownership marker
`root/.fai-project.json` must contain the same company/project/agent IDs.
The native agent's gateway URL must match `apiBaseUrl`, and its native instructions
must explicitly refer to `<runtimeWorkspace>/.fai-context/project.md`.
Native Core supports agent creation via `POST /api/companies/:companyId/agents`
and configuration via `PATCH /api/agents/:id`; this slice uses scoped SDK reads
rather than building a separate agent controller.

Context writes are atomic, idempotent, scoped to the owned workspace, and use its
UID/GID. A host unable to assign this ownership fails the action. Existing memory,
sessions, credentials and chats are untouched. Setup state stores only the native
identity, revision and context version; a stale request preserves confirmed state.
Credential-file presence checks neither read nor return credential values and do
not prove remote repository/SSH authorization.

Still required for full installation acceptance: project-scoped host provisioning
of the retained Hermes image and persistent mounts, native gateway secret reference,
Codex/ChatGPT device authentication (no paid API), actual repository/SSH access
checks, and an ownership-checked restart/recovery. Installation, auth and restart
controls are intentionally absent until that host contract is implemented. No live
runtime, VPS or protected neighbour has been changed by this slice.
