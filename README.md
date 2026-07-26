# f(AI) Control Plane

Local development foundation for a TypeScript control plane that coordinates
tracked work, approvals, isolated execution, and client-safe result sharing.

> This repository and its Compose stack are for local development only. They do
> not define or authorize a production deployment.

A separate, non-authorizing production topology proposal for
`app.f-ai.studio` is documented in
[the production deployment preparation](docs/ops/APP_F_AI_STUDIO_DEPLOYMENT_PREPARATION.md).

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

GitHub is an inbound reconciliation `TrackerAdapter`, not a second
control-plane database. Webhooks and polling results enter a durable inbox and
mapped observations transition canonical PostgreSQL state; the WorkItem UI is
display-only. The GitHub writer remains deferred and disabled in this week-one
local foundation. The field-level authority matrix in
[ADR 0002](docs/adr/0002-postgresql-authority-and-tracker-sync.md) prevents
ambiguous last-writer-wins behavior when an explicit writer is later approved.

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

### Populate the panel from GitHub

This local tracker-snapshot bootstrap is separate from login OAuth. Set
`FCP_OPERATOR_GITHUB_USER_IDS` to exactly two unique canonical positive GitHub
user IDs and set `FCP_BOOTSTRAP_HUMAN_SUBJECT` to `github:user:<id>` for one of
them. The seed idempotently creates both human user Actors, keeps the bootstrap
operator as `workspace_admin`, and attaches its enabled `pm-qa-bot` /
`read_safe` profile for QA intake packet creation. Mount the GitHub App private
key at `GITHUB_APP_PRIVATE_KEY_FILE`, and mount the exact-scope
Projects OAuth token at `GITHUB_PROJECTS_OAUTH_TOKEN_FILE`. The App mints an
installation token in memory for repository, issue, pull-request, check, and
PR-link reads. The OAuth token is used only for the two allowlisted ProjectV2
status snapshots. The seed stores only the OAuth file reference; it never stores
tokens or personal credentials.

```bash
pnpm db:migrate
pnpm --filter @fai-control-plane/db db:seed
pnpm github:bootstrap
```

Then open <http://localhost:3000>. The bootstrap command reads only the seeded
MSA and ASCON repository scopes. It does not write to GitHub or GitHub Project
V2, post comments, change status, merge, deploy, or log token or path values.

Compose starts PostgreSQL, waits for it to become ready, applies the compiled
migration once, then starts the compiled web and worker processes directly:

```bash
node apps/web/.next/standalone/apps/web/server.js
node apps/worker/dist/index.js
```

GitHub inbound reconciliation and runner execution are disabled by default.
The WorkItem UI remains display-only, and the GitHub writer is deferred and
disabled; enabling any integration requires explicit local configuration and
must not put secret values in PostgreSQL.

### Workstation Runner

`pnpm runner:once` performs one claim poll and exits. It prints only
`disabled`, `idle`, or `completed`; it never prints bearer tokens, prompts, or
artifact paths. It remains disabled until
`LOCAL_WORKSTATION_RUNNER_ENABLED=true`.

When enabled, set `LOCAL_WORKSTATION_RUNNER_BASE_URL`,
`LOCAL_WORKSTATION_RUNNER_REPOSITORY` (`owner/name`),
`LOCAL_WORKSTATION_RUNNER_REPOSITORY_ROOT`,
`LOCAL_WORKSTATION_RUNNER_WORKTREE_ROOT`,
`LOCAL_WORKSTATION_RUNNER_ARTIFACT_ROOT`, and
`LOCAL_WORKSTATION_RUNNER_CODEX_HOME`. Set exactly one of
`LOCAL_WORKSTATION_RUNNER_TOKEN` or
`LOCAL_WORKSTATION_RUNNER_TOKEN_FILE`; use an operator-owned `0600` file for
the latter. Use an HTTPS base URL except for loopback local development
(`localhost`, `127.0.0.1`, or `::1`). The server transport's workspace, project, and repository
allowlists remain authoritative; the workstation also rejects claims for a
repository other than its configured value.

### Operator authentication

`AUTH_ENABLED=false` is the default local-development bypass. When it is
`true`, the operator page and later mutation routes using
`requireOperatorSession` require a short-lived, revocable server-side session.
Login uses a separate GitHub OAuth application, not the GitHub App or repository
token used by tracker synchronization.

An enabled runtime fails closed unless all of the following are exact:

- `AUTH_PUBLIC_BASE_URL` is an HTTPS origin (HTTP loopback is accepted only
  outside production);
- `GITHUB_LOGIN_CALLBACK_URL` is
  `<AUTH_PUBLIC_BASE_URL>/api/auth/github/callback`;
- `GITHUB_LOGIN_CLIENT_ID` identifies the login-only OAuth application;
- `GITHUB_LOGIN_CLIENT_SECRET_FILE` and `AUTH_SESSION_SECRET_FILE` are absolute
  mounted secret-file paths;
- `FCP_OPERATOR_GITHUB_USER_IDS` contains exactly two unique, canonical
  positive decimal GitHub user IDs, assigned operationally to Vladimir and
  Vitaliy;
- `FCP_WORKSPACE_ID` is the canonical workspace UUID;
- `FCP_BOOTSTRAP_HUMAN_SUBJECT` is exactly `github:user:<id>` for one of those
  two IDs;
- each allowlisted ID has one enabled Actor in that workspace with
  `type=human`, `auth_mode=user`, and `external_subject=github:user:<id>`.

The callback URL and client credentials must be configured in GitHub before
auth is enabled; this repository does not create or mutate that external
configuration. Replace the committed disabled secret placeholders with
operator-owned host files and keep their contents out of `.env`, logs, and
PostgreSQL. The session secret must contain at least 32 bytes.

Production ingress and application request logging must suppress callback query
strings on `/api/auth/github/callback`, because GitHub necessarily returns the
short-lived authorization code in that query. The application never emits the
callback URL, code, verifier, tokens, secrets, or GitHub profile payload.

OAuth state and session tokens are persisted only as SHA-256 hashes. The PKCE
verifier is held in a ten-minute authenticated-encrypted HttpOnly cookie, while
the matching hash-only database attempt is consumed atomically. Sessions expire
after eight hours; logout revokes them server-side. Cookies are HttpOnly,
SameSite=Lax, Path `/`, and Secure whenever the public origin is HTTPS
(mandatory in production).

The committed webhook secret mount is a non-secret disabled placeholder.
Before enabling GitHub ingestion, point `GITHUB_WEBHOOK_SECRET_HOST_FILE` at a
real host file with mode `0600`. Keep `GITHUB_INGRESS_ENABLED=false` until the
incoming-event consumer is deployed; the webhook route returns `404` while
either synchronization or ingress is disabled.

Telegram ingress and its status response are disabled by default. The webhook
accepts only `/status` from the configured private chat and user allowlists,
then records a sanitized durable command event. It does not start a runner.
`TELEGRAM_WEBHOOK_SECRET_HOST_FILE` verifies the webhook only; use the separate,
stable `TELEGRAM_IDENTITY_SECRET_HOST_FILE` for keyed delivery/message/chat/user
identities and payload fingerprints. The worker also requires a mounted
`TELEGRAM_BOT_TOKEN_HOST_FILE` before it can send. Keep
`TELEGRAM_STATUS_RESPONSE_ENABLED=false` until Vladimir explicitly approves the
exact Telegram response template and policy; this repository never sends while
the flag is disabled.

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
- GitHub usernames are display-only; only exact numeric GitHub IDs bound to
  canonical human Actors can authorize an operator session.
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
- [ADR 0002: PostgreSQL authority and inbound tracker reconciliation](docs/adr/0002-postgresql-authority-and-tracker-sync.md)
- [ADR 0003: Authentication and secret handling](docs/adr/0003-authentication-and-secrets.md)
- [ADR 0004: Runner isolation and artifacts](docs/adr/0004-runner-isolation-and-artifacts.md)
- [ADR 0005: Telemetry, retention, and public sharing](docs/adr/0005-telemetry-retention-and-public-sharing.md)
