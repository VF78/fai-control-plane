# f(AI) Control Plane

Lightweight supervisory layer that joins GitHub Project and Hermes for
software delivery without duplicating either product.

The [GitHub repository](https://github.com/VF78/fai-control-plane) owns code,
PRs, checks and releases. GitHub Project owns tasks, assignees, dates,
dependencies and status. Hermes performs project-management, development, QA
and DevOps work through its supported profiles/tools/skills. PostgreSQL is
canonical only for Control-Plane-owned project documents/configuration,
explicit approvals, bindings and minimal correlation/audit facts.

The authoritative current scope is [issue
#158](https://github.com/VF78/fai-control-plane/issues/158), its linked Project
items and [ADR 0006](docs/adr/0006-thin-control-plane-authority.md). Existing
task/run/QA/deployment/IAM surfaces are legacy pending inventory and deletion;
their presence in the repository is not authorization to extend them.

The internal alpha is deployed separately at `app.f-ai.studio`. Repository
documentation does not authorize production changes. Read the
[production runbook](docs/ops/PRODUCTION_RUNBOOK.md) before release planning;
[`scripts/deploy-prod.sh`](scripts/deploy-prod.sh) is the sole supported
production deployment path.

## Current implementation during simplification

The repository still contains the earlier modular control-plane
implementation. Issue #159 inventories it and issue #162 removes the parts that
duplicate GitHub Project or Hermes. Until that work is approved and completed,
the operational details below describe legacy compatibility, not the target
product boundary.

## Legacy architecture reference

The system is a modular monolith with two process entry points:

- `web`: Next.js UI and backend-for-frontend (BFF) on port `3000`
- `worker`: background jobs, tracker synchronization, and run orchestration on
  port `3001`

Both processes use the same domain and infrastructure packages. Drizzle owns
schema migrations. PostgreSQL remains the durable store for facts that belong
to the Control Plane, but not for project tasks/status or Hermes execution.

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

GitHub Project is the sole task/status authority. Webhooks and repair polling
may retain only bounded cursor, idempotency, freshness and audit facts; the UI
must link back to the same GitHub item. Outbound transitions update that item
with read-after-write confirmation. [ADR
0006](docs/adr/0006-thin-control-plane-authority.md) supersedes the task and
workflow authority portions of [ADR
0002](docs/adr/0002-postgresql-authority-and-tracker-sync.md).

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
user IDs and set `FCP_BOOTSTRAP_HUMAN_SUBJECT` to `github:user:<id>` for
Vladimir. The seed idempotently reconciles Vladimir as the Product Owner,
Vitaliy as the Developer, and their canonical GitHub identities. Both MSA and
ASCON receive active memberships for Vladimir (`project_owner`), Vitaliy
(`contributor`), and Hermes (`agent`). Codex CLI remains a governed execution
runtime without a fabricated project membership. The bootstrap operator keeps
the enabled `pm-qa-bot` / `read_safe` profile for QA intake packet creation.
The seed creates no provider access grants. Mount the GitHub App private key at
`GITHUB_APP_PRIVATE_KEY_FILE`, and mount the exact-scope
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

GitHub inbound reconciliation, Status write-back and runner execution are
disabled by default. Enable them independently with
`GITHUB_SYNC_ENABLED`, `GITHUB_INGRESS_ENABLED`,
`GITHUB_STATUS_WRITEBACK_ENABLED` and the runner-specific gates only after
providing the required external secret references. No secret value belongs in
PostgreSQL.

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

Repository-host publication is a second, independent workstation gate and is
disabled unless `LOCAL_WORKSTATION_REPOSITORY_PUBLISH_ENABLED=true`. When it is
enabled, `LOCAL_WORKSTATION_REPOSITORY_PUBLISH_ALLOWED_REPOSITORY` must exactly
match `LOCAL_WORKSTATION_RUNNER_REPOSITORY`; also set
`LOCAL_WORKSTATION_REPOSITORY_PUBLISH_BASE_REF`, a comma-separated exact list in
`LOCAL_WORKSTATION_REPOSITORY_PUBLISH_REQUIRED_CHECKS`, and the opaque secret
file reference `LOCAL_WORKSTATION_REPOSITORY_PUBLISH_TOKEN_FILE`. The
orchestrator publishes only after a successful run with a clean worktree, a new
commit, the exact generated `fai/run/<runId>` branch, nonempty changed-file
evidence, and every reported and required check passing. The concrete adapter
pushes that exact commit and may create or reuse only a draft change request;
it does not merge, release, or deploy. Missing or mismatched configuration
fails closed, and disabled operation does not read or require write credentials.

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
  `<AUTH_PUBLIC_BASE_URL>/oauth/github/complete`;
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
strings on `/oauth/github/complete`, because GitHub necessarily returns the
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

Telegram ingress is disabled by default. When enabled, the webhook observes
messages only from the explicitly configured MSA/ASCON internal/client group
bindings. Each optional binding requires both
`TELEGRAM_<PROJECT>_<INTERNAL|CLIENT>_CHAT_ID` and the ISO-8601
`..._ACTIVATED_AT`; messages sent before activation are ignored. Chat commands
are never executed. PostgreSQL retains only the 500 most recent sanitized
observations per binding. It stores no raw webhook payload or attachment body.
Optional `TELEGRAM_VLADIMIR_USER_ID`, `TELEGRAM_VITALIY_USER_ID`, and
`TELEGRAM_HERMES_USER_ID` values are keyed before canonical identity
reconciliation; an omitted value remains unresolved. Removing a chat binding
deactivates it without deleting retained observations.
`TELEGRAM_WEBHOOK_SECRET_HOST_FILE` verifies the webhook only; use the separate,
stable `TELEGRAM_IDENTITY_SECRET_HOST_FILE` for keyed delivery/message/chat/user
identities. The legacy response worker also requires a mounted
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

- Production changes without an explicit reviewed release approval
- Microservice decomposition before module boundaries justify it
- Treating GitHub as the control-plane database or queue
- Running arbitrary code inside the web or worker process
- Storing credentials, tokens, private keys, or raw secret values in PostgreSQL
- Public, writable, or non-revocable client links
- A generic CI/CD platform, source-code host, or artifact registry
- A generic workflow canvas, IAM/BI suite, chat replacement, marketplace,
  billing platform, or multi-tenant SaaS in the current MVP

## Decisions

- [ADR 0001: Modular monolith with a worker](docs/adr/0001-modular-monolith-and-worker.md)
- [ADR 0002: PostgreSQL authority and gated tracker reconciliation](docs/adr/0002-postgresql-authority-and-tracker-sync.md)
- [ADR 0003: Authentication and secret handling](docs/adr/0003-authentication-and-secrets.md)
- [ADR 0004: Runner isolation and artifacts](docs/adr/0004-runner-isolation-and-artifacts.md)
- [ADR 0005: Telemetry, retention, and public sharing](docs/adr/0005-telemetry-retention-and-public-sharing.md)
