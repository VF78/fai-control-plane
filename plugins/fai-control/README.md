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
