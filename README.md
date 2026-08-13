# f(AI) Control Plane

Internal MVP supervising one project through GitHub Project and Hermes.

Authority stays external:

- GitHub repository owns code, pull requests, checks and releases.
- GitHub Project owns tasks, status, assignees, dates and dependencies.
- Hermes executes manager, developer, QA and DevOps role requests.
- PostgreSQL owns only project configuration and sources, identities,
  exact-reference approvals, provider snapshots/cursors, idempotency and audit.

The application has two processes: a Next.js web service and one stateless
worker. The worker runs only `github-reconcile` and `delivery-retry`. The fresh
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

The bootstrap command is explicit and idempotent: it creates the first
workspace, owner, project, GitHub identity/binding and optional Telegram
identity without reading any secret value. OAuth is usable after bootstrap.
Free-form chat messages remain visibly pending; only `/facts`,
`/issue title | details`, `/clarify issue version | details`, and
`/source name | text`, and `/approve kind approval target decision` are executed. No transcript or
Hermes conversation endpoint exists in this MVP.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:check
```

Current product authority and acceptance are defined by GitHub issue #158,
ADR 0006 and the live `f(AI) Studio` Project. Historical ADRs and legacy
production files are retained only as rollback evidence. The deployment script
fails closed until issue #174 supplies an approved MVP-specific release path.
