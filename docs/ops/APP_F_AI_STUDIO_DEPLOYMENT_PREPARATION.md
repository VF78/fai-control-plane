# `app.f-ai.studio` deployment preparation

> **Preparation, not authorization.** This topology must not be activated,
> deployed, installed into Nginx, or accompanied by VPS, DNS, TLS, firewall, or
> protected-service changes without Vladimir's separate approval of the exact
> release and production diff.

This proposal runs the control plane as an independent Compose project named
`fai-control-plane-production`. It does not merge with or modify the local
`compose.yaml`. PostgreSQL has no published port, the worker has no published
port, and the only host-published application socket is
`127.0.0.1:13000 -> web:3000`. The port is only a proposal: conflicts with
existing VPS services and reserved ports must be checked before activation.

The production files are:

- `infra/production/compose.yaml`: standalone production topology.
- `infra/production/production.env.example`: non-secret settings and host paths.
- `infra/production/nginx/app.f-ai.studio.conf`: uninstalled ingress template.

The application image reuses `infra/compose/Dockerfile`. Secrets remain in
operator-owned host files mounted read-only. The database URL is read from a
mounted file only at process startup; it is not stored in the Compose env file.
Keep integrations, writeback, Telegram responses, runner transport, and public
sharing disabled until each capability receives its own approval.

## Variables used below

Run commands from a clean checkout at the approved release commit:

```bash
export REPO=/opt/fai-control-plane
export COMPOSE_FILE="$REPO/infra/production/compose.yaml"
export ENV_FILE=/etc/fai-control-plane/production.env
export BACKUP_DIR=/srv/fai-control-plane/backups
cd "$REPO"
```

Copy the template outside the checkout and replace every `REPLACE_*` value.
Do not place secret values in this file:

```bash
sudo install -d -m 0750 -o root -g docker /etc/fai-control-plane
sudo install -m 0640 -o root -g docker \
  infra/production/production.env.example "$ENV_FILE"
rg -n 'REPLACE_' "$ENV_FILE"
```

The final `rg` command must return no matches before activation.
`POSTGRES_IMAGE` must include the reviewed immutable digest for the existing
`postgres:16-bookworm` image family; a mutable tag alone is not acceptable.
Load the reviewed non-secret settings into the operator shell:

```bash
set -a
. "$ENV_FILE"
set +a
```

## Preflight

These checks are mandatory and read-only. They establish that the proposed
project, port, domain, and files do not collide with `f-ai.studio` or any
protected service:

```bash
git status --short --branch
git rev-parse HEAD
docker compose ls
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker volume ls
sudo ss -lntp
sudo ss -lntp | rg '(:13000\s)|(\[::\]:13000\s)'
sudo nginx -T | rg -n 'server_name\s+.*(f-ai\.studio|app\.f-ai\.studio)|127\.0\.0\.1:13000'
getent hosts app.f-ai.studio
sudo test ! -e /etc/nginx/sites-enabled/app.f-ai.studio.conf
```

The port-specific `ss` command must return no listener. Review the complete
Compose and Nginx inventories, not only their names. Stop if the project name,
volume names, `127.0.0.1:13000`, server name, certificate paths, or any network
overlap with an existing or protected service. DNS/TLS mismatch is a blocker,
not permission to alter DNS or certificates.

Render the exact configuration without starting containers:

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config \
  | rg -n '127\.0\.0\.1:13000|published:|target: 5432|target: 3001'
```

Expected: one `published` entry for web on loopback. There must be no published
PostgreSQL or worker port. Inspect the full rendered config locally; do not post
it because host paths and identifiers may be operationally sensitive.

Build the immutable candidate image before stopping the current deployment.
This changes no running container and makes the same reviewed image available
for artifact backup and activation:

```bash
export RELEASE_COMMIT=$(git rev-parse HEAD)
test -z "$(git status --porcelain)"
test "$RELEASE_COMMIT" = "$FCP_IMAGE_TAG"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build
```

## Host secret files

Create `/etc/fai-control-plane/secrets` with mode `0700`. Required files are:

```text
postgres-password
database-url
github-projects-oauth-token
github-app-private-key
github-webhook
telegram-webhook
telegram-identity
telegram-bot-token
github-login-client-secret
auth-session-secret
local-runner-token
share-signing-key
```

Disabled integrations still use present, non-empty random placeholder files so
that mounts are deterministic. Never commit these files. PostgreSQL's password
and the password in `database-url` must match; use a URL-safe password. For a
new installation:

```bash
sudo install -d -m 0700 -o root -g root /etc/fai-control-plane/secrets
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/fai-control-plane/secrets/postgres-password'
sudo sh -c 'p=$(cat /etc/fai-control-plane/secrets/postgres-password); printf "postgresql://fai:%s@postgres:5432/fai_control_plane\n" "$p" > /etc/fai-control-plane/secrets/database-url'
sudo sh -c 'umask 077; for f in github-projects-oauth-token github-webhook telegram-webhook telegram-identity telegram-bot-token github-login-client-secret auth-session-secret local-runner-token share-signing-key; do openssl rand -hex 32 > "/etc/fai-control-plane/secrets/$f"; done'
sudo install -m 0600 -o root -g root /dev/null /etc/fai-control-plane/secrets/github-app-private-key
```

Replace only the approved integration files with their real values. The GitHub
private-key file must contain the complete PEM. After the image is built, make
the mounted files readable only by the relevant container user:

```bash
APP_UID=$(docker run --rm --entrypoint id "fai-control-plane:$FCP_IMAGE_TAG" -u node)
PG_UID=$(docker run --rm --entrypoint id "$POSTGRES_IMAGE" -u postgres)
sudo chown "$APP_UID:$APP_UID" /etc/fai-control-plane/secrets/database-url \
  /etc/fai-control-plane/secrets/github-* \
  /etc/fai-control-plane/secrets/telegram-* \
  /etc/fai-control-plane/secrets/auth-session-secret \
  /etc/fai-control-plane/secrets/local-runner-token \
  /etc/fai-control-plane/secrets/share-signing-key
sudo chown "$PG_UID:$PG_UID" /etc/fai-control-plane/secrets/postgres-password
sudo chmod 0400 /etc/fai-control-plane/secrets/*
sudo find /etc/fai-control-plane/secrets -maxdepth 1 -type f -printf '%m %u:%g %f\n'
```

## Backup

Before every activation, back up the current database and artifacts. On a
first installation with no running project, record that there is no prior
state instead of fabricating a backup. Stop application writers first so the
database and artifact snapshots represent the same quiet deployment window:

```bash
sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" "$BACKUP_DIR"
export BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
export DB_BACKUP="$BACKUP_DIR/postgres-$BACKUP_STAMP.dump"
export ARTIFACT_BACKUP="$BACKUP_DIR/artifacts-$BACKUP_STAMP.tar.gz"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop web worker
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U fai -d fai_control_plane --format=custom --no-owner --no-acl \
  > "$DB_BACKUP"
docker run --rm --user 0 \
  --mount type=volume,src=fai-control-plane-production-artifacts,dst=/artifacts,readonly \
  "fai-control-plane:$FCP_IMAGE_TAG" tar -C /artifacts -czf - . > "$ARTIFACT_BACKUP"
chmod 0600 "$DB_BACKUP" "$ARTIFACT_BACKUP"
pg_restore --list "$DB_BACKUP" >/dev/null
tar -tzf "$ARTIFACT_BACKUP" >/dev/null
sha256sum "$DB_BACKUP" "$ARTIFACT_BACKUP" > "$BACKUP_DIR/sha256-$BACKUP_STAMP.txt"
chmod 0600 "$BACKUP_DIR/sha256-$BACKUP_STAMP.txt"
```

If backup or approval fails after stopping the writers, restart the unchanged
deployment with
`docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" start worker web`.
Copy backups to the separately approved encrypted backup destination and test a
restore outside production. A same-host backup alone is not disaster recovery.

## Build and activation commands

These commands are documented for a later, separately approved activation.
They must not be run as authority granted by this preparation:

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up --no-deps \
  --abort-on-container-exit --exit-code-from migrate migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps web \
  /bin/sh -ec 'export DATABASE_URL="$(cat /run/secrets/database-url)"; exec pnpm --filter @fai-control-plane/db db:seed'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -U fai -d fai_control_plane -c \
  "SELECT w.id AS workspace_id, p.slug, p.id AS project_id FROM workspaces w JOIN projects p ON p.workspace_id = w.id WHERE w.slug = 'fai-studio' ORDER BY p.slug;"
```

Copy the returned workspace, MSA project and ASCON project UUIDs into
`FCP_WORKSPACE_ID`, `GITHUB_MSA_PROJECT_ID`, and `GITHUB_ASCON_PROJECT_ID` in
the operator-owned env file. Re-run `rg -n 'REPLACE_' "$ENV_FILE"` and the
Compose render check; both must pass before continuing. Then create the initial
read-only tracker snapshots and start the long-running processes:

```bash
set -a
. "$ENV_FILE"
set +a
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps web \
  /bin/sh -ec 'export DATABASE_URL="$(cat /run/secrets/database-url)"; exec pnpm github:bootstrap'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --no-deps worker
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --no-deps web
```

Only after local health passes may the separately approved direct-origin TLS
and Nginx change begin. Do not modify the existing `f-ai.studio` server block
or stop Nginx for certificate issuance.

Create a temporary HTTP-only ACME site so the existing Nginx process can keep
serving every other host:

```bash
sudo install -d -m 0755 -o root -g root /var/www/letsencrypt
sudo tee /etc/nginx/sites-available/app.f-ai.studio.conf >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name app.f-ai.studio;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }

    location / {
        return 404;
    }
}
NGINX
sudo ln -s /etc/nginx/sites-available/app.f-ai.studio.conf \
  /etc/nginx/sites-enabled/app.f-ai.studio.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name app.f-ai.studio -d app.f-ai.studio
sudo test -s /etc/letsencrypt/live/app.f-ai.studio/fullchain.pem
sudo test -s /etc/letsencrypt/live/app.f-ai.studio/privkey.pem
```

Then install the reviewed final template over the temporary site. Confirm its
upstream port still equals `WEB_BIND_PORT`, inspect the diff and use
`nginx -t` before reloading:

```bash
sudo cp -a /etc/nginx/sites-available/app.f-ai.studio.conf \
  "/etc/nginx/sites-available/app.f-ai.studio.conf.before-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -m 0644 -o root -g root \
  "$REPO/infra/production/nginx/app.f-ai.studio.conf" \
  /etc/nginx/sites-available/app.f-ai.studio.conf
sudo diff -u /etc/fai-control-plane/nginx/app.f-ai.studio.conf \
  /etc/nginx/sites-available/app.f-ai.studio.conf
sudo nginx -t
sudo systemctl reload nginx
```

The `diff` must be empty. A certificate failure leaves only the isolated
HTTP-only `404` site in place; it is not permission to alter the marketing
site certificate or server block.

## Health

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --all
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --no-log-prefix migrate
curl --fail --silent --show-error http://127.0.0.1:13000/api/health
curl --fail --silent --show-error http://127.0.0.1:13000/api/ready
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T worker \
  node -e "fetch('http://127.0.0.1:3001/ready').then(async r=>{console.log(r.status,await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e.message);process.exit(1)})"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_isready -U fai -d fai_control_plane
sudo ss -lntp | rg '127\.0\.0\.1:13000'
```

After an approved ingress activation, verify through the public origin without
printing callback queries or share tokens:

```bash
curl --fail --silent --show-error https://app.f-ai.studio/api/health
curl --fail --silent --show-error https://app.f-ai.studio/api/ready
sudo tail -n 100 /var/log/nginx/app.f-ai.studio.access.log \
  | rg -n '/share/[^[]|/oauth/github/complete\?'
```

The final redaction check must return no matches. Do not use real bearer URLs
or OAuth codes as test input.

## Rollback

Record `PREVIOUS_IMAGE_TAG`, `DB_BACKUP`, and `ARTIFACT_BACKUP` in the approved
change ticket before activation. If no migration ran, roll back only the app
image:

```bash
export FCP_IMAGE_TAG="$PREVIOUS_IMAGE_TAG"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --no-deps worker
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --no-deps web
curl --fail --silent --show-error http://127.0.0.1:13000/api/ready
```

If a migration ran or compatibility is uncertain, stop application writers and
restore both snapshots:

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop web worker
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  dropdb -U fai --force fai_control_plane
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  createdb -U fai fai_control_plane
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U fai -d fai_control_plane --no-owner --no-acl < "$DB_BACKUP"
docker run --rm --user 0 \
  --mount type=volume,src=fai-control-plane-production-artifacts,dst=/artifacts \
  "fai-control-plane:$FCP_IMAGE_TAG" sh -ec 'find /artifacts -mindepth 1 -delete'
docker run --rm -i --user 0 \
  --mount type=volume,src=fai-control-plane-production-artifacts,dst=/artifacts \
  "fai-control-plane:$FCP_IMAGE_TAG" sh -ec \
  'tar -C /artifacts -xzf -; chown -R node:node /artifacts' < "$ARTIFACT_BACKUP"
export FCP_IMAGE_TAG="$PREVIOUS_IMAGE_TAG"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --no-deps worker
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --no-deps web
curl --fail --silent --show-error http://127.0.0.1:13000/api/ready
```

Do not run migrations from the rolled-back image after restoring its database
snapshot. If ingress itself caused the incident, disable only the newly added
`app.f-ai.studio` site using the separately approved Nginx change procedure;
leave `f-ai.studio` and every protected service untouched.
