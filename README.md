# f(AI) Control Plane

Internal MVP supervising multiple projects through GitHub Project and one
project-scoped Hermes per project.

Authority stays external:

- GitHub repository owns code, pull requests, checks and releases.
- GitHub Project owns tasks, status, assignees, dates and dependencies.
- One project-scoped Hermes directly orchestrates and executes manager,
  developer, QA and DevOps work with persistent `git`/`gh`/CLI/SSH credentials.
- PostgreSQL owns only project configuration and sources, identities,
  exact-reference approvals, provider snapshots/cursors, idempotency and audit.

The application has two processes: a Next.js web service and one stateless
worker. The worker only polls authoritative GitHub facts, observes Hermes,
delivers notifications, restarts an unavailable Hermes and launches the next
configured stage; it never brokers provider or CLI commands. The fresh
MVP database is created by `packages/db/mvp-drizzle/0000_mvp.sql`; it does not
read, migrate or delete the legacy database.

## Local start

Copy `.env.example` to `.env`, choose all IDs/configuration explicitly, and
point every `*_HOST_FILE` variable at a host-owned secret file. There are no
default credentials. Compose mounts those files read-only under `/run/secrets`.

```bash
docker compose up -d postgres migrate
docker compose --profile bootstrap run --rm bootstrap
docker compose up --build web worker
```

The bootstrap command is explicit and idempotent: it creates only the first
workspace, owner, identities and tracker credential reference without reading
the secret value. Projects, documents and project-scoped Hermes runtimes are
then created through the product UI.

## Checks

```bash
pnpm verify:mvp
```

Current product authority and acceptance are defined by GitHub issue #158,
ADR 0006 and the live `f(AI) Studio` Project. Historical ADRs and legacy
branches are not active product scope. Production uses the fail-closed
`scripts/deploy-prod.sh` flow documented in `docs/ops/PRODUCTION_RUNBOOK.md`;
merge and deployment always require separate approval.
