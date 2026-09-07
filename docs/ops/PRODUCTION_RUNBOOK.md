# Production runbook

This file records the stable production boundary and supported release entry
points. GitHub issue #174 owns historical activation evidence; GitHub Project
and the active issue own the current approved release.

Nothing here is standing authorization. Production, DNS, Nginx, credentials,
Hermes, VPN and shared-service changes require Vladimir's explicit approval of
the exact action.

## Topology

```text
app.f-ai.studio ─ TCP 80/443 ─> Sprintbox 185.251.88.44
                                   │ opaque Nginx stream passthrough
                                   v
                           Hetzner 46.225.163.123:80/443
                                   ├─ app Nginx -> 127.0.0.1:13010
                                   ├─ project-scoped Hermes containers
                                   └─ protected shared services

iOS AmneziaWG ─ UDP/443 ─> Sprintbox nftables
                              └─> Hetzner UDP/46019 (amnezia-awg2)

f-ai.studio / www ─> Timeweb CDN ─> origin.f-ai.studio (Hetzner)
```

Stable facts:

- Control Plane public URL: `https://app.f-ai.studio/`.
- `app.f-ai.studio` resolves to Sprintbox `185.251.88.44`.
- `f-ai.studio` and `www.f-ai.studio` remain on Timeweb CDN;
  `origin.f-ai.studio` resolves to Hetzner `46.225.163.123`.
- The former Timeweb load balancer `137583` and IP `201.34.133.184` were
  deleted. Do not recreate them as part of a normal release.
- Hetzner uses ordinary public Nginx TLS listeners on 443. Experimental
  SNI/XRay listeners 4443/8443 and test UDP DNAT 443/585/1234 were removed.
- Sprintbox runs no application, database or Hermes container. Its persistent
  responsibilities are TCP 80/443 passthrough and UDP/443 VPN relay.

## Host boundaries

### Hetzner — application host

- SSH: `root@46.225.163.123`.
- MVP checkout: `/opt/fai-control-plane-mvp`.
- Compose project: `fai-control-plane-mvp`.
- Non-secret environment: `/etc/fai-control-plane-mvp/production.env`.
- Host-owned secrets: `/etc/fai-control-plane-mvp/secrets/`, root-only.
- App loopback: `127.0.0.1:13010`; Nginx vhost:
  `/etc/nginx/sites-available/app.f-ai.studio.conf`.

Protected neighbours include:

- the f(AI) Studio marketing site and content platform;
- the MSA test contour and MSA-specific Hermes/runtime;
- `amnezia-awg2`, its peers and host UDP/46019;
- unrelated databases, volumes, credentials, Nginx sites and systemd services.

Never run host-wide Docker/system cleanup, Compose `down`, package upgrades,
filesystem cleanup or Nginx rewrites during a Control Plane release.

### Sprintbox — transport edge

- SSH: `root@185.251.88.44`.
- Nginx stream owns TCP 80/443 and forwards unchanged traffic to Hetzner 80/443.
- nftables owns UDP/443 DNAT/SNAT to Hetzner UDP/46019.
- IP forwarding and the nftables service must remain enabled.

Do not install application/Hermes workloads, terminate TLS, add a second VPN,
or change the TCP and UDP responsibilities without a separately approved
network change.

## Product safety gates

- GitHub Project is the only task/status authority.
- Reconciliation never dispatches Hermes.
- Hermes submission requires an authenticated operator and an exact non-Done
  Project item whose provider-native `Owner` is `Hermes`.
- Existing backlog/snapshot initialization produces no notifications.
- Client-messenger inbound actions remain disabled unless the configured
  provider has a separately approved, provider-native identity proof.
- Secret values must never be printed, copied into GitHub, stored in the
  business database or included in release evidence.
- GitHub Actions are not required for deployment; use approved local checks
  while the Actions spending limit is active.

### Hermes GitHub credential boundary

Reviewed non-secret Control Plane environment example SHA-256:
`f97278acbd69730676f3d5c051c704c3eb119496d528859ead42d6c8c02fe300`.

- The canonical GitHub credential is the root-owned mode `0600` file
  `/etc/fai-control-plane-mvp/secrets/github-projects-token`. On explicit agent
  installation, worker writes a project-scoped mode `0600` runtime copy under
  `/var/lib/fai-project-runtimes/<workspace>/<project>/secrets/` without logging
  the value.
- The credential must let the project Hermes directly use `git` and `gh` for
  the bound repository and GitHub Project, including issue/Project mutations,
  review branches and PRs. Verify `gh project view` and repository push/admin
  permission from inside the gateway after every credential change.
- Control Plane may use the same host-owned credential for provider polling;
  it never proxies a GitHub command for Hermes. The token value is not stored
  in PostgreSQL, rendered context, logs or agent packets.
- Branch protection must reject direct default-branch pushes. Merge, release
  and production deployment are available to the same project Hermes only for
  a request bound to an exact recorded human approval; credential presence is
  never standing authorization.

### Project Hermes dashboard and DevOps boundary

- The private internal Docker network `fai-hermes-management` connects only the
  Control Plane web/worker services and each project-owned Hermes gateway. The
  upstream s6 supervisor runs that gateway's API, messenger and dashboard in
  one container. The authenticated dashboard is used only for internal
  file/context operations, has no host-published port, and is not a second
  management runtime.
- Web, migrations and bootstrap drop to the image `node` user. Only worker keeps
  its explicit Compose `0:0` identity because it owns the bounded host runtime
  tree, changes project files to Hermes UID/GID `10000:10000` and controls the
  Docker socket. Its resource operations remain limited by exact project labels
  and deterministic names; it is not a general host-management process.
- Web authenticates operator commands and forwards them over the existing
  internal worker endpoint. Worker is the sole Control Plane process that reads
  project-runtime credentials or calls a project Hermes gateway/dashboard;
  web never mounts the project runtime tree.
- Control Plane preflight verifies the existing internal bridge and never
  creates unrelated host infrastructure.
- The project gateway image pins Yandex Cloud CLI `1.22.0` and OpenSSH. The
  gateway itself, and therefore its bounded Codex tasks, can use the configured
  project SSH identity, strict `known_hosts` and read-only Yandex CLI profile.
  Offline stage probes verify the binaries, mounts and SSH configuration
  without connecting to the target host or mutating Yandex Cloud.

### Isolated Hermes Codex CLI credential

The Hermes-derived image is built from the exact upstream digest recorded in
`infra/hermes-project/Dockerfile`: Hermes `v2026.8.31` and `@openai/codex`
`0.153.4`. Each
gateway runs as UID/GID `10000:10000`. Its Codex credential and persistent
memory live only under that project's runtime root. The setup UI starts a
one-shot project-owned device-auth container when authentication is absent;
after successful auth worker removes it and starts the single gateway. Never
mount root's Codex home or another project's credential.

For an approved existing-runtime image upgrade, replace only the exact owned
gateway with the approved image ID, retaining its inspected command, environment,
bind paths, networks, ownership labels, health check and resource limits.
Recompute `fai.control-plane.spec-sha256` from the exact replacement Docker
create body before adding that label; never copy the old image's fingerprint.
Stop the old
gateway before starting its replacement; retain it stopped for rollback until
the replacement passes health checks. Do not rerun setup/provisioning: that path
regenerates configuration and profiles. Persistent memory, sessions, workspace,
OAuth and secret files stay in their existing project mounts. The derived image
sets native `HERMES_SKIP_CONFIG_MIGRATION=1` because configuration is mounted
read-only. Verify effective root/internal API toolsets and client restrictions
after replacement, as a recreated bind mount picks up the current source inode.
The artifact's image version records provisioning provenance; its v2 contract
remains valid across image upgrades. Verify the running Docker image separately.

Hermes is the persistent project PM/Dev/QA/DevOps orchestrator. It reads the
referenced issue, comments, Project fields, linked PR and repository facts
directly with `git`/`gh`. If an issue lacks adequate scope or acceptance
criteria, Hermes updates that same issue and requests plan confirmation in
Telegram before execution. For a configured CLI route it creates or reuses the
stable issue worktree and invokes one non-interactive
`codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral` inside the
isolated non-root project container with the exact model and reasoning effort.
Codex reads `AGENTS.md`, the referenced issue and relevant files itself.
Development owns one implementation pass plus focused checks. It creates one review PR, or
updates that same PR head branch when QA requests rework; it never creates a
second PR for the same item. The separate QA stage first
reviews the unchanged PR independently, reuses current evidence and runs only
missing acceptance/risk checks. One localized low-risk defect may be fixed on
the existing PR branch, committed, pushed and verified in that same QA pass.
Scope or acceptance
changes, architecture/schema/public API/security/migration/production changes,
and uncertain or still-failing results return to Development and then pass QA
again. Hermes changes the same GitHub Project item directly and verifies the
provider readback. Control Plane observes the run and authoritative GitHub
facts, sends notifications, recovers an unavailable Hermes and submits the next
configured stage; it never proxies a GitHub, repository, CLI or DevOps command.

Control Plane derives executor availability only from the ready runtime artifact
of the selected project. Web and worker do not mount a global ASCON readiness
file or global Hermes credentials. A project becomes ready only after the pinned
image, device credential and gateway/dashboard health pass for that runtime.

## Supported release

`scripts/deploy-prod.sh` is the source of truth. It accepts only exact current
`origin/main`, a clean isolated checkout, healthy neighbours and approved
host-owned configuration. It builds/replaces only the MVP web/worker/migration
image and keeps unconfigured client-messenger actions disabled. The same approved deploy builds
the pinned generic `infra/hermes-project` image, inspects its exact Docker image
ID and passes that ID directly to the worker; it does not persist runtime
settings into `production.env`. The bounded project runtime root is created as
UID/GID `10000:10000`, mode `0700`. Preflight uses a non-runtime placeholder
only to validate Compose and remains read-only. After all health checks pass,
the script removes only older `fai-control-plane-mvp` images and dangling images
carrying that Compose project label. It never removes the generic project
runtime image. Project containers rotate JSON logs at 10 MiB with three files.
Runtime images, containers and volumes are not pruned. Each configured project
has one long-lived gateway container labeled with its exact workspace, project,
runtime and component ownership. Worker recovery inspects and restarts only
that deterministic container; it never lists, restarts or prunes unrelated
host containers, including MSA.

After local acceptance, merge approval and a separate production approval:

Private GitHub access stays on the operator Mac. Create an exact bundle from
the approved local `main`, transfer it to
`/tmp/fai-control-plane-<release_commit>.bundle`, and install it as
`root:root` mode `0600`. Pass that exact path as `FCP_RELEASE_BUNDLE` to both
commands below; the script verifies the bundle and its `refs/heads/main` SHA.
Remove the one-time bundle after the deploy.

```bash
cd /opt/fai-control-plane-mvp
release_commit=<approved-40-hex-origin-main>
sudo env FCP_RELEASE_BUNDLE="/tmp/fai-control-plane-$release_commit.bundle" \
  scripts/deploy-prod.sh preflight "$release_commit"
```

`preflight` is read-only and prints the resulting configuration SHA-256.
Compare that value with the reviewed configuration diff. Deploy only after
Vladimir approves both exact values:

```bash
cd /opt/fai-control-plane-mvp
release_commit=<approved-40-hex-origin-main>
config_digest=<approved-64-hex>
sudo env \
  FCP_RELEASE_BUNDLE="/tmp/fai-control-plane-$release_commit.bundle" \
  FCP_APPROVED_RELEASE_COMMIT="$release_commit" \
  FCP_APPROVED_CONFIG_SHA256="$config_digest" \
  scripts/deploy-prod.sh deploy "$release_commit"
```

Do not hand-edit the checkout, environment, Compose definition or Nginx route
to make a failed preflight pass. Stop and fix the reviewed source/configuration.

## Acceptance

The deploy script performs its own container, image, localhost, public and
protected-neighbour checks. Record only the compact result, then verify:

```bash
curl -fsS --max-time 15 https://app.f-ai.studio/api/health
curl -fsS --max-time 15 https://app.f-ai.studio/api/ready
curl -fsS --max-time 15 https://app.f-ai.studio/ >/dev/null
curl -fsS --max-time 15 https://f-ai.studio/ >/dev/null
```

Also verify DNS still matches the topology and AmneziaWG connects through
Sprintbox. Do not send test messenger messages, submit Hermes work or mutate a
real GitHub item merely as a health check.

For ordinary read-only Compose diagnostics, use the bounded helper. It derives
the required Hermes image ID from the already pinned local image, so
`production.env` remains the single persisted configuration source:

```bash
cd /opt/fai-control-plane-mvp
sudo scripts/production-compose-readonly.sh ps
sudo scripts/production-compose-readonly.sh logs --tail 100 worker
sudo scripts/production-compose-readonly.sh config --quiet
```

The helper accepts only `ps`, `logs`, and `config`; lifecycle commands remain
owned by the approved deployment workflow.

## Recovery

The non-working pre-MVP Control Plane and its `127.0.0.1:13000` rollback route
are decommissioned. Production has one reachable runtime on `127.0.0.1:13010`.
On release failure, keep the current healthy containers running and fix the
reviewed release source. Database recovery is a separate exact operation from
the isolated MVP backup; never restore another service or legacy volume.

## Incident rule

On failure, stop the current operation, capture the smallest relevant status,
and keep unrelated services running. Do not repeat destructive commands,
disable safeguards, read secrets or broaden the repair. Record the exact
symptom and changed surface in the active GitHub issue before the next action.
