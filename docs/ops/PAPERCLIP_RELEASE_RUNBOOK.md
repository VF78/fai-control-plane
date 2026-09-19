# Paperclip native pilot release

This is a first-install preparation path, not deployment authorization. Invoke
only `scripts/deploy-prod.sh` with `FCP_PAPERCLIP_RELEASE=1`. Its legacy mode
remains separate. Do not run the legacy compose stack for this target.

## Approved boundary

- Unchanged upstream Core `65ec059bde30d98c92165b24a30a540800dd1f6f` and native GUI;
  one local `@vf78/fai-control` plugin from the exact approved release commit.
- Native systemd `paperclip.service`, service account UID/GID 10000, supplementary
  Docker group 110 (host socket 0:110 mode660). Docker access grants host-level
  capability; only trusted plugin code runs here. No root Core or core patch.
- Private bootstrap: authenticated Core binds loopback13110, explicit auth URL
  `http://127.0.0.1:13110`, signup enabled only while establishing initial owner.
  Reach it via an SSH tunnel; the existing Nginx13010 route cannot reach it.
- Separate activation: Core moves to loopback13010, explicit public/auth URL
  `https://app.f-ai.studio`, signup disabled. Existing Nginx route is reused;
  no Nginx edit is part of these scripts.
- Own Postgres17 container `fai-paperclip-postgres`, compose project
  `fai-paperclip`, loopback15432 and `/var/lib/paperclip/postgres`. Pin approved
  minor version and digest. Never use protected/shared Postgres5432. Public
  authenticated upstream Core rejects embedded Postgres, so it is not a fallback.
- App files/secrets: `/var/lib/paperclip`, `/etc/fai-paperclip`; project Hermes
  roots `/var/lib/fai-control/hermes`. Existing retained project credentials,
  Codex homes and old runtime roots are not migrated, overwritten or deleted.
- Protect `hermes-gateway.service` (MSA), marketing/content services and
  `amnezia-awg2` VPN. No OS package/global Node/pnpm upgrades, prune, host-wide
  cleanup, backup creation, secret display or legacy data deletion.

## Prepare exact Linux artifacts (separate approval before VPS writes)

The VPS has Node22 and a broken global pnpm launcher. Neither is suitable. Prepare
an isolated release tree `/opt/fai-paperclip/releases/<plugin-40hex>/` containing
`control/` (clean exact plugin commit), `core/` (clean pinned upstream checkout)
and `toolchain/bin/{node,npm,pnpm}`. Use official Node24.11.0 Linux x64 archive,
verify its published signed SHA256 manifest, and install pnpm9.15.4 only under this
release toolchain. Do not replace `/usr/bin`, `/usr/local/bin` or another app's tools.
Stage the digest-pinned Postgres17 image and preserve retained Hermes image
`sha256:b994d0d9fd22691b9f922ec72274e6f4c6654d55d0db79a34e517b4c5abca0dc`.
A downloaded artifact/image requires its own exact approval and disk assessment.

Build on compatible Linux with the isolated toolchain first in PATH. Use the
existing local bootstrap script to pack the exact upstream shared/SDK packages
and build the plugin. Build upstream GUI, SDK and server as in its Dockerfile:

```sh
export PATH="$release/toolchain/bin:/usr/bin:/bin"
PAPERCLIP_CORE_DIR="$release/core" "$release/control/scripts/bootstrap-paperclip-fai-control-local.sh"
pnpm --dir "$release/core" --filter @paperclipai/ui build
pnpm --dir "$release/core" --filter @paperclipai/plugin-sdk build
pnpm --dir "$release/core" --filter @paperclipai/server build
```

`$release` is the exact release root defined above. Server build includes its
upstream runner/vendor build; do not bypass failures or install Rust/OS packages
on the VPS without separate approval. Prefer preparing Linux artifacts away from
production. macOS-generated native dependencies are not a Linux release. Record
relative SHA256 entries for the full toolchain, Core runtime dependency/build
files, GUI and plugin `dist` plus plugin dependencies in `artifacts.sha256`.
Preflight verifies this manifest; include its hash in approval. Do not include
credentials in artifacts. Preserve enough disk for build/staging and DB growth:
known free disk is only6.2GiB; the script requires2GiB free after staging. Do not
claim this is a proven long-term capacity budget or solve it by pruning neighbours.

Prepare root:root0600 `/etc/fai-paperclip/{bootstrap.env,production.env,release.env}`
and `secrets/postgres-password` from the examples. Generate 32-byte random hex
session/JWT secrets and a >=32-character URL-safe DB password into host-owned
files, without output. Bootstrap/public secrets and database identity must match.
`release.env` contains only `FCP_POSTGRES_IMAGE=postgres:17.<minor>@sha256:<digest>`.
Do not commit populated env files. No backup is created: Core backup is explicitly
false. Persistent database/files remain on the host; no removal command is given.

## Read-only preflight and private install

From the prepared control checkout on the approved host:

```sh
FCP_PAPERCLIP_RELEASE=1 scripts/deploy-prod.sh preflight "$commit"
```

Preflight checks exact clean commits, isolated versions/build artifacts, checksums,
image identity, service UID/socket contract, protected-service health, free ports,
configuration invariants and disk headroom. It prints only commit/Core/configuration
hashes. It does not fetch, build, pull, create accounts/directories or start services.
Any missing staged input is a blocker, not permission to provision it.

After Vladimir approves this exact commit, digest and new resource boundary:

```sh
FCP_PAPERCLIP_RELEASE=1 FCP_APPROVED_RELEASE_COMMIT="$commit" \
FCP_APPROVED_CONFIG_SHA256="$digest" \
FCP_APPROVED_PAPERCLIP_RUNTIME=native-uid10000-docker-postgres17 \
  scripts/deploy-prod.sh deploy "$commit"
```

This first-install-only command creates the dedicated UID and new app roots,
starts only its Postgres container and native service on13110. It refuses existing
app roots/current link/unit, foreign UID, occupied ports and missing exact approval.
Partial failure leaves scoped resources for inspection; do not delete them or
retry by removing data. Inspect only this service/container. No automatic rollback
or protected-neighbour mutation is authorized.

## Private native bootstrap and single-plugin setup

Tunnel from the operator computer: `ssh -L 13110:127.0.0.1:13110 root@46.225.163.123`.
Open `http://127.0.0.1:13110`. Run the upstream native CLI as the service identity in a transient unit; its
private environment is loaded by systemd without printing or sourcing secrets:

```sh
systemd-run --quiet --wait --pipe --collect --uid=10000 --gid=10000 \
  --working-directory="$release/core" \
  --property=EnvironmentFile=/etc/fai-paperclip/bootstrap.env \
  --setenv=HOME=/var/lib/paperclip \
  --setenv=PATH="$release/toolchain/bin:/usr/bin:/bin" \
  "$release/toolchain/bin/node" cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts \
  auth bootstrap-ceo --config /var/lib/paperclip/instances/default/config.json \
  --base-url http://127.0.0.1:13110 --expires-hours 1
```

The CLI generates a
one-time invitation; view it only in the private operator terminal. Never attach
its token/code to logs, Project or artifacts. Register the initial owner and accept
the native invitation. This is why signup is temporarily enabled privately; source
`InviteLanding.tsx` calls native `signUpEmail` for a new bootstrap user.

Use the authenticated native GUI plugin manager to install the built local plugin
path. Avoid an unauthenticated development CLI call. Verify there is exactly one
installed/enabled f(AI) plugin and native host UI renders its setup tabs. No direct
SQL or hidden business-record preparation is permitted. Configure native task/QA
workspaces inside dedicated service-owned `/var/lib/paperclip/workspaces/` paths,
not the read-only release tree or protected neighbour directories.

Before public activation prove actual device auth, authenticated gateway readiness,
approved context delivery and repo/SSH access in an exact disposable project,
restart persistence and one useful native task. A running container/file presence
is insufficient. Gateway image supervises services with s6; Docker Init is false,
UID/GID mapping10000 and bootstrap-running flag are required. `sleep infinity`
is the image's foreground command while supervised gateway services run. Saved
stopped state is respected; no forced reboot/recreate is implemented.

QA uses the agreed Hermes Dev CLI and a separate native `codex_local` QA identity
with the human acceptance gate. Do not create a second Hermes by role, add an LLM
spike, call #403 accepted based only on mocked tests, or claim full #406 acceptance.
Keep acceptance evidence in the live issue/Project, with exact commits and no secrets.

## Separately approved public activation

Approve the exact final public env/configuration digest and acceptance result.
Activation checks the same pins/artifact manifest, existing private service and
release pointer, and that public13010 is free. It replaces only the app's active
configuration and restarts its own service:

```sh
FCP_PAPERCLIP_RELEASE=1 FCP_APPROVED_RELEASE_COMMIT="$commit" \
FCP_APPROVED_CONFIG_SHA256="$digest" \
FCP_APPROVED_PAPERCLIP_RUNTIME=native-uid10000-docker-postgres17 \
FCP_APPROVED_PAPERCLIP_ACTIVATION=accepted-native-auth-plugin-hermes-qa \
  scripts/deploy-prod.sh activate "$commit"
```

Verify native unauthenticated API denial, signup denial, owner login, plugin setup,
Core health commit, and protected-service health via scoped checks. Inspect the
existing public HTTPS route without editing Nginx. The upstream must receive
exactly one Host and X-Forwarded-Proto header. Do not combine `proxy_params`
(which already sets forwarded headers on the VPS) with duplicate explicit
headers: an `https, https` value breaks native authentication. Do not redeploy
the legacy Nginx template over the reviewed public route. A later update,
rollback, data migration or removal needs its own reviewed resource/diff/approval
slice; the first-install command is not an in-place upgrade command.

## Internal MVP acceptance preflight (required operator evidence)

Host preflight above checks infrastructure only. Before declaring an internal MVP
usable, record these checks against the exact plugin commit, Core pin and printed
configuration digest in the release issue. An unchecked gate is a blocker, not a
waiver or a successful setup projection. Reuse evidence only for unchanged inputs.

| Gate | Required native/readback evidence |
| --- | --- |
| Owner/auth/plugin | Native owner login, unauthenticated denial, one enabled plugin, clean-project GUI setup |
| GitHub | Native workspace repository/ref and actual private repository access from Hermes; no credentials in evidence |
| Tracker/process | Explicit internal Paperclip mode, native issue ID, configured process; external mode remains blocked pending accepted write connector |
| Documents/context | Required passport/specification, native document IDs and revisions, compact context version and actual Hermes use |
| One persistent Hermes | Company/project/agent IDs, device login, authenticated gateway, same workspace/session identity after one controlled recovery; no duplicate run |
| Team | Native member IDs with explicit Owner/PM/Executor associations; deferred optional roles shown accurately |
| Chats | Explicitly deferred optional contours, or approved exact binding and live delivery evidence; saved config is not delivery |
| Useful task | One native issue/run, useful PR/result, separate native QA agent/run and human acceptance reference |
| Safety | Legacy controller has no ownership of that item; protected services healthy before/after; DevOps writes separately approved |
| Usage | Available native usage/cost and explicit unknowns; nested account analysis is not an MVP gate |

Internal-only acceptance may defer chats explicitly. It cannot satisfy #406's
full Telegram assignment/notification or external tracker replacement gates.
QA provider quota exhaustion blocks real QA until reset and a successful native
QA result; mocked success cannot waive it. Chat IDs and live transport remain
unaccepted until tested on the approved contour. No public activation is implied.
Public activation requires the same exact release evidence plus Vladimir's
acceptance and its separate digest approval. Never stop an old production
controller as an implicit part of this first-install script.

## Native identity mapping and data boundary

Maintain a minimal private release mapping: source configuration reference →
native company/project ID; repository URL/ref → native workspace ID; document
reference/version → native document ID/context hash; person → native membership
ID/semantic role; project runtime reference → native Hermes agent ID/owned host
root; QA identity → separate native agent ID; optional chat binding reference →
project contour. Include only approved references/IDs and versions, never tokens,
private keys, OAuth data, raw documents, message history or old task/run history.
Credential files remain host-owned and are reauthorized for the exact native
runtime; no blind legacy database import. Internal issues are newly native;
external issue linkage must wait for the connector's authoritative mapping.

## Deferred source removal proposal — no deletion in this slice

After exact acceptance and separate cutover approval, prepare a reviewed deletion
diff limited to these replaced source paths:

- `apps/web/` and `apps/worker/`: legacy shell/pages/API and second controller.
- `packages/application/`, `packages/domain/`, `packages/db/`: legacy orchestration,
  receipts/scheduler/business storage and their own fixtures/tests, after checking
  no retained connector/policy imports them.
- `infra/compose/`, `infra/production/`, root `compose.yaml` (if tracked): only
  legacy application deployment wiring after rollback retention is decided.
- `scripts/verify-mvp.sh`: legacy verification entry after root script rewiring.

This is a path-scoped proposal, not a recursive removal command or accepted
file-level deletion diff. Generate that diff from the exact accepted release
and review retained imports first. Root package/workspace/lock/lint/test config
needs surgical dependency rewiring, never wholesale deletion. Retain
`packages/integrations/` pending connector extraction review; retain all of
`infra/hermes-project/` (plugin build copies client connector assets),
`plugins/fai-control/`, `infra/paperclip/`, Paperclip bootstrap/run/release scripts,
policy/skill files and historical acceptance evidence. Keep `deploy-prod.sh`
as the approved entry; remove its legacy branch only in the accepted cutover
slice. No compatibility facade or parallel production controller is added.

Host legacy data, runtime roots, credentials, service units and retained releases
are excluded from this source proposal. Marketing, MSA, ASCON and VPN are
excluded entirely. Rollback/data retention and freeing an occupied13010 require
an explicit separate plan; the current script fails closed instead of stopping
another service. PR #407 remains a separate documentation integration input:
this slice uses its ADR/AGENTS/context baseline with implementation notes, and
must be reconciled once at integration rather than overwriting its changes.
