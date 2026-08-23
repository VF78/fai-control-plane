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

## Supported release

`scripts/deploy-prod.sh` is the source of truth. It accepts only exact current
`origin/main`, a clean isolated checkout, healthy neighbours and approved
host-owned configuration. It builds/replaces only the MVP web/worker/migration
images and keeps Bitrix client actions disabled.

After local acceptance, merge approval and a separate production approval:

```bash
cd /opt/fai-control-plane-mvp
release_commit=<approved-40-hex-origin-main>
sudo scripts/deploy-prod.sh preflight "$release_commit"
```

`preflight` is read-only and prints the resulting configuration SHA-256.
Compare that value with the reviewed configuration diff. Deploy only after
Vladimir approves both exact values:

```bash
cd /opt/fai-control-plane-mvp
release_commit=<approved-40-hex-origin-main>
config_digest=<approved-64-hex>
sudo env \
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

## Rollback

Rollback is a separate exact approval and requires the retained legacy app on
`127.0.0.1:13000` to be ready. Use only the script:

```bash
cd /opt/fai-control-plane-mvp
release_commit=<approved-current-release-40-hex>
sudo env FCP_APPROVED_RELEASE_COMMIT="$release_commit" \
  scripts/deploy-prod.sh rollback "$release_commit"
```

The rollback switches only the application route and stops candidate web/worker
containers. It does not restore databases, secrets, Hermes, DNS, Sprintbox or
other services. Never improvise a database restore or shared-host rollback.

## Incident rule

On failure, stop the current operation, capture the smallest relevant status,
and keep unrelated services running. Do not repeat destructive commands,
disable safeguards, read secrets or broaden the repair. Record the exact
symptom and changed surface in the active GitHub issue before the next action.
