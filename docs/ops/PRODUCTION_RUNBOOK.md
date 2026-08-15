# ASCON MVP production approval package

This is an inactive production procedure for issue #174. It does not authorize
deployment, callback registration, DNS, TLS, provider writes or secret access.
Vladimir must approve a release package recorded in the owning GitHub issue,
including the release commit, generated configuration digests, values still
marked `REQUIRED_*`, secret references and commands before use.

## Fixed host boundary

- SSH host: `root@46.225.163.123`.
- Public Control Plane: `https://app.f-ai.studio/`.
- New checkout: `/opt/fai-control-plane-mvp`.
- New Compose project: `fai-control-plane-mvp`.
- New web bind: `127.0.0.1:13010`; worker and PostgreSQL are not published.
- New database volume: `fai-control-plane-mvp-postgres-data`.
- Non-secret configuration: `/etc/fai-control-plane-mvp/production.env`.
- Secret directory: `/etc/fai-control-plane-mvp/secrets`, root-owned mode 0700;
  each secret file is root-owned mode 0600.

The existing rollback target stays running and unchanged: checkout
`/opt/fai-control-plane`, Compose project `fai-control-plane-production`, image
and commit `63cc41832bb216edfa5c29e270ce1394f45d9231`, upstream
`127.0.0.1:13000`, and its existing volumes. Never migrate, attach, rename,
stop or delete the old database/project. Other legacy files retained under
`infra/production/` are rollback evidence only; the MVP script references only
the new Compose file, environment template and Nginx upstream contract.

The marketing site (`myshopai-website.service`), Payload/test service
(`fai-content-platform.service`), MSA-only Hermes
(`hermes-gateway.service`, `fai-hermes-runner.service`,
`fai-codex-executor.service`) and `amnezia-awg2` are protected neighbours.
The deployment script checks only their active/running state and never reads or
changes their configuration.

## Minimal topology

The Compose file contains exactly PostgreSQL, one-shot `migrate`, one-shot
`bootstrap`, web and worker. It adds no proxy container, observability stack,
registry, backup framework, host daemon or cleanup. Web and worker run as the
image `node` user. Each application container starts a bounded root entrypoint
that copies only its mounted root-only secrets to mode-0400 container-local
files, drops all privileges to `node`, and then executes the application. Host
secret ownership and mode remain `root:root` `0600`. Their only durable
business state is the fresh PostgreSQL volume.

The application build base is pinned to the Node 24 Bookworm Slim multi-arch
digest `sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03`;
PostgreSQL 16 Bookworm is pinned to
`sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537`.
Both were resolved from their official registries on 2026-08-14.

## Exact provider bindings

### GitHub

- repository: private `VF78/ascon`, node `R_kgDOTD27Gw`, branch `main`;
- user Project #4: `PVT_kwHOBIUvJs4Bbi0Q`, URL
  `https://github.com/users/VF78/projects/4`;
- OAuth callback: `https://app.f-ai.studio/oauth/github/complete`, scope
  `read:user`; OAuth client ID is `Ov23li6xIseHRQCF38Fz`;
- webhook: `https://app.f-ai.studio/api/webhooks/github`, content type JSON,
  secret ref `/etc/fai-control-plane-mvp/secrets/github-webhook-secret`;
- subscribe only to repository `issues` and `sub_issues` events. GitHub sends
  the initial `ping`. User Project #4 cannot emit `projects_v2_item`; webhook
  deliveries are reconcile hints and the bounded full Project poll is the
  authority for Project status/date changes;
- activation tracker credential: Vladimir-approved reuse of the existing
  classic token for this internal MVP, with exact accepted scopes
  `gist, project, read:org, repo, workflow`. Secret ref:
  `/etc/fai-control-plane-mvp/secrets/github-projects-token`. This is a recorded
  exception, not a claim that the credential is read-only; runtime actions
  remain bounded by the reviewed GitHub adapters.

### Telegram

- bot `@f_AI_Control_Bot`, chat `-5540760630`;
- allowed humans: Vladimir `96211907`, Vitaliy `355724486`;
- workstation source: macOS login Keychain service
  `fai-control-plane/ascon/telegram-bot-token`, account `@f_AI_Control_Bot`;
- host ref: `/etc/fai-control-plane-mvp/secrets/telegram-bot-token`.

Never print the token. A separately approved transfer must write directly to
the mode-0600 host file.

Hermes is the only inbound Telegram poller. It routes only the approved
chat/users to the isolated `internal` profile. Control Plane retains outbound
`sendMessage` delivery only; it has no `getUpdates`, chat transcript or local
command queue. The native plugin promotes provider message identity only after
Hermes authorization and exposes five bounded actions through
`POST /api/hermes/conversation-actions`; actor, contour and authority remain
server-owned.

### Bitrix24

- portal `https://b24.ascon.spb.ru/`, task `154312`;
- no REST application, member credential or webhook credential exists;
- the user-authorized browser entry URL is credential-bearing and must stay in
  isolated Hermes state, never in this repository, logs or Control Plane env;
- the legacy direct REST webhook and adapter are not part of the MVP surface.

The `bitrix-client` profile remains deliberately fail-closed. Bitrix is Phase C,
not a Phase B activation prerequisite: do not install a browser backend, copy
the credential-bearing entry URL, enable the client bridge, register a
callback, or require Bitrix evidence for Phase B. Web readiness must continue
to report `clientConversationActions: false`. Phase C requires a separately
approved persistent browser backend and stable authenticated native message and
author identities before the narrow issue-intake capability can be enabled.
General terminal, checkout, status, production, internal-history and approval
capabilities remain forbidden.

### Separate ASCON Hermes

The selected supported binding is
`https://hermes-ascon.f-ai.studio/v1/runs`. Control Plane posts the bounded
`fai.agent-role-request.v1` as the run `input`, sets the existing correlation as
`session_id`, and uses Bearer authentication.

The separate deployment uses `/opt/fai-hermes-ascon`, state/work directory
`/var/lib/fai-hermes-ascon` (mounted only at `/opt/data`) and dedicated work
directory `/var/lib/fai-hermes-ascon/work`, candidate loopback port `13020`, Hermes-side ref
`/etc/fai-hermes-ascon/secrets/api-server.env` containing only the required
`API_SERVER_KEY`; `/etc/fai-hermes-ascon/secrets/telegram.env` containing only
`TELEGRAM_BOT_TOKEN`; separate internal/client bridge tokens mounted read-only
under their profiles from isolated UID-10000 runtime copies. Their canonical
sources remain `/etc/fai-hermes-ascon/secrets/{internal-bridge-token,client-bridge-token}`
as `root:root` mode `0600`; the deploy script recreates matching
`/var/lib/fai-hermes-ascon/runtime-secrets/*` copies as `10000:10000` mode
`0600` without displaying their contents. Control-Plane-side refs are
`/etc/fai-control-plane-mvp/secrets/hermes-token`. DNS, TLS, receiver
implementation/registration and proof of this ACK remain pending explicit
approval. The MSA Hermes endpoint, state and credentials are forbidden.

Current upstream research establishes the API contract: Hermes Agent
v0.20.1 (`v2026.8.13`) supports `POST /v1/runs`, Bearer
`API_SERVER_KEY`, optional `session_id` and `instructions`, and returns HTTP 202
`{"run_id":"...","status":"started"}`. Therefore the supported literal URL
is `https://hermes-ascon.f-ai.studio/v1/runs`; the earlier invented
`/role-requests` is rejected. The Control Plane adapter maps `run_id` to
delivery evidence and the sent `session_id` to session evidence. No
compatibility proxy is permitted.

The supported deployment choice is the official Docker image
`nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6`
in a
separate Compose project `fai-hermes-ascon`. The initial safe stage keeps
dashboard/cron and browser tooling disabled, enables Telegram only for the
exact ASCON chat/users, binds the API inside the container and publishes it only to
`127.0.0.1:13020`. An Nginx server dedicated to
`hermes-ascon.f-ai.studio` terminates TLS and forwards only the API paths;
Control Plane is the only intended API caller. `API_SERVER_KEY` is mandatory.
The first certificate uses the HTTP-only
`infra/hermes-ascon/nginx/hermes-ascon.bootstrap.conf`; after issuance it is
replaced by the final server file, which retains the ACME webroot and exposes
only health, authenticated capabilities and run submission.
Initial limits are 1 CPU, 1 GiB memory, 256 PIDs and 1 GiB shared memory; the
host preflight must be repeated because official guidance recommends 2–4 GiB
when browser tooling is used. Rollback restores the prior pinned ASCON Hermes
image only and never addresses any MSA unit, directory or credential. The
provider is `openai-codex` with model `gpt-5.6-terra`; its device flow persists Hermes' independent OAuth
session at `/var/lib/fai-hermes-ascon/auth.json`. No provider secret env file or
Codex CLI credential copy is used.
The official image keeps its immutable installation under `/opt/hermes`; only
the isolated `/var/lib/fai-hermes-ascon` bind mounted at `/opt/data` is writable
ASCON state.

Hermes staging is deliberately separate from Control Plane deployment and does
not install DNS, TLS or Nginx configuration. After those are separately
approved and installed, the only command interface is:

```bash
cd /opt/fai-hermes-ascon
HERMES_APPROVED_IMAGE='nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6' \
HERMES_APPROVED_CONFIG_SHA256='b68936d8535863f01a8cc3c5d5b00f4da44a2742eb4a3f72e4a4f543200aff40' \
  ./scripts/deploy-hermes-ascon.sh auth

cd /opt/fai-hermes-ascon
HERMES_APPROVED_IMAGE='nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6' \
HERMES_APPROVED_CONFIG_SHA256='b68936d8535863f01a8cc3c5d5b00f4da44a2742eb4a3f72e4a4f543200aff40' \
  ./scripts/deploy-hermes-ascon.sh stage

cd /opt/fai-hermes-ascon
HERMES_APPROVED_IMAGE='nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6' \
HERMES_APPROVED_CONFIG_SHA256='b68936d8535863f01a8cc3c5d5b00f4da44a2742eb4a3f72e4a4f543200aff40' \
  ./scripts/deploy-hermes-ascon.sh rollback
```

`auth` is a separate interactive approval gate for the official Codex device
flow. Before either `auth` or `stage`, the script makes exactly the three
configs and five plugin/hook files root-owned mode `0644`, their two mounted
source directories mode `0755`, the work directory `10000:10000` mode `0700`,
and recreates the two isolated runtime token copies described above. An
ephemeral UID-10000 probe must read all ten mounted files and write the work
directory without config fallback. `stage` then proves Codex auth without
printing its output, starts only project `fai-hermes-ascon`, waits at most 180
seconds for container health, and only then checks public health plus
authenticated capabilities. Any auth-status, readiness, public-health or
capabilities failure automatically takes the isolated stage down and removes
its runtime token copies. `rollback` does the same while preserving OAuth and
canonical data. Neither action changes DNS, Nginx, TLS or any MSA service.

Research sources reviewed 2026-08-14:

- official API server/runs/auth contract:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>;
- official Docker data mount, gateway supervision, limits and upgrade model:
  <https://hermes-agent.nousresearch.com/docs/user-guide/docker/>;
- official release `v2026.8.13`:
  <https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.13>;
- official profile-routing contract:
  <https://github.com/NousResearch/hermes-agent/blob/v2026.8.13/docs/profile-routing.md>;
- public operational evidence reports deployment/auth confusion and unsafe
  unauthenticated exposure. It reinforces loopback-only publish, mandatory API
  key, no dashboard and a direct `/health` plus authenticated `/v1/capabilities`
  preflight: <https://github.com/NousResearch/hermes-agent/issues/6439>,
  <https://github.com/NousResearch/hermes-agent/issues/39365>, and
  <https://www.reddit.com/r/hermesagent/comments/1ucke01/vps_deployment_megathread_hermes_agent_june_2026/>.

### Separately approved Hermes TLS/Nginx stage

The commands in this section are inactive and must not be run without separate
explicit approval of the exact Nginx files and host diff. They may create or
replace only the `hermes-ascon.f-ai.studio` site and certificate. They must not
change the `app.f-ai.studio` or marketing sites, any MSA service or file, or
Amnezia. Never run the authenticated check with shell xtrace enabled.

First prove both public resolvers agree and that port `13020` is either unused
or bound only to loopback:

```bash
set -euo pipefail
test "$(dig +short @1.1.1.1 hermes-ascon.f-ai.studio A | sort -u)" = '201.34.133.184'
test "$(dig +short @8.8.8.8 hermes-ascon.f-ai.studio A | sort -u)" = '201.34.133.184'
if ss -ltnH 'sport = :13020' | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]):13020$'; then
  exit 1
fi
```

For the first certificate, install and enable only the reviewed HTTP bootstrap
site. Both destination paths must be absent; an existing path is a stop
condition, not permission to overwrite it:

```bash
set -euo pipefail
cd /opt/fai-hermes-ascon
test ! -e /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf
test ! -e /etc/nginx/sites-enabled/hermes-ascon.f-ai.studio.conf
install -d -o root -g root -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge
install -o root -g root -m 0644 \
  infra/hermes-ascon/nginx/hermes-ascon.bootstrap.conf \
  /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf
ln -s /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf \
  /etc/nginx/sites-enabled/hermes-ascon.f-ai.studio.conf
nginx -t
systemctl reload nginx
```

Issue a certificate for only the Hermes hostname through the retained ACME
webroot, then replace only that site's available file with the reviewed final
configuration:

```bash
set -euo pipefail
certbot certonly --webroot --webroot-path /var/lib/letsencrypt \
  --cert-name hermes-ascon.f-ai.studio \
  --domains hermes-ascon.f-ai.studio \
  --non-interactive
cd /opt/fai-hermes-ascon
install -o root -g root -m 0644 \
  infra/hermes-ascon/nginx/hermes-ascon.f-ai.studio.conf \
  /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf
nginx -t
systemctl reload nginx
```

After the separately approved Hermes `stage` has started its loopback-only
gateway, prove public health and authenticated capabilities without displaying
the API key:

```bash
set -euo pipefail
curl -fsS --max-time 15 https://hermes-ascon.f-ai.studio/health >/dev/null
api_key=$(sed -n 's/^API_SERVER_KEY=//p' \
  /etc/fai-hermes-ascon/secrets/api-server.env)
test -n "$api_key"
printf 'header = "Authorization: Bearer %s"\n' "$api_key" | \
  curl -fsS --max-time 15 --config - \
    https://hermes-ascon.f-ai.studio/v1/capabilities >/dev/null
unset api_key
```

If certificate issuance or the final config/reload fails, restore only the
bootstrap file and leave the new site enabled for ACME retry after diagnosis:

```bash
set -euo pipefail
cd /opt/fai-hermes-ascon
install -o root -g root -m 0644 \
  infra/hermes-ascon/nginx/hermes-ascon.bootstrap.conf \
  /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf
nginx -t
systemctl reload nginx
```

For a separately approved full Hermes-site rollback, first run the Hermes
Compose rollback, then disable only the exact new symlink. Preserve the
available files and certificate as evidence; do not delete or edit another
site:

```bash
set -euo pipefail
test "$(readlink /etc/nginx/sites-enabled/hermes-ascon.f-ai.studio.conf)" = \
  '/etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf'
unlink /etc/nginx/sites-enabled/hermes-ascon.f-ai.studio.conf
nginx -t
systemctl reload nginx
```

## Exact Phase B execution package

This durable package is release-neutral. After the intended release is merged,
the owning issue's approval comment must record its 40-character lowercase
release commit plus the generated disabled-worker and enabled-worker Control
Plane configuration SHA-256 digests. Copy those approved values into the
explicit shell placeholders when running a block; never edit the checked-out
runbook or scripts. If the fetched remote `main` does not contain the approved
commit as an ancestor, either checkout is not clean at
that exact approved commit, any destination already exists, an old secret
source is absent or points somewhere else, or a digest differs, stop and
prepare a newly reviewed approval package. Remote-tip files are never used for
the release. Do not weaken a check or delete a partially prepared path. The
blocks below are explicit checkpoints: after a later block stops, resume only
at that block under a fresh approval after all earlier block postconditions
have been reverified exactly.

### Prepare only the new host paths

These inactive commands create two independent clean checkouts and only the new
configuration/state directories. They do not stop, restart, migrate, attach to,
or edit `/opt/fai-control-plane`, its Compose project, image or volumes. Run
them only after exact approval of this block:

```bash
set -euo pipefail
set +x
umask 077
release_commit='<approved-40-hex>'
repository=https://github.com/VF78/fai-control-plane.git
rollback_commit=63cc41832bb216edfa5c29e270ce1394f45d9231
rollback_image="fai-control-plane:${rollback_commit}"

[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C /opt/fai-control-plane rev-parse HEAD)" = "$rollback_commit"
test -z "$(git -C /opt/fai-control-plane status --porcelain)"
test "$(docker inspect --format '{{.Config.Image}}' fai-control-plane-production-web-1)" = "$rollback_image"
test "$(docker inspect --format '{{.State.Health.Status}}' fai-control-plane-production-web-1)" = healthy
curl -fsS --max-time 10 http://127.0.0.1:13000/api/ready >/dev/null

for path in \
  /opt/fai-control-plane-mvp \
  /opt/fai-hermes-ascon \
  /etc/fai-control-plane-mvp \
  /etc/fai-hermes-ascon \
  /var/lib/fai-hermes-ascon; do
  test ! -e "$path"
done

git clone --no-checkout "$repository" /opt/fai-control-plane-mvp
git -C /opt/fai-control-plane-mvp fetch --no-tags "$repository" refs/heads/main
remote_main=$(git -C /opt/fai-control-plane-mvp rev-parse --verify 'FETCH_HEAD^{commit}')
[[ "$remote_main" =~ ^[0-9a-f]{40}$ ]]
git -C /opt/fai-control-plane-mvp merge-base --is-ancestor "$release_commit" "$remote_main"
git -C /opt/fai-control-plane-mvp checkout --detach "$release_commit"
test "$(git -C /opt/fai-control-plane-mvp rev-parse HEAD)" = "$release_commit"
test -z "$(git -C /opt/fai-control-plane-mvp status --porcelain)"

git clone --no-checkout "$repository" /opt/fai-hermes-ascon
git -C /opt/fai-hermes-ascon fetch --no-tags "$repository" refs/heads/main
hermes_remote_main=$(git -C /opt/fai-hermes-ascon rev-parse --verify 'FETCH_HEAD^{commit}')
[[ "$hermes_remote_main" =~ ^[0-9a-f]{40}$ ]]
git -C /opt/fai-hermes-ascon merge-base --is-ancestor "$release_commit" "$hermes_remote_main"
git -C /opt/fai-hermes-ascon checkout --detach "$release_commit"
test "$(git -C /opt/fai-hermes-ascon rev-parse HEAD)" = "$release_commit"
test -z "$(git -C /opt/fai-hermes-ascon status --porcelain)"

install -d -o root -g root -m 0700 \
  /etc/fai-control-plane-mvp \
  /etc/fai-control-plane-mvp/secrets \
  /etc/fai-hermes-ascon \
  /etc/fai-hermes-ascon/secrets
install -d -o root -g root -m 0755 /var/lib/fai-hermes-ascon
install -d -o 10000 -g 10000 -m 0700 \
  /var/lib/fai-hermes-ascon/work \
  /var/lib/fai-hermes-ascon/runtime-secrets

test "$(git -C /opt/fai-control-plane rev-parse HEAD)" = "$rollback_commit"
test -z "$(git -C /opt/fai-control-plane status --porcelain)"
test "$(docker inspect --format '{{.Config.Image}}' fai-control-plane-production-web-1)" = "$rollback_image"
test "$(docker inspect --format '{{.State.Health.Status}}' fai-control-plane-production-web-1)" = healthy
curl -fsS --max-time 10 http://127.0.0.1:13000/api/ready >/dev/null
unset release_commit repository remote_main hermes_remote_main rollback_commit rollback_image
```

Do not create `/var/lib/fai-control-plane-mvp`: the fresh named PostgreSQL
volume is the Control Plane's only durable business state.

### Generate and approve non-secret Control Plane configuration digests

After merge, run this block from the clean checkout at the approved release
commit. It fetches current remote `main` only for the ancestry proof; the two
exact non-secret Control Plane configurations are generated only from the
approved checkout bytes. It prints only their SHA-256 digests. Record the
release commit and both labeled digests together in the owning issue's approval
comment. Any approved-checkout source change requires regenerating and
reapproving the package:

```bash
set -euo pipefail
set +x
umask 077
release_commit='<approved-40-hex>'
repository=https://github.com/VF78/fai-control-plane.git
checkout=$(pwd -P)
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
git -C "$checkout" fetch --no-tags "$repository" refs/heads/main
remote_main=$(git -C "$checkout" rev-parse --verify 'FETCH_HEAD^{commit}')
[[ "$remote_main" =~ ^[0-9a-f]{40}$ ]]
git -C "$checkout" merge-base --is-ancestor "$release_commit" "$remote_main"
test "$(git -C "$checkout" rev-parse --show-toplevel)" = "$checkout"
test "$(git -C "$checkout" rev-parse HEAD)" = "$release_commit"
test -z "$(git -C "$checkout" status --porcelain)"
source_file="$checkout/infra/production/production.env.example"
test "$(grep -Fxc 'FCP_RELEASE_COMMIT=REQUIRED_APPROVED_40_HEX_COMMIT' "$source_file")" -eq 1
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT
sed "s/^FCP_RELEASE_COMMIT=REQUIRED_APPROVED_40_HEX_COMMIT$/FCP_RELEASE_COMMIT=${release_commit}/" \
  "$source_file" >"$temporary_directory/disabled.env"
test "$(grep -Fxc 'FCP_RELEASE_COMMIT=REQUIRED_APPROVED_40_HEX_COMMIT' \
  "$temporary_directory/disabled.env")" -eq 0
test "$(grep -Fxc "FCP_RELEASE_COMMIT=${release_commit}" \
  "$temporary_directory/disabled.env")" -eq 1
test "$(grep -Fxc 'FCP_WORKER_ACTIVE=false' "$temporary_directory/disabled.env")" -eq 1
sed 's/^FCP_WORKER_ACTIVE=false$/FCP_WORKER_ACTIVE=true/' \
  "$temporary_directory/disabled.env" >"$temporary_directory/enabled.env"
test "$(grep -Fxc 'FCP_WORKER_ACTIVE=false' "$temporary_directory/enabled.env")" -eq 0
test "$(grep -Fxc 'FCP_WORKER_ACTIVE=true' "$temporary_directory/enabled.env")" -eq 1
! grep -Eq '^[A-Z0-9_]+=(REQUIRED_.*|REPLACE_.*)?$' \
  "$temporary_directory/disabled.env" "$temporary_directory/enabled.env"
printf 'disabled_cp_sha256=%s\n' \
  "$(sha256sum "$temporary_directory/disabled.env" | cut -d ' ' -f 1)"
printf 'enabled_cp_sha256=%s\n' \
  "$(sha256sum "$temporary_directory/enabled.env" | cut -d ' ' -f 1)"
rm -rf "$temporary_directory"
trap - EXIT
unset release_commit repository checkout remote_main source_file temporary_directory
```

The Hermes environment file is content-independent of the Control Plane
release commit; its reviewed SHA-256 remains
`b68936d8535863f01a8cc3c5d5b00f4da44a2742eb4a3f72e4a4f543200aff40`.
Install the approved disabled-worker file and Hermes file without editing them
interactively:

```bash
set -euo pipefail
set +x
umask 077
release_commit='<approved-40-hex>'
cp_digest='<approved-disabled-cp-sha256>'
hermes_digest=b68936d8535863f01a8cc3c5d5b00f4da44a2742eb4a3f72e4a4f543200aff40
repository=https://github.com/VF78/fai-control-plane.git
checkout=/opt/fai-control-plane-mvp
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
[[ "$cp_digest" =~ ^[0-9a-f]{64}$ ]]
[[ "$hermes_digest" =~ ^[0-9a-f]{64}$ ]]
git -C "$checkout" fetch --no-tags "$repository" refs/heads/main
remote_main=$(git -C "$checkout" rev-parse --verify 'FETCH_HEAD^{commit}')
[[ "$remote_main" =~ ^[0-9a-f]{40}$ ]]
git -C "$checkout" merge-base --is-ancestor "$release_commit" "$remote_main"
test "$(git -C "$checkout" rev-parse HEAD)" = "$release_commit"
test -z "$(git -C "$checkout" status --porcelain)"
temporary=$(mktemp /etc/fai-control-plane-mvp/production.env.XXXXXX)
trap 'rm -f "$temporary"' EXIT
sed "s/^FCP_RELEASE_COMMIT=REQUIRED_APPROVED_40_HEX_COMMIT$/FCP_RELEASE_COMMIT=${release_commit}/" \
  /opt/fai-control-plane-mvp/infra/production/production.env.example >"$temporary"
test "$(sha256sum "$temporary" | cut -d ' ' -f 1)" = "$cp_digest"
test "$(grep -Fxc 'FCP_WORKER_ACTIVE=false' "$temporary")" -eq 1
! grep -Eq '^[A-Z0-9_]+=(REQUIRED_.*|REPLACE_.*)?$' "$temporary"
install -o root -g root -m 0600 "$temporary" /etc/fai-control-plane-mvp/production.env

test "$(sha256sum /opt/fai-hermes-ascon/infra/hermes-ascon/production.env.example | cut -d ' ' -f 1)" = "$hermes_digest"
install -o root -g root -m 0600 \
  /opt/fai-hermes-ascon/infra/hermes-ascon/production.env.example \
  /etc/fai-hermes-ascon/production.env
rm -f "$temporary"
trap - EXIT
unset release_commit cp_digest hermes_digest repository checkout remote_main temporary
```

Do not install the enabled-worker file yet. After the disabled stage and safe
provider proofs pass, create the separately approved second file by replacing
exactly one line and checking its exact digest:

```bash
set -euo pipefail
set +x
umask 077
release_commit='<approved-40-hex>'
enabled_digest='<approved-enabled-cp-sha256>'
repository=https://github.com/VF78/fai-control-plane.git
checkout=/opt/fai-control-plane-mvp
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
[[ "$enabled_digest" =~ ^[0-9a-f]{64}$ ]]
git -C "$checkout" fetch --no-tags "$repository" refs/heads/main
remote_main=$(git -C "$checkout" rev-parse --verify 'FETCH_HEAD^{commit}')
[[ "$remote_main" =~ ^[0-9a-f]{40}$ ]]
git -C "$checkout" merge-base --is-ancestor "$release_commit" "$remote_main"
test "$(git -C "$checkout" rev-parse HEAD)" = "$release_commit"
test -z "$(git -C "$checkout" status --porcelain)"
temporary=$(mktemp /etc/fai-control-plane-mvp/production.env.XXXXXX)
trap 'rm -f "$temporary"' EXIT
test "$(grep -Fxc 'FCP_WORKER_ACTIVE=false' /etc/fai-control-plane-mvp/production.env)" -eq 1
sed 's/^FCP_WORKER_ACTIVE=false$/FCP_WORKER_ACTIVE=true/' \
  /etc/fai-control-plane-mvp/production.env >"$temporary"
test "$(grep -Fxc 'FCP_WORKER_ACTIVE=true' "$temporary")" -eq 1
test "$(sha256sum "$temporary" | cut -d ' ' -f 1)" = "$enabled_digest"
install -o root -g root -m 0600 "$temporary" /etc/fai-control-plane-mvp/production.env
rm -f "$temporary"
trap - EXIT
unset release_commit enabled_digest repository checkout remote_main temporary
```

### Secret source to host filename map

The existing GitHub OAuth App client secret and tracker token are approved for
reuse for the internal MVP, and only after the guards below prove the old
production environment still names them exactly. The Telegram token comes
from its exact workstation Keychain locator:

| Source | New host file |
|---|---|
| `/etc/fai-control-plane/secrets/github-login-client-secret` | `/etc/fai-control-plane-mvp/secrets/github-login-client-secret` |
| `/etc/fai-control-plane/secrets/github-projects-oauth-token` | `/etc/fai-control-plane-mvp/secrets/github-projects-token` |
| macOS Keychain service `fai-control-plane/ascon/telegram-bot-token`, account `@f_AI_Control_Bot` | `/etc/fai-control-plane-mvp/secrets/telegram-bot-token` and `TELEGRAM_BOT_TOKEN` in `/etc/fai-hermes-ascon/secrets/telegram.env` |

The GitHub OAuth secret is reused only for client ID
`Ov23li6xIseHRQCF38Fz`. Vladimir explicitly approved reuse of the current
tracker token for the internal MVP on 2026-08-14. Its classic-token scopes are
`gist, project, read:org, repo, workflow`; this is a recorded least-privilege
exception, not a claim that the token is read-only. The application remains
bounded by its GitHub adapters. If the exact source, identity or later
repository/Project proof differs, stop; do not search other files or
substitute another credential.

On the host, copy the two approved existing sources without reading or printing
their values:

```bash
set -euo pipefail
set +x
umask 077
old_environment=/etc/fai-control-plane/production.env
mapfile -t oauth_sources < <(sed -n 's/^GITHUB_LOGIN_CLIENT_SECRET_HOST_FILE=//p' "$old_environment")
mapfile -t github_sources < <(sed -n 's/^GITHUB_PROJECTS_OAUTH_TOKEN_HOST_FILE=//p' "$old_environment")
test "${#oauth_sources[@]}" -eq 1
test "${oauth_sources[0]}" = /etc/fai-control-plane/secrets/github-login-client-secret
test "${#github_sources[@]}" -eq 1
test "${github_sources[0]}" = /etc/fai-control-plane/secrets/github-projects-oauth-token
for source in "${oauth_sources[0]}" "${github_sources[0]}"; do
  test -f "$source"
  test ! -L "$source"
  test -s "$source"
  source_metadata=$(stat -c '%U:%G:%a' "$source")
  case "$source_metadata" in
    root:root:600|dev_msa:dev_msa:400) ;;
    *) exit 1 ;;
  esac
done
install -o root -g root -m 0600 "${oauth_sources[0]}" \
  /etc/fai-control-plane-mvp/secrets/github-login-client-secret
install -o root -g root -m 0600 "${github_sources[0]}" \
  /etc/fai-control-plane-mvp/secrets/github-projects-token
unset old_environment oauth_sources github_sources source source_metadata
```

Generate independent PostgreSQL, webhook, Hermes API and bridge secrets on the
host. The Hermes API value is written in the two formats required by Hermes and
Control Plane; each bridge value is written only to its matching pair. Values
never appear in command arguments or output:

```bash
set -euo pipefail
set +x
umask 077
temporary=$(mktemp -d /etc/fai-control-plane-mvp/.secret-stage.XXXXXX)
trap 'rm -rf "$temporary"' EXIT

openssl rand -hex 32 >"$temporary/postgres-password"
openssl rand -hex 32 >"$temporary/github-webhook-secret"
{ printf 'API_SERVER_KEY='; openssl rand -hex 32; } >"$temporary/api-server.env"
sed -n 's/^API_SERVER_KEY=//p' "$temporary/api-server.env" >"$temporary/hermes-token"
openssl rand -hex 32 >"$temporary/internal-bridge-token"
openssl rand -hex 32 >"$temporary/client-bridge-token"

install -o root -g root -m 0600 "$temporary/postgres-password" \
  /etc/fai-control-plane-mvp/secrets/postgres-password
install -o root -g root -m 0600 "$temporary/github-webhook-secret" \
  /etc/fai-control-plane-mvp/secrets/github-webhook-secret
install -o root -g root -m 0600 "$temporary/hermes-token" \
  /etc/fai-control-plane-mvp/secrets/hermes-token
install -o root -g root -m 0600 "$temporary/api-server.env" \
  /etc/fai-hermes-ascon/secrets/api-server.env
install -o root -g root -m 0600 "$temporary/internal-bridge-token" \
  /etc/fai-control-plane-mvp/secrets/hermes-internal-action-token
install -o root -g root -m 0600 "$temporary/internal-bridge-token" \
  /etc/fai-hermes-ascon/secrets/internal-bridge-token
install -o root -g root -m 0600 "$temporary/client-bridge-token" \
  /etc/fai-control-plane-mvp/secrets/hermes-client-action-token
install -o root -g root -m 0600 "$temporary/client-bridge-token" \
  /etc/fai-hermes-ascon/secrets/client-bridge-token
rm -rf "$temporary"
trap - EXIT
unset temporary
```

Transfer only the exact Telegram Keychain item by the same no-print path:

```bash
set -euo pipefail
set +x
security find-generic-password -w \
  -s 'fai-control-plane/ascon/telegram-bot-token' \
  -a '@f_AI_Control_Bot' | ssh root@46.225.163.123 '
    set -euo pipefail
    set +x
    umask 077
    IFS= read -r telegram_token
    test -n "$telegram_token"
    temporary=$(mktemp -d /etc/fai-control-plane-mvp/.telegram-stage.XXXXXX)
    trap '\''rm -rf "$temporary"'\'' EXIT
    printf "%s\n" "$telegram_token" >"$temporary/telegram-bot-token"
    printf "TELEGRAM_BOT_TOKEN=%s\n" "$telegram_token" >"$temporary/telegram.env"
    install -o root -g root -m 0600 "$temporary/telegram-bot-token" \
      /etc/fai-control-plane-mvp/secrets/telegram-bot-token
    install -o root -g root -m 0600 "$temporary/telegram.env" \
      /etc/fai-hermes-ascon/secrets/telegram.env
    unset telegram_token
    rm -rf "$temporary"
    trap - EXIT
  '
```

Finally, verify names, ownership, modes and required file shapes without
printing contents. Bitrix files must not exist:

```bash
set -euo pipefail
set +x
for directory in /etc/fai-control-plane-mvp/secrets /etc/fai-hermes-ascon/secrets; do
  test "$(stat -c '%U:%G:%a' "$directory")" = root:root:700
done
for file in \
  /etc/fai-control-plane-mvp/secrets/postgres-password \
  /etc/fai-control-plane-mvp/secrets/github-login-client-secret \
  /etc/fai-control-plane-mvp/secrets/github-projects-token \
  /etc/fai-control-plane-mvp/secrets/github-webhook-secret \
  /etc/fai-control-plane-mvp/secrets/hermes-token \
  /etc/fai-control-plane-mvp/secrets/telegram-bot-token \
  /etc/fai-control-plane-mvp/secrets/hermes-internal-action-token \
  /etc/fai-control-plane-mvp/secrets/hermes-client-action-token \
  /etc/fai-hermes-ascon/secrets/api-server.env \
  /etc/fai-hermes-ascon/secrets/telegram.env \
  /etc/fai-hermes-ascon/secrets/internal-bridge-token \
  /etc/fai-hermes-ascon/secrets/client-bridge-token; do
  test -f "$file"
  test ! -L "$file"
  test -s "$file"
  test "$(stat -c '%U:%G:%a' "$file")" = root:root:600
done
test "$(wc -l </etc/fai-hermes-ascon/secrets/api-server.env)" -eq 1
test "$(grep -Ec '^API_SERVER_KEY=[^[:space:]]+$' /etc/fai-hermes-ascon/secrets/api-server.env)" -eq 1
test "$(wc -l </etc/fai-hermes-ascon/secrets/telegram.env)" -eq 1
test "$(grep -Ec '^TELEGRAM_BOT_TOKEN=[^[:space:]]+$' /etc/fai-hermes-ascon/secrets/telegram.env)" -eq 1
test ! -e /etc/fai-control-plane-mvp/secrets/bitrix24-application-token
test ! -e /etc/fai-control-plane-mvp/secrets/bitrix24-rest-token
unset directory file
```

The Codex OAuth session is not copied as a secret file. It is created only by
the separately approved Hermes `auth` action and must remain at
`/var/lib/fai-hermes-ascon/auth.json`.

## Preflight and deployment

The isolated MVP is already active behind `127.0.0.1:13010`. Every later
release uses the same two-command interface; never edit the checkout or
`production.env` by hand:

```bash
set -euo pipefail
cd /opt/fai-control-plane-mvp
release_commit='<approved-40-hex>'
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
./scripts/deploy-prod.sh preflight "$release_commit"
```

`preflight` is production-read-only: it uses `git ls-remote` rather than
fetching or changing the checkout, environment, containers, services or
Nginx. It requires the target to equal current `origin/main`, a clean isolated
checkout, the exact protected-neighbour image and healthy protected services,
healthy active MVP PostgreSQL/web/worker, public/local readiness, the existing
`13010` Nginx route, host-owned secret files and a valid current environment.
It prints the exact SHA-256 of the environment that `deploy` would install.
That rendering changes only `FCP_RELEASE_COMMIT` and forces exactly one
`BITRIX24_CLIENT_ACTIONS_ENABLED=false` line.

Record and approve the exact release commit and printed digest. Then run:

```bash
set -euo pipefail
cd /opt/fai-control-plane-mvp
release_commit='<approved-40-hex>'
config_digest='<approved-resulting-config-sha256>'
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
[[ "$config_digest" =~ ^[0-9a-f]{64}$ ]]
FCP_APPROVED_RELEASE_COMMIT="$release_commit" \
FCP_APPROVED_CONFIG_SHA256="$config_digest" \
  ./scripts/deploy-prod.sh deploy "$release_commit"
unset release_commit config_digest
```

`deploy` repeats the preflight with the approved digest, fetches exact
`origin/main`, requires a fast-forward and re-executes the reviewed target
script. It validates and builds the target images before atomically replacing
the environment file, then runs the existing migration, idempotent bootstrap
and only the isolated MVP web/worker replacement. PostgreSQL, web and worker
must become healthy within 180 seconds; exact image tags, local health/ready,
public ready/dashboard and all protected neighbours are checked afterward.
It never runs `compose down`, prune, Nginx reload or any Hermes/MSA/marketing/
Amnezia mutation. Stop on any failure; do not bypass a guard.

### Database and readiness proof

Run from the exact checkout when a release approval requires this evidence. The table-name
comparison proves both the required 16 tables and absence of an unexpected
seventeenth table. The second query proves exactly one project and its one
exact GitHub binding. Bootstrap a second time before the queries to prove
idempotency:

```bash
set -euo pipefail
cd /opt/fai-control-plane-mvp
compose=(docker compose --project-name fai-control-plane-mvp \
  --env-file /etc/fai-control-plane-mvp/production.env \
  -f infra/production/compose.yaml)
"${compose[@]}" --profile bootstrap run --rm --no-deps bootstrap

expected_tables=actor_external_identities,actors,approval_evidence,audit_events,command_receipts,incoming_events,oauth_login_attempts,operator_sessions,outbox_events,project_memberships,project_source_artifacts,projects,secret_refs,tracker_bindings,tracker_snapshots,workspaces
actual_tables=$("${compose[@]}" exec -T postgres psql -X -U fai_mvp -d fai_control_plane_mvp -Atc \
  "select string_agg(table_name,',' order by table_name) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
test "$actual_tables" = "$expected_tables"

project_binding=$("${compose[@]}" exec -T postgres psql -X -U fai_mvp -d fai_control_plane_mvp -Atc \
  "select count(*)||':'||min(p.id::text)||':'||min(b.id::text)||':'||min(b.external_project_id) from projects p join tracker_bindings b on b.project_id=p.id where (select count(*) from projects)=1 and (select count(*) from tracker_bindings)=1")
test "$project_binding" = '1:fd22736d-1879-47fe-9b8a-c51653a4b635:7a7fcbf7-3753-4ac5-b64d-718d6daff573:PVT_kwHOBIUvJs4Bbi0Q'

curl -fsS --max-time 10 http://127.0.0.1:13010/api/health | grep -Fq '"status":"ok"'
curl -fsS --max-time 10 http://127.0.0.1:13010/api/ready | \
  grep -Fq '"clientConversationActions":false'
"${compose[@]}" exec -T worker node - <<'NODE'
const response = await fetch('http://127.0.0.1:3001/ready');
const body = await response.json();
if (response.status !== 503 || body.active !== false || body.status !== 'not_ready') process.exit(1);
NODE
unset compose expected_tables actual_tables project_binding
```

### GitHub read proof

This check runs inside the disabled worker container, where the required
secret file is already mounted. It does not print the credential. The query is
read-only and validates the exact repository and Project bindings at the time
recorded in `readAt`:

```bash
set -euo pipefail
cd /opt/fai-control-plane-mvp
compose=(docker compose --project-name fai-control-plane-mvp \
  --env-file /etc/fai-control-plane-mvp/production.env \
  -f infra/production/compose.yaml)
"${compose[@]}" exec -T worker node --input-type=module - <<'NODE'
import {readFile} from 'node:fs/promises';
const token = (await readFile('/run/secrets/github-projects-token', 'utf8')).trim();
if (!token) throw new Error('github_token_missing');
const query = `query {
  repository(owner:"VF78",name:"ascon") { id nameWithOwner defaultBranchRef { name } }
  user(login:"VF78") { projectV2(number:4) { id url updatedAt items(first:1) { totalCount } } }
}`;
const response = await fetch('https://api.github.com/graphql', {method:'POST', headers:{
  accept:'application/vnd.github+json', authorization:`Bearer ${token}`,
  'content-type':'application/json', 'user-agent':'fai-control-plane-mvp/phase-b-proof',
  'x-github-api-version':'2022-11-28'}, body:JSON.stringify({query})});
const value = await response.json();
const repository = value?.data?.repository; const project = value?.data?.user?.projectV2;
const restResponse = await fetch('https://api.github.com/repos/VF78/ascon', {headers:{
  accept:'application/vnd.github+json', authorization:`Bearer ${token}`,
  'user-agent':'fai-control-plane-mvp/phase-b-proof', 'x-github-api-version':'2022-11-28'}});
const restRepository = await restResponse.json();
const oauthScopes = (restResponse.headers.get('x-oauth-scopes') ?? '')
  .split(',').map((scope) => scope.trim()).filter(Boolean).sort();
const expectedScopes = ['gist','project','read:org','repo','workflow'].sort();
const reportedPush = typeof restRepository?.permissions?.push === 'boolean'
  ? restRepository.permissions.push : null;
if (!response.ok || value.errors || !restResponse.ok ||
    JSON.stringify(oauthScopes) !== JSON.stringify(expectedScopes) || repository?.id !== 'R_kgDOTD27Gw' ||
    repository?.nameWithOwner !== 'VF78/ascon' || repository?.defaultBranchRef?.name !== 'main' ||
    restRepository?.node_id !== 'R_kgDOTD27Gw' || restRepository?.full_name !== 'VF78/ascon' ||
    restRepository?.default_branch !== 'main' ||
    project?.id !== 'PVT_kwHOBIUvJs4Bbi0Q' || project?.url !== 'https://github.com/users/VF78/projects/4' ||
    typeof project?.updatedAt !== 'string' || !Number.isInteger(project?.items?.totalCount)) {
  throw new Error('github_read_proof_failed');
}
process.stdout.write(JSON.stringify({repository:repository.nameWithOwner, project:project.id,
  projectUpdatedAt:project.updatedAt, itemCount:project.items.totalCount,
  acceptedClassicScopes:oauthScopes, reportedPushPermission:reportedPush,
  readAt:new Date().toISOString()})+'\n');
NODE
unset compose
```

### Telegram allow, deny and replay proof

This invokes only the structured `project_facts.read` action through the local
candidate web container. It sends no Telegram message, stores no transcript,
and cannot change a GitHub task. The same exact provider delivery is accepted
once and reported as a duplicate on replay; a wrong user and wrong chat are
both denied:

```bash
set -euo pipefail
cd /opt/fai-control-plane-mvp
compose=(docker compose --project-name fai-control-plane-mvp \
  --env-file /etc/fai-control-plane-mvp/production.env \
  -f infra/production/compose.yaml)
"${compose[@]}" exec -T web node --input-type=module - <<'NODE'
import {readFile} from 'node:fs/promises';
const token = (await readFile('/run/secrets/hermes-internal-action-token', 'utf8')).trim();
if (!token) throw new Error('internal_bridge_token_missing');
const endpoint = 'http://127.0.0.1:3000/api/hermes/conversation-actions';
const send = async (source) => {
  const response = await fetch(endpoint, {method:'POST', headers:{authorization:`Bearer ${token}`,
    'content-type':'application/json'}, body:JSON.stringify({source,action:{type:'project_facts.read'}})});
  return {status:response.status, body:await response.json()};
};
const base = {provider:'telegram',updateId:'174310001',messageId:'174310001',
  userId:'96211907',chatId:'-5540760630',observedAt:new Date().toISOString()};
const allowed = await send(base);
const replay = await send(base);
const wrongUser = await send({...base,updateId:'174310002',messageId:'174310002',userId:'1'});
const wrongChat = await send({...base,updateId:'174310003',messageId:'174310003',chatId:'-1'});
if (allowed.status !== 200 || allowed.body.status !== 'completed' ||
    replay.status !== 202 || replay.body.status !== 'duplicate' ||
    wrongUser.status !== 403 || wrongUser.body.error !== 'identity_denied' ||
    wrongChat.status !== 403 || wrongChat.body.error !== 'identity_denied') {
  throw new Error('telegram_boundary_proof_failed');
}
process.stdout.write(JSON.stringify({allowed:allowed.body.status,replay:replay.body.status,
  wrongUser:wrongUser.body.error,wrongChat:wrongChat.body.error})+'\n');
NODE
unset compose
```

### Explicit operator agent-submit evidence and readiness

Do not enqueue a synthetic agent request and do not start Hermes merely to
prove transport. After Vladimir explicitly selects a real GitHub Project item,
role, constraints and source documents in the authenticated UI, verify that the
single resulting `agent.submit` command receipt has a non-empty provider
reference and that its matching audit event carries the same correlation. This
is read-only evidence of the operator-authorized call; it must never manufacture
an extra run. Separately require a fresh successful GitHub snapshot, ready web
and worker endpoints, and `clientConversationActions:false` until the Bitrix
gate receives its own explicit activation approval.

No activation command follows: the isolated MVP is already the public `13010`
upstream. A normal `deploy` requires that exact route before and after the
release and never edits or reloads Nginx.

## Disable and rollback

If candidate readiness or public smoke fails, run:

```bash
set -euo pipefail
cd /opt/fai-control-plane-mvp
release_commit='<approved-40-hex>'
repository=https://github.com/VF78/fai-control-plane.git
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
git fetch --no-tags "$repository" refs/heads/main
remote_main=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
[[ "$remote_main" =~ ^[0-9a-f]{40}$ ]]
git merge-base --is-ancestor "$release_commit" "$remote_main"
test "$(git rev-parse HEAD)" = "$release_commit"
test -z "$(git status --porcelain)"
FCP_APPROVED_RELEASE_COMMIT="$release_commit" \
  ./scripts/deploy-prod.sh rollback "$release_commit"
test "$(grep -Fxc '    server 127.0.0.1:13000;' /etc/nginx/sites-available/app.f-ai.studio.conf)" -eq 1
test "$(grep -Fxc '    server 127.0.0.1:13010;' /etc/nginx/sites-available/app.f-ai.studio.conf)" -eq 0
test "$(docker inspect --format '{{.Config.Image}}' fai-control-plane-production-web-1)" = \
  fai-control-plane:63cc41832bb216edfa5c29e270ce1394f45d9231
curl -fsS --max-time 10 http://127.0.0.1:13000/api/ready >/dev/null
curl -fsS --max-time 15 https://app.f-ai.studio/api/ready >/dev/null
test -z "$(docker ps --filter label=com.docker.compose.project=fai-control-plane-mvp \
  --filter status=running --format '{{.Names}}' | grep -E -- '-(web|worker)-[0-9]+$' || true)"
docker volume inspect fai-control-plane-mvp-postgres-data >/dev/null
unset release_commit repository remote_main
```

Rollback first proves the old app ready, changes only the upstream line back to
`127.0.0.1:13000` when activation changed it, validates/reloads Nginx, stops
only the new MVP web/worker,
and rechecks protected health. Leave all containers and the fresh volume intact
for evidence; stopped containers are not removed. Do not delete data or
retry deployment until the failure is understood. Provider callbacks/tokens
are disabled only through their separately approved registrations; this script
does not manage them.
