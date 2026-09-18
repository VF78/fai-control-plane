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
existing public HTTPS route without editing Nginx. A later update, rollback,
data migration or removal needs its own reviewed resource/diff/approval slice.
