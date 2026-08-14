#!/usr/bin/env bash
set -euo pipefail

readonly deploy_root=/opt/fai-control-plane-mvp
readonly environment_file=/etc/fai-control-plane-mvp/production.env
readonly compose_file="$deploy_root/infra/production/compose.yaml"
readonly nginx_file=/etc/nginx/sites-available/app.f-ai.studio.conf
readonly old_upstream='    server 127.0.0.1:13000;'
readonly new_upstream='    server 127.0.0.1:13010;'
readonly rollback_image='fai-control-plane:63cc41832bb216edfa5c29e270ce1394f45d9231'

usage() {
  printf '%s\n' \
    'usage: FCP_APPROVED_RELEASE_COMMIT=<40-hex> scripts/deploy-prod.sh rollback <40-hex>' \
    '   or: FCP_APPROVED_RELEASE_COMMIT=<40-hex> FCP_APPROVED_CONFIG_SHA256=<64-hex> scripts/deploy-prod.sh <stage|activate> <40-hex>' \
    'This command mutates production only after Vladimir approves the exact commit and host diff.' >&2
  exit 64
}

fail() {
  printf 'deploy-prod: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 2 ]] || usage
readonly action=$1
readonly release_commit=$2
[[ "$action" == stage || "$action" == activate || "$action" == rollback ]] || usage
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'release commit must be lowercase 40-hex'
[[ "${FCP_APPROVED_RELEASE_COMMIT:-}" == "$release_commit" ]] || fail 'exact release approval is missing or mismatched'
[[ $EUID -eq 0 ]] || fail 'must run as root on the approved host'

readonly repository_root=$(git rev-parse --show-toplevel)
[[ "$repository_root" == "$deploy_root" ]] || fail 'checkout is not the isolated MVP directory'
[[ $(git rev-parse HEAD) == "$release_commit" ]] || fail 'checkout does not match approved release'
[[ -z $(git status --porcelain) ]] || fail 'checkout is not clean'

readonly secret_root=/etc/fai-control-plane-mvp/secrets
readonly secret_names=(
  postgres-password github-login-client-secret github-projects-token github-webhook-secret
  hermes-token telegram-bot-token hermes-internal-action-token hermes-client-action-token
)
protected_health() {
  systemctl is-active --quiet myshopai-website.service
  systemctl is-active --quiet fai-content-platform.service
  systemctl is-active --quiet fai-hermes-runner.service
  systemctl is-active --quiet fai-codex-executor.service
  systemctl is-active --quiet hermes-gateway.service
  [[ $(docker inspect --format '{{.State.Status}}' amnezia-awg2) == running ]]
  [[ $(docker inspect --format '{{.State.Health.Status}}' fai-control-plane-production-web-1) == healthy ]]
  [[ $(docker inspect --format '{{.Config.Image}}' fai-control-plane-production-web-1) == "$rollback_image" ]]
}

wait_for_candidate_health() {
  local deadline=$1
  shift
  local all_healthy
  local container_id
  local health
  local remaining
  local service
  local status

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
    (( all_healthy )) && return 0
    remaining=$((deadline - SECONDS))
    (( remaining > 0 )) || return 1
    if (( remaining < 5 )); then sleep "$remaining"; else sleep 5; fi
  done
  return 1
}

candidate_listener_absent() {
  command -v ss >/dev/null 2>&1 || return 1
  ! ss -H -ltn 'sport = :13010' | grep -q .
}

protected_health || fail 'protected-neighbour or rollback health check failed'

if [[ "$action" != rollback ]]; then
  [[ "${FCP_APPROVED_CONFIG_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || fail 'approved config digest is missing or invalid'
  [[ -r "$environment_file" ]] || fail 'production environment file is missing'
  [[ $(stat -c '%U:%G:%a' "$environment_file") == root:root:600 ]] ||
    fail 'production environment must be root:root mode 0600'
  [[ $(sha256sum "$environment_file" | cut -d ' ' -f 1) == "$FCP_APPROVED_CONFIG_SHA256" ]] ||
    fail 'production environment does not match the approved digest'
  mapfile -t configured_releases < <(sed -n 's/^FCP_RELEASE_COMMIT=//p' "$environment_file")
  [[ ${#configured_releases[@]} -eq 1 && "${configured_releases[0]}" == "$release_commit" ]] ||
    fail 'environment release does not match approved release'
  mapfile -t configured_env_files < <(sed -n 's/^FCP_RUNTIME_ENV_FILE=//p' "$environment_file")
  [[ ${#configured_env_files[@]} -eq 1 && "${configured_env_files[0]}" == "$environment_file" ]] ||
    fail 'runtime environment file is not the isolated production file'
  if grep -Eq '^[A-Z0-9_]+=(REQUIRED_.*|REPLACE_.*)?$' "$environment_file"; then
    fail 'production environment contains an empty or placeholder value'
  fi
  for secret_name in "${secret_names[@]}"; do
    secret_path="$secret_root/$secret_name"
    [[ -f "$secret_path" && -r "$secret_path" ]] || fail "missing secret file: $secret_path"
    [[ $(stat -c '%U:%G:%a' "$secret_path") == root:root:600 ]] ||
      fail "secret file must be root:root mode 0600: $secret_path"
  done
  compose=(docker compose --project-name fai-control-plane-mvp --env-file "$environment_file" -f "$compose_file")
  "${compose[@]}" config --quiet
fi

stage_cleanup_required=0
stage_exit_cleanup() {
  local status=$?
  if (( stage_cleanup_required )); then
    if ! "${compose[@]}" down >/dev/null 2>&1; then
      printf 'deploy-prod: automatic isolated-candidate cleanup failed\n' >&2
      status=1
    fi
    if ! candidate_listener_absent; then
      printf 'deploy-prod: candidate listener 13010 remains after cleanup\n' >&2
      status=1
    fi
  fi
  trap - EXIT
  exit "$status"
}
trap stage_exit_cleanup EXIT

switch_upstream() {
  local from=$1
  local to=$2
  local temporary
  [[ $(grep -Fxc "$from" "$nginx_file") -eq 1 ]] || fail 'unexpected current app upstream'
  [[ $(grep -Fxc "$to" "$nginx_file") -eq 0 ]] || fail 'target app upstream already occurs in config'
  temporary=$(mktemp /etc/nginx/sites-available/app.f-ai.studio.conf.XXXXXX)
  if ! awk -v from="$from" -v to="$to" '
    $0 == from { print to; replaced += 1; next }
    { print }
    END { if (replaced != 1) exit 42 }
  ' "$nginx_file" > "$temporary"; then
    rm -f "$temporary"
    fail 'exact app upstream replacement failed'
  fi
  install -o root -g root -m 0644 "$temporary" "$nginx_file"
  if ! nginx -t; then
    awk -v from="$to" -v to="$from" '$0 == from { print to; next } { print }' "$nginx_file" > "$temporary"
    install -o root -g root -m 0644 "$temporary" "$nginx_file"
    rm -f "$temporary"
    fail 'Nginx validation failed; original upstream restored'
  fi
  if ! systemctl reload nginx; then
    awk -v from="$to" -v to="$from" '$0 == from { print to; next } { print }' "$nginx_file" > "$temporary"
    install -o root -g root -m 0644 "$temporary" "$nginx_file"
    nginx -t && systemctl reload nginx || true
    rm -f "$temporary"
    fail 'Nginx reload failed; original upstream restored'
  fi
  rm -f "$temporary"
}

case "$action" in
  stage)
    stage_cleanup_required=1
    "${compose[@]}" build web worker migrate bootstrap
    "${compose[@]}" up -d postgres
    candidate_health_deadline=$((SECONDS + 180))
    wait_for_candidate_health "$candidate_health_deadline" postgres ||
      fail 'candidate postgres did not become healthy within 180 seconds'
    "${compose[@]}" run --rm migrate
    "${compose[@]}" --profile bootstrap run --rm --no-deps bootstrap
    "${compose[@]}" up -d --no-deps web worker
    wait_for_candidate_health "$candidate_health_deadline" postgres web worker ||
      fail 'candidate postgres, web and worker did not become healthy within 180 seconds'
    "${compose[@]}" ps
    curl -fsS --max-time 10 http://127.0.0.1:13010/api/health >/dev/null
    ;;
  activate)
    curl -fsS --max-time 10 http://127.0.0.1:13010/api/ready >/dev/null
    "${compose[@]}" exec -T worker node -e \
      "fetch('http://127.0.0.1:3001/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
    switch_upstream "$old_upstream" "$new_upstream"
    curl -fsS --max-time 10 http://127.0.0.1:13010/api/ready >/dev/null
    if ! curl -fsS --max-time 15 https://app.f-ai.studio/api/ready >/dev/null; then
      switch_upstream "$new_upstream" "$old_upstream"
      fail 'public smoke failed; old upstream restored'
    fi
    ;;
  rollback)
    curl -fsS --max-time 10 http://127.0.0.1:13000/api/ready >/dev/null
    old_count=$(grep -Fxc "$old_upstream" "$nginx_file" || true)
    new_count=$(grep -Fxc "$new_upstream" "$nginx_file" || true)
    if [[ $old_count -eq 0 && $new_count -eq 1 ]]; then
      switch_upstream "$new_upstream" "$old_upstream"
    elif [[ $old_count -ne 1 || $new_count -ne 0 ]]; then
      fail 'unexpected current app upstream'
    fi
    curl -fsS --max-time 10 http://127.0.0.1:13000/api/ready >/dev/null
    curl -fsS --max-time 15 https://app.f-ai.studio/api/ready >/dev/null
    mapfile -t candidate_apps < <(docker ps --filter label=com.docker.compose.project=fai-control-plane-mvp \
      --filter status=running --format '{{.Names}}' | grep -E -- '-(web|worker)-[0-9]+$' || true)
    if [[ ${#candidate_apps[@]} -gt 0 ]]; then docker stop "${candidate_apps[@]}" >/dev/null; fi
    ;;
esac

protected_health || fail 'protected-neighbour or rollback health changed'
if [[ "$action" == stage ]]; then stage_cleanup_required=0; fi
printf 'deploy-prod: %s complete for %s\n' "$action" "$release_commit"
