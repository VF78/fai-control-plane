# ASCON MVP production approval package

This is an inactive production procedure for issue #174. It does not authorize
deployment, callback registration, DNS, TLS, provider writes or secret access.
Vladimir must approve the exact release commit, this diff, values still marked
`REQUIRED_*`, secret references and commands before use.

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
image `node` user. Their only durable business state is the fresh PostgreSQL
volume.

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
  `read:user`; OAuth client ID remains `REQUIRED_GITHUB_OAUTH_CLIENT_ID`;
- webhook: `https://app.f-ai.studio/api/webhooks/github`, content type JSON,
  secret ref `/etc/fai-control-plane-mvp/secrets/github-webhook-secret`;
- subscribe only to repository `issues` and `sub_issues` events. GitHub sends
  the initial `ping`. User Project #4 cannot emit `projects_v2_item`; webhook
  deliveries are reconcile hints and the bounded full Project poll is the
  authority for Project status/date changes;
- activation tracker credential: dedicated fine-grained token restricted to
  owner `VF78`, repository `VF78/ascon`, repository Metadata/Issues read and
  account Projects read. Secret ref:
  `/etc/fai-control-plane-mvp/secrets/github-projects-token`. Issue mutation
  remains provider-denied until separate exact write permission is approved.

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

The `bitrix-client` profile remains deliberately fail-closed. It requires a persistent browser
backend and a narrow authenticated Control Plane capability for deduplicated
issue intake and bounded replies. General terminal, checkout, status,
production, internal-history and approval capabilities are forbidden.

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
under their profiles; and Control-Plane-side refs
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
HERMES_APPROVED_IMAGE='<exact-approved-image@sha256>' \
HERMES_APPROVED_CONFIG_SHA256='<approved-production-env-sha256>' \
  ./scripts/deploy-hermes-ascon.sh auth

cd /opt/fai-hermes-ascon
HERMES_APPROVED_IMAGE='<exact-approved-image@sha256>' \
HERMES_APPROVED_CONFIG_SHA256='<approved-production-env-sha256>' \
  ./scripts/deploy-hermes-ascon.sh stage

cd /opt/fai-hermes-ascon
HERMES_APPROVED_IMAGE='<exact-approved-image@sha256>' \
HERMES_APPROVED_CONFIG_SHA256='<approved-production-env-sha256>' \
  ./scripts/deploy-hermes-ascon.sh rollback
```

`auth` is a separate interactive approval gate for the official Codex device
flow. `stage` validates the clean isolated checkout, exact image/config digest,
root-only environment and five exact secret files, proves Codex auth structurally, then creates only the ASCON data/work
directory, pulls and starts only project `fai-hermes-ascon`, and checks public
health plus authenticated capabilities without displaying credentials.
`rollback` stops only that Compose project and preserves its data. Neither
action changes DNS, Nginx, TLS or any MSA service.

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

## Preflight and deployment

Prepare `production.env` from `infra/production/production.env.example`, fill
every `REQUIRED_*`, and install all six secret files without displaying their
contents. Review the exact commit and diff before copying the clean checkout to
`/opt/fai-control-plane-mvp`.

The only approved command interface is:

```bash
cd /opt/fai-control-plane-mvp
FCP_APPROVED_RELEASE_COMMIT=<approved-40-hex> \
FCP_APPROVED_CONFIG_SHA256=<approved-production-env-sha256> \
  ./scripts/deploy-prod.sh stage <approved-40-hex>
```

`stage` verifies the old rollback image and protected-neighbour health, rejects
dirty/mismatched checkouts, placeholders, missing/mis-permissioned secret files
and an environment-file digest different from the approved non-secret config.
It then builds and starts only the new stack, migrates the empty database,
bootstraps idempotently, and checks the unpublished candidate through
`127.0.0.1:13010`. It does not touch Nginx.

The reviewed stage value is `FCP_WORKER_ACTIVE=false`: the worker process is
healthy but performs no poll, reconciliation, delivery or provider call, and
its readiness remains 503. Changing it to `true` is a separate exact config
approval (with a new SHA-256) after provider registrations and synthetic-safe
Hermes configuration are complete. This prevents staging from starting live
ASCON work implicitly.

Before activation, prove exactly 16 MVP tables, one ASCON project/binding,
GitHub Project read/freshness, one synthetic Hermes ACK, Telegram allow/deny
and Bitrix refetch/allow/deny evidence. Do not mutate a live ASCON task.

After Vladimir approves that evidence and the exact one-line proxy change:

```bash
cd /opt/fai-control-plane-mvp
FCP_APPROVED_RELEASE_COMMIT=<approved-40-hex> \
FCP_APPROVED_CONFIG_SHA256=<approved-production-env-sha256> \
  ./scripts/deploy-prod.sh activate <approved-40-hex>
```

`activate` requires web and worker readiness, changes only the existing
`fai_control_plane_web` server from `127.0.0.1:13000` to
`127.0.0.1:13010`, validates Nginx and reloads it. No other server block,
route, service or network rule changes.

## Disable and rollback

If candidate readiness or public smoke fails, run:

```bash
cd /opt/fai-control-plane-mvp
FCP_APPROVED_RELEASE_COMMIT=<approved-40-hex> \
  ./scripts/deploy-prod.sh rollback <approved-40-hex>
```

Rollback first proves the old app ready, changes only the upstream line back to
`127.0.0.1:13000`, validates/reloads Nginx, stops only the new MVP web/worker,
and rechecks protected health. Leave all containers and the fresh volume intact
for evidence; stopped containers are not removed. Do not delete data or
retry deployment until the failure is understood. Provider callbacks/tokens
are disabled only through their separately approved registrations; this script
does not manage them.
