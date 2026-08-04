# f(AI) Control Plane production runbook

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

The dry run is remote read-only. It checks the production checkout, rendered
Compose configuration, required host-file paths, backup destination, and the
remote `origin/main` reference, so it also works for a newly merged target that
the production checkout has not fetched yet. It does not lock, fetch, change
images, or start or stop services.

The real release acquires the control-plane-only lock, verifies a clean `main`
checkout, fast-forwards to the approved commit, builds the immutable candidate
before stopping writers, and validates Compose, environment paths, and the
backup destination. It then stops only `web` and `worker`, creates and checks a
PostgreSQL custom dump plus an artifact archive and SHA-256 manifest, updates
only `FCP_IMAGE_TAG`, and runs Drizzle only if `packages/db/drizzle` changed
between the previous and requested commits.

Activation starts only `worker` and `web`. It retries PostgreSQL, worker
readiness, local web health/readiness, and public health, readiness, and the
dashboard for up to 150 seconds each, matching the Compose health start window.
The script does not install or modify ingress.

## Failure and rollback

An activation or health failure automatically returns `FCP_IMAGE_TAG` and the
two application services to the immediately previous immutable image. When a
migration ran, it first validates the backup manifest again, restores the
PostgreSQL dump and artifact archive, then resets the checkout and starts the
previous application image without rerunning migrations. A validation, restore,
checkout, or previous-service restart failure terminates in an explicit
`RECOVERY REQUIRED` state and does not attempt to start a partial recovery.
Backup files remain in
`/srv/fai-control-plane/backups` for the separately approved retention and
off-host recovery process.

Stop and investigate rather than bypassing the script if the checkout is dirty,
the hash differs from `origin/main`, an environment path is unavailable, the
candidate cannot build, backups do not validate, or a health check fails.
