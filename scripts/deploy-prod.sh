#!/usr/bin/env bash
set -euo pipefail

readonly deploy_root=/opt/fai-control-plane-mvp
readonly environment_file=/etc/fai-control-plane-mvp/production.env
readonly compose_file="$deploy_root/infra/production/compose.yaml"
readonly nginx_file=/etc/nginx/sites-available/app.f-ai.studio.conf
readonly repository=https://github.com/VF78/fai-control-plane.git
readonly active_upstream='    server 127.0.0.1:13010;'

usage() {
  printf '%s\n' \
    'usage: scripts/deploy-prod.sh preflight <40-hex>' \
    '   or: FCP_APPROVED_RELEASE_COMMIT=<40-hex> FCP_APPROVED_CONFIG_SHA256=<64-hex> scripts/deploy-prod.sh deploy <40-hex>' \
    'set FCP_RELEASE_BUNDLE=/tmp/fai-control-plane-<40-hex>.bundle to use an approved local-only private release source.' \
    'preflight is read-only and prints the exact resulting production.env SHA-256.' >&2
  exit 64
}

fail() {
  printf 'deploy-prod: %s\n' "$1" >&2
  exit 1
}

log() {
  printf 'deploy-prod: %s\n' "$1"
}

release_source() {
  local bundle=${FCP_RELEASE_BUNDLE:-}
  if [[ -z "$bundle" ]]; then
    printf '%s\n' "$repository"
    return
  fi
  [[ "$bundle" == /tmp/fai-control-plane-*.bundle ]] ||
    fail 'release bundle must use the bounded /tmp/fai-control-plane-*.bundle path'
  [[ -f "$bundle" && ! -L "$bundle" && -r "$bundle" ]] ||
    fail 'release bundle is missing or not a readable regular file'
  [[ $(stat -c '%U:%G:%a' "$bundle") == root:root:600 ]] ||
    fail 'release bundle must be root:root mode 0600'
  git bundle verify "$bundle" >/dev/null 2>&1 || fail 'release bundle verification failed'
  printf '%s\n' "$bundle"
}

[[ $# -eq 2 ]] || usage
readonly action=$1
readonly release_commit=$2
[[ "$action" == preflight || "$action" == deploy ]] || usage
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'release commit must be lowercase 40-hex'
[[ $EUID -eq 0 ]] || fail 'must run as root on the approved host'

readonly secret_root=/etc/fai-control-plane-mvp/secrets
readonly secret_names=(
  postgres-password github-login-client-secret github-projects-token github-webhook-secret
)
readonly hermes_management_network=fai-hermes-management
readonly project_runtime_root=/var/lib/fai-project-runtimes
readonly project_runtime_image=fai-hermes-project:codex-0.144.1
readonly project_runtime_config_placeholder=sha256:0000000000000000000000000000000000000000000000000000000000000000

protected_health() {
  systemctl is-active --quiet myshopai-website.service
  systemctl is-active --quiet fai-content-platform.service
  systemctl is-active --quiet hermes-gateway.service
  [[ $(docker inspect --format '{{.State.Status}}' amnezia-awg2) == running ]]
}

active_mvp_health() {
  local service worker_exit_code worker_health worker_status
  for service in postgres web; do
    [[ $(docker inspect --format '{{.State.Status}}' "fai-control-plane-mvp-${service}-1") == running ]]
    [[ $(docker inspect --format '{{.State.Health.Status}}' "fai-control-plane-mvp-${service}-1") == healthy ]]
  done
  read -r worker_status worker_health worker_exit_code < <(docker inspect --format \
    '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}} {{.State.ExitCode}}' \
    fai-control-plane-mvp-worker-1 2>/dev/null) || return 1
  case "$worker_status" in
    running)
      [[ "$worker_health" == healthy ]] || return 1
      log 'active MVP worker mode=running health=healthy'
      ;;
    exited)
      [[ "$worker_exit_code" == 0 ]] || return 1
      log 'active MVP worker mode=incident-stopped status=exited exit_code=0'
      ;;
    *) return 1 ;;
  esac
  curl -fsS --max-time 10 http://127.0.0.1:13010/api/ready >/dev/null
  curl -fsS --max-time 15 https://app.f-ai.studio/api/ready >/dev/null
}

active_upstream_unchanged() {
  [[ $(grep -Fxc "$active_upstream" "$nginx_file") -eq 1 ]]
  [[ $(grep -Fxc '    server 127.0.0.1:13000;' "$nginx_file") -eq 0 ]]
}

prune_superseded_project_images() {
  local image

  docker image prune -f \
    --filter label=com.docker.compose.project=fai-control-plane-mvp >/dev/null
  while IFS= read -r image; do
    [[ "$image" == "fai-control-plane-mvp:$release_commit" ]] && continue
    docker image rm "$image" >/dev/null 2>&1 || true
  done < <(docker image ls fai-control-plane-mvp --format '{{.Repository}}:{{.Tag}}')
}

wait_for_candidate_health() {
  local deadline=$1
  shift
  local all_healthy container_id health remaining service status

  while (( SECONDS < deadline )); do
    all_healthy=1
    for service in "$@"; do
      container_id=$("${compose[@]}" ps --all -q "$service" 2>/dev/null || true)
      [[ -n "$container_id" ]] || return 1
      read -r status health < <(docker inspect --format \
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
        "$container_id" 2>/dev/null || true) || true
      case "$status" in
        exited|dead|'') return 1 ;;
        running) ;;
        *) return 1 ;;
      esac
      case "$health" in
        healthy) ;;
        unhealthy|missing|'') return 1 ;;
        starting) all_healthy=0 ;;
        *) return 1 ;;
      esac
    done
    if (( all_healthy )); then return 0; fi
    remaining=$((deadline - SECONDS))
    (( remaining > 0 )) || return 1
    if (( remaining < 5 )); then sleep "$remaining"; else sleep 5; fi
  done
  return 1
}

normalize_checkout_modes() {
  local directory mode path record

  chmod 0755 "$deploy_root"
  while IFS= read -r -d '' record; do
    mode=${record%% *}
    path=${record#*$'\t'}
    [[ "$mode" == 100644 || "$mode" == 100755 ]] ||
      fail "unsupported tracked file mode: $mode"
    [[ -f "$deploy_root/$path" && ! -L "$deploy_root/$path" ]] ||
      fail "tracked path is not a regular file: $path"
    chmod 0644 -- "$deploy_root/$path"
    directory=$(dirname "$path")
    while [[ "$directory" != . ]]; do
      chmod 0755 -- "$deploy_root/$directory"
      directory=$(dirname "$directory")
    done
    if [[ "$mode" == 100755 ]]; then chmod 0755 -- "$deploy_root/$path"; fi
  done < <(git ls-files --stage -z)
  [[ -z $(git status --porcelain) ]] || fail 'checkout mode normalization changed tracked Git state'
}

prepare_project_runtime_root() {
  [[ ! -L "$project_runtime_root" ]] || fail 'project runtime root must not be a symlink'
  install -d -o 10000 -g 10000 -m 0700 -- "$project_runtime_root"
  [[ -d "$project_runtime_root" && ! -L "$project_runtime_root" ]] ||
    fail 'project runtime root is not a directory'
  [[ $(stat -c '%u:%g:%a' "$project_runtime_root") == 10000:10000:700 ]] ||
    fail 'project runtime root owner or mode is invalid'
}

render_target_environment() {
  local release_count bitrix_count
  release_count=$(grep -Ec '^FCP_RELEASE_COMMIT=' "$environment_file")
  bitrix_count=$(grep -Ec '^BITRIX24_CLIENT_ACTIONS_ENABLED=' "$environment_file" || true)
  [[ "$release_count" -eq 1 ]] || fail 'production environment must contain one release commit'
  [[ "$bitrix_count" -le 1 ]] || fail 'production environment contains duplicate Bitrix gates'
  awk -v release="$release_commit" '
    /^FCP_RELEASE_COMMIT=/ { print "FCP_RELEASE_COMMIT=" release; next }
    /^BITRIX24_CLIENT_ACTIONS_ENABLED=/ {
      print "BITRIX24_CLIENT_ACTIONS_ENABLED=false"; bitrix = 1; next
    }
    { print }
    END { if (!bitrix) print "BITRIX24_CLIENT_ACTIONS_ENABLED=false" }
  ' "$environment_file"
}

check_host_contract() {
  local remote_main secret_name secret_path source
  local -a current_compose
  [[ $(git rev-parse --show-toplevel) == "$deploy_root" ]] || fail 'checkout is not the isolated MVP directory'
  [[ -z $(git status --porcelain) ]] || fail 'checkout is not clean'
  [[ $(git remote get-url origin) == "$repository" ]] || fail 'origin is not the approved repository'
  source=$(release_source)
  remote_main=$(git ls-remote --exit-code "$source" refs/heads/main | awk 'NR == 1 { print $1 }')
  [[ "$remote_main" == "$release_commit" ]] || fail 'release commit is not exact origin/main'
  [[ -f "$environment_file" && ! -L "$environment_file" && -r "$environment_file" ]] ||
    fail 'production environment file is missing or not a regular file'
  [[ $(stat -c '%U:%G:%a' "$environment_file") == root:root:600 ]] ||
    fail 'production environment must be root:root mode 0600'
  if grep -Eq '^[A-Z0-9_]+=(REQUIRED_.*|REPLACE_.*)?$' "$environment_file"; then
    fail 'production environment contains an empty or placeholder value'
  fi
  for secret_name in "${secret_names[@]}"; do
    secret_path="$secret_root/$secret_name"
    [[ -f "$secret_path" && ! -L "$secret_path" && -s "$secret_path" && -r "$secret_path" ]] ||
      fail "missing or invalid secret file: $secret_path"
    [[ $(stat -c '%U:%G:%a' "$secret_path") == root:root:600 ]] ||
      fail "secret file must be root:root mode 0600: $secret_path"
  done
  [[ $(docker network inspect --format '{{.Driver}}:{{.Internal}}' \
    "$hermes_management_network" 2>/dev/null) == bridge:true ]] ||
    fail 'Hermes management network is missing or is not an internal bridge'
  current_compose=(docker compose --project-name fai-control-plane-mvp --env-file "$environment_file" -f "$compose_file")
  FCP_PROJECT_HERMES_IMAGE_ID="$project_runtime_config_placeholder" \
    "${current_compose[@]}" config --quiet
  protected_health || fail 'protected-neighbour health check failed'
  active_mvp_health || fail 'active isolated MVP health check failed'
  active_upstream_unchanged || fail 'app.f-ai.studio is not exclusively routed to 13010'
}

target_config_digest() {
  render_target_environment | sha256sum | cut -d ' ' -f 1
}

run_preflight() {
  local digest
  check_host_contract
  digest=$(target_config_digest)
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail 'could not calculate resulting config digest'
  if [[ -n "${FCP_APPROVED_CONFIG_SHA256:-}" ]]; then
    [[ "$FCP_APPROVED_CONFIG_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'approved config digest is invalid'
    [[ "$digest" == "$FCP_APPROVED_CONFIG_SHA256" ]] || fail 'resulting config digest is not approved'
  fi
  printf 'deploy-prod: resulting_config_sha256=%s\n' "$digest"
  printf 'deploy-prod: preflight complete for %s\n' "$release_commit"
}

if [[ "$action" == preflight ]]; then
  run_preflight
  exit 0
fi

[[ "${FCP_APPROVED_RELEASE_COMMIT:-}" == "$release_commit" ]] ||
  fail 'exact release approval is missing or mismatched'
[[ "${FCP_APPROVED_CONFIG_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'approved config digest is missing or invalid'

run_preflight

log 'deploy: fetching exact origin/main'
release_source=$(release_source)
git fetch --no-tags "$release_source" refs/heads/main:refs/remotes/origin/main
[[ $(git rev-parse refs/remotes/origin/main) == "$release_commit" ]] || fail 'fetched origin/main changed'
git merge-base --is-ancestor HEAD "$release_commit" || fail 'release is not a fast-forward'
if [[ $(git rev-parse HEAD) != "$release_commit" ]]; then
  git merge --ff-only "$release_commit"
  [[ $(git rev-parse HEAD) == "$release_commit" ]] || fail 'checkout did not advance to release'
  exec env \
    FCP_APPROVED_RELEASE_COMMIT="$FCP_APPROVED_RELEASE_COMMIT" \
    FCP_APPROVED_CONFIG_SHA256="$FCP_APPROVED_CONFIG_SHA256" \
    "$deploy_root/scripts/deploy-prod.sh" deploy "$release_commit"
fi

normalize_checkout_modes
[[ $(target_config_digest) == "$FCP_APPROVED_CONFIG_SHA256" ]] || fail 'resulting config digest changed'

temporary_environment=$(mktemp /etc/fai-control-plane-mvp/production.env.XXXXXX)
trap 'rm -f "$temporary_environment"' EXIT
render_target_environment >"$temporary_environment"
chown root:root "$temporary_environment"
chmod 0600 "$temporary_environment"
[[ $(sha256sum "$temporary_environment" | cut -d ' ' -f 1) == "$FCP_APPROVED_CONFIG_SHA256" ]] ||
  fail 'rendered production environment digest changed'
[[ $(grep -Fxc "FCP_RELEASE_COMMIT=$release_commit" "$temporary_environment") -eq 1 ]] ||
  fail 'rendered release commit is incorrect'
[[ $(grep -Fxc 'BITRIX24_CLIENT_ACTIONS_ENABLED=false' "$temporary_environment") -eq 1 ]] ||
  fail 'Bitrix client actions must remain disabled'

candidate_compose=(docker compose --project-name fai-control-plane-mvp --env-file "$temporary_environment" -f "$compose_file")
FCP_PROJECT_HERMES_IMAGE_ID="$project_runtime_config_placeholder" \
  "${candidate_compose[@]}" config --quiet
log 'deploy: building exact generic project runtime image'
docker build --pull --tag "$project_runtime_image" \
  --file "$deploy_root/infra/hermes-project/Dockerfile" "$deploy_root"
project_runtime_image_id=$(docker image inspect --format '{{.Id}}' "$project_runtime_image")
[[ "$project_runtime_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail 'generic project runtime image ID is invalid'
export FCP_PROJECT_HERMES_IMAGE_ID="$project_runtime_image_id"
log 'deploy: building exact application images'
"${candidate_compose[@]}" build web

mv -f "$temporary_environment" "$environment_file"
trap - EXIT
compose=(docker compose --project-name fai-control-plane-mvp --env-file "$environment_file" -f "$compose_file")
"${compose[@]}" config --quiet
prepare_project_runtime_root

log 'deploy: ensuring isolated PostgreSQL is healthy'
"${compose[@]}" up -d postgres
candidate_health_deadline=$((SECONDS + 180))
wait_for_candidate_health "$candidate_health_deadline" postgres ||
  fail 'PostgreSQL did not become healthy within 180 seconds'
log 'deploy: applying migrations'
"${compose[@]}" run --rm migrate || fail 'migrations failed'
log 'deploy: bootstrapping idempotent data'
"${compose[@]}" --profile bootstrap run --rm --no-deps bootstrap || fail 'bootstrap failed'
log 'deploy: replacing only isolated MVP web and worker'
"${compose[@]}" up -d --no-deps web worker
wait_for_candidate_health "$candidate_health_deadline" postgres web worker ||
  fail 'PostgreSQL, web and worker did not become healthy within 180 seconds'

for service in web worker; do
  container_id=$("${compose[@]}" ps -q "$service")
  [[ $(docker inspect --format '{{.Config.Image}}' "$container_id") == "fai-control-plane-mvp:$release_commit" ]] ||
    fail "$service is not running the approved image"
done
curl -fsS --max-time 10 http://127.0.0.1:13010/api/health >/dev/null
curl -fsS --max-time 10 http://127.0.0.1:13010/api/ready >/dev/null
curl -fsS --max-time 15 https://app.f-ai.studio/api/ready >/dev/null
curl -fsS --max-time 15 https://app.f-ai.studio/ >/dev/null
protected_health || fail 'protected-neighbour health changed'
active_upstream_unchanged || fail 'Nginx routing changed during deploy'
log 'deploy: removing superseded project images'
prune_superseded_project_images
printf 'deploy-prod: deploy complete for %s config %s\n' \
  "$release_commit" "$FCP_APPROVED_CONFIG_SHA256"
