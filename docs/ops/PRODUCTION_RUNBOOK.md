# f(AI) Control Plane production runbook

> **Transitional operations only.** This runbook describes safe operation and
> rollback of the currently deployed legacy application while issues #159 and
> #162 simplify it. It is not a product-scope document. In particular, the
> existing semantic-planner/controller/executor procedures below do not
> authorize extending or reactivating a Control-Plane-owned Hermes/Codex
> runtime. The target boundary is issue #158 and ADR 0006. Every production
> release or runtime activation still requires Vladimir's approval of the exact
> commit and action.

The only supported deployment path is
[`scripts/deploy-prod.sh`](../../scripts/deploy-prod.sh). It is limited to the
`fai-control-plane-production` Compose project on `root@46.225.163.123`, using
the checkout at `/opt/fai-control-plane`. A merged PR is never production
authorization: Vladimir must approve the exact `origin/main` commit and the
release action.

## Boundaries

- Do not change DNS, TLS, Nginx, firewall rules, host packages, the marketing
  site, Hermes, MSA, or any other service.
- Keep secrets in host-owned files only. Do not print, copy, source, or commit
  their values. `/etc/fai-control-plane/production.env` contains non-secret
  settings and secret-file paths; it must not contain `REPLACE_` values.
- Production uses `infra/production/compose.yaml`, an immutable PostgreSQL
  image digest, and the isolated named PostgreSQL/artifact volumes. Drizzle is
  the only schema-change mechanism.
- The script never runs Docker, builder, system, or volume prune. It only
  retains the current and immediately previous exact
  `fai-control-plane:<40-hex>` application tags.

## Preflight and release

From a clean checkout whose requested hash is exactly `origin/main`:

```bash
scripts/deploy-prod.sh --commit <40-lowercase-hex> --confirm-production --dry-run
scripts/deploy-prod.sh --commit <40-lowercase-hex> --confirm-production
```

When semantic planning is enabled, both commands also require the exact
planner artifact already present on the production host outside mutable
checkouts and release trees:

```bash
scripts/deploy-prod.sh --commit <40-lowercase-hex> --confirm-production \
  --planner-release-bundle /absolute/host/path/release.tar.gz \
  --planner-release-sha256 <64-lowercase-hex>
```

The dry run is remote read-only. It checks the production checkout, rendered
Compose configuration, required host-file paths, backup destination, prior
application readiness, the exact active application/planner release binding
when planning is enabled, and the remote `origin/main` reference. It therefore
also works for a newly merged target that the production checkout has not
fetched yet. It does not lock, fetch, change images, or start or stop services.

The real release acquires both the control-plane deployment lock and the same
planner activation lock used by standalone planner activation. The inherited
planner lock remains held across target activation and any rollback, without a
nested lock acquisition. The script verifies a clean `main` checkout,
fast-forwards to the approved commit, builds the immutable candidate before
stopping writers, and validates Compose, environment paths, and the backup
destination. It then stops only `web` and `worker`, creates and checks a
PostgreSQL custom dump plus an artifact archive and SHA-256 manifest, updates
only `FCP_IMAGE_TAG`, and runs Drizzle only if `packages/db/drizzle` changed
between the previous and requested commits.

If semantic planning is enabled, the script first requires the active planner
commit to equal the active application release and captures its exact bundle
SHA-256, stored bundle, and enabled state. It validates
and atomically installs the approved target bundle, activates only the planner,
requires distinct planning-bearer and provider-model credential values, and
requires authenticated target health before stopping `web` or `worker`.
Disabled planning is left untouched; the controller and executor are never
modified or restarted by this path.

Application activation starts only `worker` and `web`. It retries PostgreSQL, worker
readiness, local web health/readiness, and public health, readiness, and the
dashboard for up to 150 seconds each, matching the Compose health start window.
The script does not install or modify ingress.

## Failure and rollback

After planner activation, any application deploy or smoke failure first
restores the exact prior planner bundle and authenticated health, then returns
`FCP_IMAGE_TAG` and the two application services to the immediately previous
immutable image and requires `/api/ready` to pass for that restored pair. When a
migration ran, it first validates the backup manifest again, restores the
PostgreSQL dump and artifact archive, then resets the checkout and starts the
previous application image without rerunning migrations. A validation, restore,
checkout, or previous-service restart failure terminates in an explicit
`RECOVERY REQUIRED` state and does not attempt to start a partial recovery.
Backup files remain in `/srv/fai-control-plane/backups`. Before the destructive
`0060` legacy conversation/share cleanup or `0061` environment-access IAM
cleanup, the PostgreSQL custom dump must be encrypted, its manifest verified
before migration, and the encrypted backup retained for 30 days. The same gate
applies to every later destructive cleanup migration. Do not export a second
chat transcript: provider history remains authoritative. After 30 days,
deletion of that backup is a separate approved host action.

`scripts/deploy-prod.sh` currently fails closed before changing the checkout,
stopping writers or running migrations when the target diff adds destructive
SQL. Do not bypass this guard. A destructive release remains blocked until an
exact encrypted backup, verification and restore mechanism is implemented,
tested and separately approved.

Stop and investigate rather than bypassing the script if the checkout is dirty,
the hash differs from `origin/main`, an environment path is unavailable, the
candidate cannot build, backups do not validate, or a health check fails.
