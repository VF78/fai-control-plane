#!/usr/bin/env bash
# The sole production deployment path for fai-control-plane-production.
set -Eeuo pipefail

readonly DEPLOY_HOST='root@46.225.163.123'
readonly REPO='/opt/fai-control-plane'
readonly ENV_FILE='/etc/fai-control-plane/production.env'
readonly COMPOSE_FILE="$REPO/infra/production/compose.yaml"
readonly PROJECT='fai-control-plane-production'
readonly BACKUP_DIR='/srv/fai-control-plane/backups'

usage() {
  cat <<'EOF'
Usage: scripts/deploy-prod.sh --commit <40-lowercase-hex> --confirm-production
       [--planner-release-bundle <absolute-remote-path> --planner-release-sha256 <64-hex>] [--dry-run]

Deploys only fai-control-plane-production on root@46.225.163.123. The commit
must exactly equal freshly fetched origin/main. --dry-run performs remote
read-only preflight; it still requires the explicit commit and confirmation.
EOF
}

die() { printf 'deploy-prod: %s\n' "$*" >&2; exit 1; }

commit=''
planner_release_bundle=''
planner_release_sha256=''
confirmed=0
dry_run=0
while (($#)); do
  case "$1" in
    --commit) (($# >= 2)) || die '--commit requires a value'; commit="$2"; shift 2 ;;
    --planner-release-bundle) (($# >= 2)) || die '--planner-release-bundle requires a value'; planner_release_bundle="$2"; shift 2 ;;
    --planner-release-sha256) (($# >= 2)) || die '--planner-release-sha256 requires a value'; planner_release_sha256="$2"; shift 2 ;;
    --confirm-production) confirmed=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die '--commit must be exactly 40 lowercase hexadecimal characters'
((confirmed == 1)) || die '--confirm-production is required'

git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die 'run from a Git checkout'
[[ -z "$(git -C "$git_root" status --porcelain)" ]] || die 'local checkout is not clean'
git -C "$git_root" fetch --quiet origin main
[[ "$(git -C "$git_root" rev-parse origin/main)" == "$commit" ]] || die '--commit must equal freshly fetched origin/main'
git -C "$git_root" rev-parse --verify --quiet "${commit}^{commit}" >/dev/null || die 'requested commit is unavailable locally'

ssh -o BatchMode=yes -o ConnectTimeout=15 "$DEPLOY_HOST" bash -s -- \
  "$commit" "$dry_run" "$planner_release_bundle" "$planner_release_sha256" <<'REMOTE'
{
  remote_script="$(mktemp)" || exit 1
  trap 'rm -f "$remote_script"' EXIT
  cat > "$remote_script" || exit 1
  status=0
  bash "$remote_script" "$@" || status=$?
  exit "$status"
}
set -Eeuo pipefail

TARGET="$1"
DRY_RUN="$2"
PLANNER_RELEASE_BUNDLE="$3"
PLANNER_RELEASE_SHA256="$4"
readonly REPO='/opt/fai-control-plane'
readonly ENV_FILE='/etc/fai-control-plane/production.env'
readonly COMPOSE_FILE="$REPO/infra/production/compose.yaml"
readonly PROJECT='fai-control-plane-production'
readonly BACKUP_DIR='/srv/fai-control-plane/backups'
readonly ARTIFACT_VOLUME='fai-control-plane-production-artifacts'
readonly PLANNER_ACTIVATION_LOCK='/var/lock/fai-hermes-planner-activation.lock'

die() { printf 'deploy-prod (remote): %s\n' "$*" >&2; exit 1; }
compose() { docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
compose_target() { FCP_IMAGE_TAG="$TARGET" docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'; }
is_hash() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
is_sha256() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

planner_health() {
  local release_commit="$1" client_user
  client_user="$(getent passwd 1000 | cut -d: -f1)"
  [[ -n "$client_user" ]] || return 1
  runuser -u "$client_user" -- /usr/bin/python3 \
    "/opt/fai-control-plane-runner/releases/$release_commit/scripts/hermes_planner_health.py" \
    --socket /run/fai-hermes-planner/planner.sock \
    --token-file /etc/fai-control-plane/secrets/hermes-semantic-planning-token \
    --release-commit "$release_commit"
}

retry() {
  local attempts="$1" delay="$2" label="$3" attempt
  shift 3
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if "$@"; then return 0; fi
    if ((attempt < attempts)); then sleep "$delay"; fi
  done
  printf 'deploy-prod: %s did not pass within %s seconds\n' "$label" "$((attempts * delay))" >&2
  return 1
}

prior_app_ready() {
  local port
  port="$(env_value WEB_BIND_PORT)"
  curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:${port}/api/ready" >/dev/null
}

required_path_keys=(
  POSTGRES_PASSWORD_HOST_FILE DATABASE_URL_HOST_FILE GITHUB_PROJECTS_OAUTH_TOKEN_HOST_FILE
  GITHUB_APP_PRIVATE_KEY_HOST_FILE GITHUB_WEBHOOK_SECRET_HOST_FILE GITHUB_LOGIN_CLIENT_SECRET_HOST_FILE
  AUTH_SESSION_SECRET_HOST_FILE LOCAL_RUNNER_TOKEN_HOST_FILE
)

validate_environment() {
  [[ -r "$ENV_FILE" && -f "$COMPOSE_FILE" ]] || die 'production configuration is unavailable'
  ! grep -Eq '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*REPLACE_' "$ENV_FILE" || die 'production environment still has placeholder values'
  is_hash "$(env_value FCP_IMAGE_TAG)" || die 'FCP_IMAGE_TAG must be an immutable commit hash'
  [[ "$(env_value POSTGRES_IMAGE)" == *@sha256:* ]] || die 'POSTGRES_IMAGE must be an immutable digest'
  [[ "$(env_value WEB_BIND_PORT)" =~ ^[0-9]{2,5}$ ]] || die 'WEB_BIND_PORT is invalid'
  [[ "$(env_value POSTGRES_DB)" =~ ^[A-Za-z0-9_]+$ ]] || die 'POSTGRES_DB is invalid'
  [[ "$(env_value POSTGRES_USER)" =~ ^[A-Za-z0-9_]+$ ]] || die 'POSTGRES_USER is invalid'
  local key path
  for key in "${required_path_keys[@]}"; do
    path="$(env_value "$key")"
    [[ "$path" == /* && -r "$path" ]] || die "required host file is unavailable: $key"
  done
  local planning_enabled planning_token planning_socket_dir
  planning_enabled="$(env_value HERMES_SEMANTIC_PLANNING_ENABLED)"
  [[ -z "$planning_enabled" || "$planning_enabled" == 'false' || "$planning_enabled" == 'true' ]] || die 'HERMES_SEMANTIC_PLANNING_ENABLED is invalid'
  if [[ "$planning_enabled" == 'true' ]]; then
    planning_token="$(env_value HERMES_SEMANTIC_PLANNING_TOKEN_HOST_FILE)"
    planning_socket_dir="$(env_value HERMES_SEMANTIC_PLANNING_SOCKET_HOST_DIR)"
    [[ "$planning_token" == '/etc/fai-control-plane/secrets/hermes-semantic-planning-token' &&
       -f "$planning_token" && ! -L "$planning_token" && -r "$planning_token" ]] ||
      die 'Hermes semantic planning token binding is unavailable'
    [[ "$planning_socket_dir" == '/run/fai-hermes-planner' && -d "$planning_socket_dir" &&
       ! -L "$planning_socket_dir" ]] || die 'Hermes semantic planning socket directory is unavailable'
    [[ -S "$planning_socket_dir/planner.sock" && ! -L "$planning_socket_dir/planner.sock" ]] ||
      die 'Hermes semantic planning live socket binding is unavailable'
    [[ "$(systemctl is-enabled fai-hermes-planner.service 2>/dev/null || true)" == 'enabled' &&
       "$(systemctl is-active fai-hermes-planner.service 2>/dev/null || true)" == 'active' ]] ||
      die 'Hermes semantic planning service is not active and enabled'
    is_sha256 "$PLANNER_RELEASE_SHA256" ||
      die 'planner release SHA-256 must be exactly 64 lowercase hexadecimal characters'
    [[ "$PLANNER_RELEASE_BUNDLE" = /* && -f "$PLANNER_RELEASE_BUNDLE" &&
       ! -L "$PLANNER_RELEASE_BUNDLE" && -r "$PLANNER_RELEASE_BUNDLE" &&
       "$PLANNER_RELEASE_BUNDLE" != /opt/fai-control-plane-runner/releases/* &&
       "$PLANNER_RELEASE_BUNDLE" != /opt/fai-control-plane/* &&
       "$PLANNER_RELEASE_BUNDLE" != "$REPO"/* ]] ||
      die 'exact remote planner release bundle and SHA-256 are required outside mutable release/checkouts'
    [[ "$(sha256sum "$PLANNER_RELEASE_BUNDLE" | awk '{print $1}')" == "$PLANNER_RELEASE_SHA256" ]] ||
      die 'planner release bundle SHA-256 mismatch'
    /usr/bin/python3 "$REPO/scripts/hermes_runner_bundle.py" verify \
      "$PLANNER_RELEASE_BUNDLE" "$TARGET" "$PLANNER_RELEASE_SHA256" ||
      die 'planner release bundle provenance validation failed'
    active_planner_commit="$(sed -n 's/^Environment=FAI_HERMES_PLANNING_RELEASE_COMMIT=//p' \
      /etc/systemd/system/fai-hermes-planner.service)"
    is_hash "$active_planner_commit" || die 'active planner release binding is unavailable'
    [[ "$active_planner_commit" == "$(env_value FCP_IMAGE_TAG)" ]] ||
      die 'active planner release differs from the active application release'
    planner_health "$active_planner_commit" || die 'active planner authenticated health failed'
  fi
  compose config --quiet
  retry 3 2 'prior application readiness baseline' prior_app_ready ||
    die 'prior application /api/ready baseline is unhealthy'
}

preflight() {
  local remote_main
  cd "$REPO"
  [[ -z "$(git status --porcelain)" ]] || die 'production checkout is not clean'
  [[ "$(git branch --show-current)" == 'main' ]] || die 'production checkout is not on main'
  remote_main="$(git ls-remote --exit-code origin refs/heads/main | awk 'NR == 1 {print $1}')" || die 'could not read production origin/main'
  [[ "$remote_main" == "$TARGET" ]] || die 'production origin/main differs from requested commit'
  validate_environment
  [[ -d "$BACKUP_DIR" && -w "$BACKUP_DIR" ]] || die 'backup destination is unavailable'
  compose ps --all >/dev/null
  docker image inspect "fai-control-plane:$TARGET" >/dev/null 2>&1 || true
}

if [[ "$DRY_RUN" == '1' ]]; then
  preflight
  printf 'deploy-prod: remote preflight passed for %s; no remote state changed\n' "$TARGET"
  exit 0
fi

exec 9>/var/lock/fai-control-plane-production-deploy.lock
flock -n 9 || die 'another fai-control-plane production deployment is running'
[[ ! -L "$PLANNER_ACTIVATION_LOCK" ]] || die 'planner activation lock binding mismatch'
if [[ ! -e "$PLANNER_ACTIVATION_LOCK" ]]; then
  (umask 077; set -o noclobber; : >"$PLANNER_ACTIVATION_LOCK") 2>/dev/null || true
fi
[[ -f "$PLANNER_ACTIVATION_LOCK" && ! -L "$PLANNER_ACTIVATION_LOCK" &&
   "$(stat -c '%U:%G' "$PLANNER_ACTIVATION_LOCK")" == root:root ]] ||
  die 'planner activation lock binding mismatch'
chmod 0600 "$PLANNER_ACTIVATION_LOCK"
exec 8>>"$PLANNER_ACTIVATION_LOCK"
flock -n 8 || die 'another planner activation or production deployment is running'

previous_commit=''
checkout_commit=''
previous_tag=''
migration_ran=0
activation_started=0
writes_stopped=0
backup_ready=0
db_backup=''
artifact_backup=''
checksum_file=''
planner_changed=0
planner_previous_commit=''
planner_previous_sha256=''
planner_previous_bundle=''
planner_previous_enabled=0

set_image_tag() {
  local tag="$1" temporary
  temporary="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  if ! awk -v tag="$tag" '
    /^FCP_IMAGE_TAG=/ { print "FCP_IMAGE_TAG=" tag; found=1; next }
    { print }
    END { exit found ? 0 : 1 }
  ' "$ENV_FILE" > "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! chown --reference="$ENV_FILE" "$temporary" || ! chmod --reference="$ENV_FILE" "$temporary" || ! mv "$temporary" "$ENV_FILE"; then
    rm -f "$temporary"
    return 1
  fi
}

validate_backups() {
  ((backup_ready == 1)) &&
    sha256sum -c "$checksum_file" >/dev/null &&
    docker run --rm -i "$(env_value POSTGRES_IMAGE)" pg_restore --list < "$db_backup" >/dev/null &&
    tar -tzf "$artifact_backup" >/dev/null
}

create_backups() {
  install -d -m 0700 "$BACKUP_DIR"
  [[ -w "$BACKUP_DIR" ]] || die 'backup destination is not writable'
  local stamp db_name db_user
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  db_backup="$BACKUP_DIR/postgres-${stamp}.dump"
  artifact_backup="$BACKUP_DIR/artifacts-${stamp}.tar.gz"
  checksum_file="$BACKUP_DIR/sha256-${stamp}.txt"
  db_name="$(env_value POSTGRES_DB)"
  db_user="$(env_value POSTGRES_USER)"
  compose exec -T postgres pg_dump -U "$db_user" -d "$db_name" --format=custom --no-owner --no-acl > "$db_backup"
  docker run --rm --user 0 \
    --mount "type=volume,src=$ARTIFACT_VOLUME,dst=/artifacts,readonly" \
    "fai-control-plane:$TARGET" tar -C /artifacts -czf - . > "$artifact_backup"
  chmod 0600 "$db_backup" "$artifact_backup"
  docker run --rm -i "$(env_value POSTGRES_IMAGE)" pg_restore --list < "$db_backup" >/dev/null
  tar -tzf "$artifact_backup" >/dev/null
  sha256sum "$db_backup" "$artifact_backup" > "$checksum_file"
  chmod 0600 "$checksum_file"
  sha256sum -c "$checksum_file" >/dev/null
  backup_ready=1
}

restore_backups() {
  if ! validate_backups; then recovery_required 'backup validation failed before restore'; fi
  local db_name db_user
  db_name="$(env_value POSTGRES_DB)"
  db_user="$(env_value POSTGRES_USER)"
  if ! compose stop web worker; then recovery_required 'could not stop control-plane writers for restore'; fi
  if ! compose exec -T postgres psql -U "$db_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$db_name\" WITH (FORCE)" >/dev/null; then recovery_required 'database reset failed during restore'; fi
  if ! compose exec -T postgres createdb -U "$db_user" "$db_name"; then recovery_required 'database creation failed during restore'; fi
  if ! compose exec -T postgres pg_restore -U "$db_user" -d "$db_name" --no-owner --no-acl < "$db_backup"; then recovery_required 'database restore failed'; fi
  if ! docker run --rm --user 0 --mount "type=volume,src=$ARTIFACT_VOLUME,dst=/artifacts" \
    "fai-control-plane:$previous_tag" sh -ec 'find /artifacts -mindepth 1 -delete'; then recovery_required 'artifact cleanup failed during restore'; fi
  if ! docker run --rm -i --user 0 --mount "type=volume,src=$ARTIFACT_VOLUME,dst=/artifacts" \
    "fai-control-plane:$previous_tag" sh -ec 'tar -C /artifacts -xzf -; chown -R node:node /artifacts' < "$artifact_backup"; then recovery_required 'artifact restore failed'; fi
}

recovery_required() {
  printf 'deploy-prod: RECOVERY REQUIRED: %s\n' "$1" >&2
  printf 'deploy-prod: previous tag=%s backup-db=%s backup-artifacts=%s checksum=%s\n' \
    "$previous_tag" "$db_backup" "$artifact_backup" "$checksum_file" >&2
  exit 2
}

restore_planner() {
  ((planner_changed == 1)) || return 0
  ((planner_previous_enabled == 1)) || recovery_required \
    'planner release safety gate: prior enabled state is unavailable'
  if ! FCP_HERMES_PLANNER_LOCK_FD=8 "$REPO/scripts/activate-hermes-planner.sh" \
    --release-commit="$planner_previous_commit" \
    --release-bundle="$planner_previous_bundle" \
    --release-sha256="$planner_previous_sha256" \
    --confirm-activate-fai-hermes-planner; then
    recovery_required 'planner release safety gate: failed to restore prior planner release'
  fi
  planner_health "$planner_previous_commit" || \
    recovery_required 'planner release safety gate: restored planner health failed'
  planner_changed=0
}

rollback() {
  printf 'deploy-prod: activation failed; restoring %s\n' "$previous_tag" >&2
  restore_planner
  if ((migration_ran == 1)); then restore_backups
  elif ! compose stop web worker; then recovery_required 'could not stop control-plane writers for image rollback'
  fi
  if ! git reset --hard "$previous_commit" >/dev/null; then recovery_required 'could not restore the previous checkout'; fi
  if ! set_image_tag "$previous_tag"; then recovery_required 'could not restore the previous image tag'; fi
  if ! compose up -d --no-build --no-deps worker web; then recovery_required 'could not restart the previous control-plane services'; fi
  retry 30 5 'restored prior application readiness' prior_app_ready ||
    recovery_required 'restored prior application readiness failed'
}

on_error() {
  local status="$1"
  trap - ERR
  if ((activation_started == 1)); then rollback
  elif [[ -n "$previous_commit" ]]; then
    restore_planner
    if ! git reset --hard "$previous_commit" >/dev/null; then recovery_required 'could not restore the previous checkout'; fi
    if ((writes_stopped == 1)) && ! compose up -d --no-build --no-deps worker web; then
      recovery_required 'could not restart the previous control-plane services'
    fi
    retry 30 5 'restored prior application readiness' prior_app_ready ||
      recovery_required 'restored prior application readiness failed'
  fi
  exit "$status"
}
trap 'on_error $?' ERR

cd "$REPO"
[[ -z "$(git status --porcelain)" ]] || die 'production checkout is not clean'
[[ "$(git branch --show-current)" == 'main' ]] || die 'production checkout is not on main'
checkout_commit="$(git rev-parse HEAD)"
previous_tag="$(env_value FCP_IMAGE_TAG)"
is_hash "$previous_tag" || die 'existing FCP_IMAGE_TAG is not an immutable commit hash'
[[ "$previous_tag" != "$TARGET" ]] || die 'requested commit is already active'
git merge-base --is-ancestor "$previous_tag" "$checkout_commit" || \
  die 'production checkout has diverged from the active image tag'
validate_environment
if [[ "$(env_value HERMES_SEMANTIC_PLANNING_ENABLED)" == 'true' ]]; then
  [[ "$(systemctl is-enabled fai-hermes-planner.service 2>/dev/null || true)" == 'enabled' &&
     "$(systemctl is-active fai-hermes-planner.service 2>/dev/null || true)" == 'active' ]] ||
    die 'planner release safety gate: prior planner is not active and enabled'
  planner_previous_enabled=1
  planner_previous_commit="$(sed -n \
    's/^Environment=FAI_HERMES_PLANNING_RELEASE_COMMIT=//p' \
    /etc/systemd/system/fai-hermes-planner.service)"
  is_hash "$planner_previous_commit" || \
    die 'planner release safety gate: prior planner commit is unavailable'
  [[ "$planner_previous_commit" == "$previous_tag" ]] ||
    die 'planner release safety gate: prior planner commit differs from the active application release'
  planner_previous_sha_file="/opt/fai-control-plane-runner/releases/$planner_previous_commit/RELEASE_ARTIFACT_SHA256"
  [[ -f "$planner_previous_sha_file" && ! -L "$planner_previous_sha_file" ]] ||
    die 'planner release safety gate: prior planner SHA-256 file is unavailable'
  planner_previous_sha256="$(tr -d '\r\n' < "$planner_previous_sha_file")"
  is_sha256 "$planner_previous_sha256" || \
    die 'planner release safety gate: prior planner SHA-256 is unavailable'
  planner_previous_bundle="/opt/fai-control-plane-runner/release-artifacts/${planner_previous_commit}-${planner_previous_sha256}.tar.gz"
  [[ -f "$planner_previous_bundle" && ! -L "$planner_previous_bundle" &&
     "$(sha256sum "$planner_previous_bundle" | awk '{print $1}')" == "$planner_previous_sha256" ]] ||
    die 'planner release safety gate: prior bundle is unavailable; install it through the standalone installer before deployment'
  planner_health "$planner_previous_commit" || \
    die 'planner release safety gate: prior planner authenticated health failed'
fi
previous_commit="$previous_tag"
install -d -m 0700 "$BACKUP_DIR"
[[ -w "$BACKUP_DIR" ]] || die 'backup destination is unavailable'
docker image inspect "fai-control-plane:$previous_tag" >/dev/null

git fetch --quiet origin main
[[ "$(git rev-parse origin/main)" == "$TARGET" ]] || die 'production origin/main differs from requested commit'
git merge-base --is-ancestor "$checkout_commit" "$TARGET" || die 'requested commit is not a fast-forward from the production checkout'
git merge-base --is-ancestor "$previous_commit" "$TARGET" || die 'requested commit is not a fast-forward from the active image'
if git diff --unified=0 "$previous_commit" "$TARGET" -- packages/db/drizzle | \
  grep -Eq '^\+[[:space:]]*(DELETE[[:space:]]+FROM|TRUNCATE|DROP[[:space:]]+(TABLE|TYPE|SCHEMA|INDEX|COLUMN))'; then
  die 'destructive migration blocked: deploy-prod has no approved encrypted backup/restore implementation'
fi
git merge --ff-only "$TARGET" >/dev/null

compose_target build web worker
docker image inspect "fai-control-plane:$TARGET" >/dev/null
if [[ "$(env_value HERMES_SEMANTIC_PLANNING_ENABLED)" == 'true' ]]; then
  FCP_HERMES_PLANNER_LOCK_FD=8 "$REPO/scripts/activate-hermes-planner.sh" \
    --release-commit="$TARGET" \
    --release-bundle="$PLANNER_RELEASE_BUNDLE" \
    --release-sha256="$PLANNER_RELEASE_SHA256" \
    --confirm-activate-fai-hermes-planner
  planner_changed=1
  if ! planner_health "$TARGET"; then
    restore_planner
    retry 30 5 'restored prior application readiness' prior_app_ready ||
      recovery_required 'restored prior application readiness failed after target planner rejection'
    recovery_required 'planner release safety gate: target planner authenticated health failed'
  fi
fi
compose stop web worker
writes_stopped=1
create_backups

activation_started=1
set_image_tag "$TARGET"
if ! git diff --quiet "$previous_commit" "$TARGET" -- packages/db/drizzle; then
  migration_ran=1
  compose run --rm --no-deps migrate
fi
compose up -d --no-build --no-deps worker web

db_name="$(env_value POSTGRES_DB)"
db_user="$(env_value POSTGRES_USER)"
web_port="$(env_value WEB_BIND_PORT)"
database_ready() { compose exec -T postgres pg_isready -U "$db_user" -d "$db_name" >/dev/null; }
worker_ready() { compose exec -T worker node -e "fetch('http://127.0.0.1:3001/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; }
local_health() { curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:${web_port}/api/health" >/dev/null; }
local_ready() { curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:${web_port}/api/ready" >/dev/null; }
public_health() { curl --fail --silent --show-error --max-time 15 https://app.f-ai.studio/api/health >/dev/null; }
public_ready() { curl --fail --silent --show-error --max-time 15 https://app.f-ai.studio/api/ready >/dev/null; }
public_dashboard() { curl --fail --silent --show-error --max-time 15 https://app.f-ai.studio/dashboard >/dev/null; }
planner_ready() {
  [[ "$(env_value HERMES_SEMANTIC_PLANNING_ENABLED)" != true ]] ||
    runuser -u "$(getent passwd 1000 | cut -d: -f1)" -- \
    /usr/bin/python3 "/opt/fai-control-plane-runner/releases/$TARGET/scripts/hermes_planner_health.py" \
      --socket /run/fai-hermes-planner/planner.sock \
      --token-file /etc/fai-control-plane/secrets/hermes-semantic-planning-token \
      --release-commit "$TARGET"
}

retry 30 5 'PostgreSQL readiness' database_ready
retry 30 5 'worker readiness' worker_ready
retry 6 5 'Hermes planner authenticated readiness' planner_ready
retry 30 5 'local web health' local_health
retry 30 5 'local web readiness' local_ready
retry 30 5 'public health' public_health
retry 30 5 'public readiness' public_ready
retry 30 5 'public dashboard' public_dashboard

# A completed one-shot migration container can keep an otherwise obsolete
# application image referenced forever. Remove only the stopped migrate
# service container from this Compose project before enforcing image retention.
compose rm --force migrate >/dev/null

while IFS= read -r image_tag; do
  if [[ "$image_tag" != "fai-control-plane:$TARGET" && "$image_tag" != "fai-control-plane:$previous_tag" ]] && \
    ! docker image rm "$image_tag" >/dev/null 2>&1; then
    printf 'deploy-prod: retained referenced image %s\n' "$image_tag" >&2
  fi
done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^fai-control-plane:[0-9a-f]{40}$' || true)

printf 'deploy-prod: activated %s; retained %s and %s\n' "$TARGET" "$TARGET" "$previous_tag"
REMOTE
