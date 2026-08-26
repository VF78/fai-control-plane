# Production runbook

This file records the stable production boundary and supported release entry
points. GitHub issue #174 owns historical activation evidence; GitHub Project
and the active issue own the current approved release.

Nothing here is standing authorization. Production, DNS, Nginx, credentials,
Hermes, VPN and shared-service changes require Vladimir's explicit approval of
the exact action.

## Topology

```text
app.f-ai.studio ─┐
hermes-ascon.*  ─┴─ TCP 80/443 ─> Sprintbox 185.251.88.44
                                      │ opaque Nginx stream passthrough
                                      v
                              Hetzner 46.225.163.123:80/443
                                      ├─ app Nginx -> 127.0.0.1:13010
                                      ├─ ASCON Hermes on Hetzner
                                      └─ protected shared services

iOS AmneziaWG ─ UDP/443 ─> Sprintbox nftables
                              └─> Hetzner UDP/46019 (amnezia-awg2)

f-ai.studio / www ─> Timeweb CDN ─> origin.f-ai.studio (Hetzner)
```

Stable facts:

- Control Plane public URL: `https://app.f-ai.studio/`.
- ASCON Hermes remains on Hetzner. Sprintbox is inbound transport only; Hermes
  reaches ChatGPT, GitHub and Telegram outbound from Hetzner.
- `app.f-ai.studio` and `hermes-ascon.f-ai.studio` resolve to Sprintbox
  `185.251.88.44`.
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
- Separate ASCON Hermes uses its own checkout/config/state and public hostname;
  it is not deployed or restarted by the Control Plane release script.

Protected neighbours include:

- the f(AI) Studio marketing site and content platform;
- the MSA test contour and MSA-specific Hermes/runtime;
- ASCON Hermes except during its separately approved operation;
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
- Bitrix client actions remain disabled until a separately approved stable
  browser-identity proof.
- Secret values must never be printed, copied into GitHub, stored in the
  business database or included in release evidence.
- GitHub Actions are not required for deployment; use approved local checks
  while the Actions spending limit is active.

### Hermes GitHub credential boundary

Reviewed non-secret Hermes environment example SHA-256:
`6e36edade125c76415443da02c40c2569544fe71524fa1f53df7f88902a604bb`.

Reviewed non-secret Control Plane environment example SHA-256:
`f2df6de4ec68d2e25d2fe95873ce15a939b3a03da3625812d0a1040295f8b136`.

- Mount only the dedicated, fine-grained ASCON repository credential into the
  isolated Hermes gateway. Store its canonical value at
  `/etc/fai-hermes-ascon/secrets/github-repository-token`, root-only mode `0600`;
  the deployment script makes the UID-10000 runtime copy without logging it.
- Restrict the credential to `VF78/ascon` with metadata read, contents
  read/write and pull-request read/write. Do not grant administration, Actions,
  environments, deployments, secrets or access to another repository.
- Routine Hermes Project mutations use the existing Control Plane GitHub
  adapter. Hermes receives only its project-isolated internal bridge token;
  Telegram identity is bound server-side, every command is idempotent/audited,
  and provider versions are checked immediately before mutation.
- The separate Control Plane Project credential remains at
  `/etc/fai-control-plane-mvp/secrets/github-projects-token` and is never copied
  into Hermes. Hermes' repository credential is not used by web/worker.
- Branch protection must reject direct default-branch pushes. Merge, release
  and production deployment are available to the same project Hermes only for
  a request bound to an exact recorded human approval; credential presence is
  never standing authorization.

### Project Hermes management and DevOps boundary

- The private internal Docker network `fai-hermes-management` connects only the
  Control Plane web service, the Hermes dashboard and the Hermes gateway. The
  dashboard has no host-published port and requires its isolated basic-auth
  credential. Control Plane receives only username/password secret-file mounts.
- Hermes deployment creates or verifies this internal bridge; Control Plane
  preflight only verifies it and never creates infrastructure.
- Canonical dashboard, SSH and Yandex Cloud credential files remain root-owned
  mode `0600` under `/etc/fai-hermes-ascon/secrets`. The Hermes deploy script
  creates bounded UID-10000 runtime copies under
  `/var/lib/fai-hermes-ascon/runtime-secrets`, compares them byte-for-byte and
  removes them on cleanup without logging values.
- The project gateway image pins Yandex Cloud CLI `1.22.0` and OpenSSH. The
  gateway itself, and therefore its bounded Codex tasks, can use the configured
  project SSH identity, strict `known_hosts` and read-only Yandex CLI profile.
  Offline stage probes verify the binaries, mounts and SSH configuration
  without connecting to the target host or mutating Yandex Cloud.

### Isolated Hermes Codex CLI credential

The Hermes-derived image is built from the exact upstream digest recorded in
`infra/hermes-ascon/Dockerfile` and pins `@openai/codex` `0.144.1`. The gateway
runs as UID/GID `10000:10000`. The isolated credential lives at
`/var/lib/fai-codex-ascon/home` and is mounted into the ASCON gateway and the
one-shot `codex-cli` auth service. Never mount root's Codex home or another
project's credential.

After separate approval for the interactive device flow, create only the
project-isolated Codex credential. This action builds and probes the derived
image but does not start or restart the gateway:

```bash
cd /opt/fai-hermes-ascon
sudo env \
  HERMES_APPROVED_IMAGE=nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6 \
  HERMES_APPROVED_CONFIG_SHA256=<approved-64-hex-hermes-environment> \
  scripts/deploy-hermes-ascon.sh codex-auth
```

The approved image value is always that immutable upstream digest. The
separately validated local derived tag is `fai-hermes-ascon:codex-0.144.1`.
Codex device auth, version, filesystem and login-status probes run only in the
minimal `codex-cli` Compose service. It mounts only the isolated Codex home and
project work directory, with no gateway API/Telegram environment, bridge-token
mounts, other Hermes data or listening ports.

For a configured CLI route Hermes is only the existing remote dispatcher: it
creates a fresh temporary worktree from the pinned base and invokes one
non-interactive `codex exec` with the exact model and reasoning effort. Codex
reads `AGENTS.md`, the referenced issue and relevant files itself. Development
owns one implementation pass plus focused checks. It creates one review PR, or
updates that same PR head branch when QA requests rework; it never creates a
second PR for the same item. The separate QA stage first
reviews the unchanged PR independently, reuses current evidence and runs only
missing acceptance/risk checks. One localized low-risk defect may be fixed on
the existing PR branch, committed, pushed and verified in that same QA pass.
Scope or acceptance
changes, architecture/schema/public API/security/migration/production changes,
and uncertain or still-failing results return to Development and then pass QA
again. Hermes does no repository research, delegation, polling, repeat testing
or second review and passes the schema-constrained result through unchanged.
Control Plane validates one result and performs one configured Project
transition with readback.

`stage` deletes stale readiness first, starts both the gateway and its private
authenticated dashboard, and recreates
`/var/lib/fai-hermes-ascon/readiness/codex-cli.json` only after the separate
Hermes provider credential, Codex CLI credential, exact CLI version, derived
image, gateway/dashboard health, direct DevOps offline probes and public
capabilities all pass. Root-written readiness is mounted read-only into Control
Plane web/worker.
The same stage atomically installs the reviewed Hermes Nginx config, validates
it with `nginx -t`, reloads Nginx and probes the authenticated bounded run-status
route. Any later stage failure restores and reloads the previous config before
the isolated Hermes services are cleaned up.
Failed staging and `rollback` remove it, so missing or drifted evidence keeps
Codex execution unavailable. Staging or rollback remains a separate exact
production authorization.

## Supported release

`scripts/deploy-prod.sh` is the source of truth. It accepts only exact current
`origin/main`, a clean isolated checkout, healthy neighbours and approved
host-owned configuration. It builds/replaces only the MVP web/worker/migration
image and keeps Bitrix client actions disabled. The application image is built
once per release; after all health checks pass, the script removes only older
`fai-control-plane-mvp` images and dangling images carrying that Compose
project label. Project containers rotate JSON logs at 10 MiB with three files.
Unused Docker build cache is removed after successful release checks; runtime
images, containers and volumes are not pruned.

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
curl -fsS --max-time 15 https://hermes-ascon.f-ai.studio/health
curl -fsS --max-time 15 https://f-ai.studio/ >/dev/null
```

Also verify DNS still matches the topology and AmneziaWG connects through
Sprintbox. Do not send Telegram/Bitrix messages, submit Hermes work or mutate a
real GitHub item merely as a health check.

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
