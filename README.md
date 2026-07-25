# f(AI) Control Plane

Local development foundation for a TypeScript control plane that coordinates
tracked work, approvals, isolated execution, and client-safe result sharing.

> This repository and its Compose stack are for local development only. They do
> not define or authorize a production deployment.

## Architecture

The system is a modular monolith with two process entry points:

- `web`: Next.js UI and backend-for-frontend (BFF) on port `3000`
- `worker`: background jobs, tracker synchronization, and run orchestration on
  port `3001`

Both processes use the same domain and infrastructure packages. PostgreSQL is
the canonical durable store. `pg-boss` keeps jobs transactional with application
state, and Drizzle owns schema migrations.

```text
.
├── apps/
│   ├── web/                  # Next.js UI, BFF, auth, health endpoint
│   └── worker/               # pg-boss consumers and orchestration
├── packages/
│   ├── domain/               # entities, policies, use cases, ports
│   ├── db/                   # Drizzle schema, repositories, migrations
│   ├── integrations/         # TrackerAdapter implementations and sync
│   ├── runners/              # isolated runner contracts and artifacts
│   └── observability/        # OpenTelemetry setup and redaction
├── infra/
│   └── compose/
│       └── Dockerfile        # shared multi-stage web/worker image
├── docs/
│   └── adr/                  # architecture decision records
├── compose.yaml
└── .env.example
```

```text
Browser -> Next.js BFF -> domain -> PostgreSQL
                            |
                            +-> pg-boss -> worker -> TrackerAdapter -> GitHub
                                               |
                                               +-> isolated runner -> artifacts
```

GitHub is a bidirectional `TrackerAdapter`, not a second control-plane database.
Inbound webhooks and polling results enter a durable inbox. Domain changes that
must be reflected in GitHub enter a durable outbox. The field-level authority
matrix in [ADR 0002](docs/adr/0002-postgresql-authority-and-tracker-sync.md)
prevents ambiguous last-writer-wins behavior.

## Local Bootstrap

Expected time on a normal development machine: 15-30 minutes, and no more than
60 minutes including the first image build.

### Prerequisites

- Docker Engine or Docker Desktop with Compose v2
- Git
- At least 4 GB of memory available to Docker

Node.js and pnpm are installed in the development image; host installations are
not required for the Compose workflow.

### Start

```bash
cp .env.example .env
docker compose up --build -d
```

Compose starts PostgreSQL, waits for it to become ready, applies the compiled
migration once, then starts the compiled web and worker processes directly:

```bash
node apps/web/.next/standalone/apps/web/server.js
node apps/worker/dist/index.js
```

GitHub synchronization and runner execution are disabled by default. Enabling
either requires explicit local configuration and must not put secret values in
PostgreSQL.

### Verify

```bash
docker compose ps --all
docker compose logs migrate
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:3000/api/ready
curl --fail http://localhost:3001/health
curl --fail http://localhost:3001/ready
docker compose exec postgres pg_isready -U fai -d fai_control_plane
```

Health URLs:

- Web/BFF: <http://localhost:3000/api/health>
- Web/BFF readiness: <http://localhost:3000/api/ready>
- Worker: <http://localhost:3001/health>
- Worker readiness: <http://localhost:3001/ready>
- PostgreSQL: `localhost:5432`

The expected state is:

- `postgres`, `web`, and `worker` are running and healthy;
- `migrate` exited with status `0`;
- both HTTP health checks return a successful status;
- `pg_isready` reports that PostgreSQL accepts connections.

For focused logs:

```bash
docker compose logs --follow web worker
```

To stop the stack while retaining the database and artifacts:

```bash
docker compose down
```

To remove local Compose volumes as well:

```bash
docker compose down --volumes
```

## Runtime Invariants

- PostgreSQL is the canonical source of truth for durable control-plane state.
- Drizzle migrations are the only supported schema-change path.
- `pg-boss` jobs and application writes share PostgreSQL transaction semantics.
- Integrations depend on provider-neutral ports; GitHub-specific behavior stays
  behind `TrackerAdapter`.
- Secret values stay in an external secret provider, mounted files, or process
  environment. The database stores only references and non-sensitive metadata.
- Runner jobs are isolated, deny network access by default, and cannot connect
  directly to the control-plane database.
- Artifacts are immutable, content-addressed where practical, access-controlled,
  and retained according to policy.
- Client shares are deny-by-default, read-only, scoped, expiring, auditable, and
  immediately revocable.
- Logs, traces, and metrics use OpenTelemetry and must redact secrets and client
  content by default.

## Non-goals

- Production deployment, production infrastructure, or a production security
  posture
- Microservice decomposition before module boundaries justify it
- Treating GitHub as the control-plane database or queue
- Running arbitrary code inside the web or worker process
- Storing credentials, tokens, private keys, or raw secret values in PostgreSQL
- Public, writable, or non-revocable client links
- A generic CI/CD platform, source-code host, or artifact registry

## Decisions

- [ADR 0001: Modular monolith with a worker](docs/adr/0001-modular-monolith-and-worker.md)
- [ADR 0002: PostgreSQL authority and bidirectional tracker sync](docs/adr/0002-postgresql-authority-and-tracker-sync.md)
- [ADR 0003: Authentication and secret handling](docs/adr/0003-authentication-and-secrets.md)
- [ADR 0004: Runner isolation and artifacts](docs/adr/0004-runner-isolation-and-artifacts.md)
- [ADR 0005: Telemetry, retention, and public sharing](docs/adr/0005-telemetry-retention-and-public-sharing.md)
