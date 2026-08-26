#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

readonly deploy_root=/opt/fai-hermes-ascon
readonly environment_file=/etc/fai-hermes-ascon/production.env
readonly compose_file="$deploy_root/infra/hermes-ascon/compose.yaml"
readonly nginx_source="$deploy_root/infra/hermes-ascon/nginx/hermes-ascon.f-ai.studio.conf"
readonly nginx_file=/etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf
readonly nginx_enabled=/etc/nginx/sites-enabled/hermes-ascon.f-ai.studio.conf
readonly api_secret_file=/etc/fai-hermes-ascon/secrets/api-server.env
readonly telegram_secret_file=/etc/fai-hermes-ascon/secrets/telegram.env
readonly internal_bridge_token=/etc/fai-hermes-ascon/secrets/internal-bridge-token
readonly data_root=/var/lib/fai-hermes-ascon
readonly runtime_config_file="$data_root/runtime-config.yaml"
readonly work_directory="$data_root/work"
readonly project_work_directory="$work_directory/project"
readonly codex_root=/var/lib/fai-codex-ascon
readonly codex_home="$codex_root/home"
readonly legacy_codex_home="$data_root/codex-home"
readonly readiness_directory="$data_root/readiness"
readonly readiness_file="$readiness_directory/codex-cli.json"
readonly github_repository_token=/etc/fai-hermes-ascon/secrets/github-repository-token
readonly dashboard_username=/etc/fai-hermes-ascon/secrets/dashboard-username
readonly dashboard_password=/etc/fai-hermes-ascon/secrets/dashboard-password
readonly dashboard_signing_secret=/etc/fai-hermes-ascon/secrets/dashboard-signing-secret
readonly devops_ssh_identity=/etc/fai-hermes-ascon/secrets/devops-ssh-identity
readonly devops_ssh_known_hosts=/etc/fai-hermes-ascon/secrets/devops-ssh-known-hosts
readonly devops_yc_config=/etc/fai-hermes-ascon/secrets/yandex-cloud-config.yaml
readonly runtime_secret_directory="$data_root/runtime-secrets"
readonly runtime_yc_config_directory="$data_root/.config/yandex-cloud"
readonly runtime_internal_bridge_token="$runtime_secret_directory/internal-bridge-token"
readonly runtime_github_repository_token="$runtime_secret_directory/github-repository-token"
readonly runtime_dashboard_username="$runtime_secret_directory/dashboard-username"
readonly runtime_dashboard_password="$runtime_secret_directory/dashboard-password"
readonly runtime_dashboard_signing_secret="$runtime_secret_directory/dashboard-signing-secret"
readonly runtime_devops_ssh_identity="$runtime_secret_directory/devops-ssh-identity"
readonly runtime_devops_ssh_known_hosts="$runtime_secret_directory/devops-ssh-known-hosts"
readonly runtime_devops_yc_config="$runtime_secret_directory/yandex-cloud-config.yaml"
readonly gateway_pid_file="$data_root/gateway.pid"
readonly project=fai-hermes-ascon
readonly workload_uid=10000
readonly workload_gid=10000
readonly derived_image=fai-hermes-ascon:codex-0.144.1
readonly upstream_image=nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6
readonly codex_version=0.144.1
readonly codex_contract=fai.hermes-codex-readiness.v1

readonly -a readable_directories=(
  "$deploy_root/infra/hermes-ascon/extensions/fai-control-plane"
  "$deploy_root/infra/hermes-ascon/extensions/fai-identity"
)
readonly -a readable_files=(
  "$deploy_root/infra/hermes-ascon/config.yaml"
  "$deploy_root/infra/hermes-ascon/profiles/internal/config.yaml"
  "$deploy_root/infra/hermes-ascon/extensions/fai-control-plane/plugin.yaml"
  "$deploy_root/infra/hermes-ascon/extensions/fai-control-plane/bridge_state.py"
  "$deploy_root/infra/hermes-ascon/extensions/fai-control-plane/__init__.py"
  "$deploy_root/infra/hermes-ascon/extensions/fai-identity/HOOK.yaml"
  "$deploy_root/infra/hermes-ascon/extensions/fai-identity/handler.py"
  "$deploy_root/infra/hermes-ascon/native-entrypoint.sh"
  "$deploy_root/infra/hermes-ascon/management-entrypoint.sh"
  "$deploy_root/infra/hermes-ascon/Dockerfile"
)

fail() {
  printf 'deploy-hermes-ascon: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 && ( $1 == auth || $1 == codex-auth || $1 == stage || $1 == rollback ) ]] ||
  fail 'usage: deploy-hermes-ascon.sh <auth|codex-auth|stage|rollback>'
readonly action=$1

[[ $EUID -eq 0 ]] || fail 'must run as root on the approved host'
[[ $(git rev-parse --show-toplevel) == "$deploy_root" ]] ||
  fail 'checkout is not the isolated ASCON Hermes directory'
rm -f "$readiness_file"
[[ -z $(git status --porcelain) ]] || fail 'checkout is not clean'
[[ "${HERMES_APPROVED_IMAGE:-}" == "$upstream_image" ]] ||
  fail 'exact approved upstream image is missing'
[[ "${HERMES_APPROVED_CONFIG_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'approved config digest is missing or invalid'

for path in "$environment_file" "$api_secret_file" "$telegram_secret_file" \
  "$internal_bridge_token" "$github_repository_token" \
  "$dashboard_username" "$dashboard_password" "$dashboard_signing_secret" \
  "$devops_ssh_identity" "$devops_ssh_known_hosts" "$devops_yc_config"; do
  [[ -f "$path" && -r "$path" ]] || fail "missing required file: $path"
  [[ $(stat -c '%U:%G:%a' "$path") == root:root:600 ]] ||
    fail "file must be root:root mode 0600: $path"
done

[[ $(sed -n 's/^HERMES_INTERNAL_BRIDGE_TOKEN_FILE=//p' "$environment_file") == \
  "$runtime_internal_bridge_token" ]] ||
  fail 'internal bridge token must use the isolated runtime copy'
[[ $(sed -n 's/^HERMES_RENDERED_CONFIG_FILE=//p' "$environment_file") == \
  "$runtime_config_file" ]] ||
  fail 'Hermes must use the isolated rendered config'
readonly hermes_model=$(sed -n 's/^HERMES_MODEL=//p' "$environment_file")
[[ "$hermes_model" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] ||
  fail 'Hermes model is invalid'
[[ $(sed -n 's/^HERMES_GITHUB_REPOSITORY_TOKEN_FILE=//p' "$environment_file") == \
  "$runtime_github_repository_token" ]] || fail 'repository token must use the isolated runtime copy'
[[ $(sed -n 's/^HERMES_DASHBOARD_USERNAME_HOST_FILE=//p' "$environment_file") == \
  "$dashboard_username" ]] || fail 'dashboard username canonical source is invalid'
[[ $(sed -n 's/^HERMES_DASHBOARD_PASSWORD_HOST_FILE=//p' "$environment_file") == \
  "$dashboard_password" ]] || fail 'dashboard password canonical source is invalid'
[[ $(sed -n 's/^HERMES_DASHBOARD_SIGNING_SECRET_HOST_FILE=//p' "$environment_file") == \
  "$dashboard_signing_secret" ]] || fail 'dashboard signing secret canonical source is invalid'
[[ $(sed -n 's/^HERMES_DEVOPS_SSH_IDENTITY_HOST_FILE=//p' "$environment_file") == \
  "$devops_ssh_identity" ]] || fail 'DevOps SSH identity canonical source is invalid'
[[ $(sed -n 's/^HERMES_DEVOPS_SSH_KNOWN_HOSTS_HOST_FILE=//p' "$environment_file") == \
  "$devops_ssh_known_hosts" ]] || fail 'DevOps known_hosts canonical source is invalid'
[[ $(sed -n 's/^HERMES_DEVOPS_YC_CONFIG_HOST_FILE=//p' "$environment_file") == \
  "$devops_yc_config" ]] || fail 'DevOps Yandex Cloud config canonical source is invalid'
[[ $(sed -n 's/^HERMES_DASHBOARD_USERNAME_FILE=//p' "$environment_file") == \
  "$runtime_dashboard_username" ]] || fail 'dashboard username must use its runtime copy'
[[ $(sed -n 's/^HERMES_DASHBOARD_PASSWORD_FILE=//p' "$environment_file") == \
  "$runtime_dashboard_password" ]] || fail 'dashboard password must use its runtime copy'
[[ $(sed -n 's/^HERMES_DASHBOARD_SIGNING_SECRET_FILE=//p' "$environment_file") == \
  "$runtime_dashboard_signing_secret" ]] || fail 'dashboard signing secret must use its runtime copy'
[[ $(sed -n 's/^HERMES_DEVOPS_SSH_IDENTITY_FILE=//p' "$environment_file") == \
  "$runtime_devops_ssh_identity" ]] || fail 'DevOps SSH identity must use its runtime copy'
[[ $(sed -n 's/^HERMES_DEVOPS_SSH_KNOWN_HOSTS_FILE=//p' "$environment_file") == \
  "$runtime_devops_ssh_known_hosts" ]] || fail 'DevOps known_hosts must use its runtime copy'
[[ $(sed -n 's/^HERMES_DEVOPS_YC_CONFIG_FILE=//p' "$environment_file") == \
  "$runtime_devops_yc_config" ]] || fail 'DevOps Yandex Cloud config must use its runtime copy'

[[ $(sha256sum "$environment_file" | cut -d ' ' -f 1) == "$HERMES_APPROVED_CONFIG_SHA256" ]] ||
  fail 'production environment does not match approved digest'
grep -Eq '^HERMES_IMAGE=' "$environment_file" ||
  fail 'configured image is missing'
[[ $(sed -n 's/^HERMES_IMAGE=//p' "$environment_file") == "$derived_image" ]] ||
  fail 'configured derived image is invalid'
[[ $(sed -n 's/^ARG HERMES_UPSTREAM_IMAGE=//p' \
  "$deploy_root/infra/hermes-ascon/Dockerfile") == "$HERMES_APPROVED_IMAGE" ]] ||
  fail 'Dockerfile upstream image is not approved'
grep -Eq '^[A-Z0-9_]+=(REQUIRED_.*|REPLACE_.*)?$' "$environment_file" &&
  fail 'production environment contains a placeholder'
[[ $(wc -l < "$api_secret_file") -eq 1 && $(grep -Ec '^API_SERVER_KEY=[^[:space:]]+$' "$api_secret_file") -eq 1 ]] ||
  fail 'API secret file must contain only one non-empty API_SERVER_KEY'
[[ $(wc -l < "$telegram_secret_file") -eq 1 && $(grep -Ec '^TELEGRAM_BOT_TOKEN=[^[:space:]]+$' "$telegram_secret_file") -eq 1 ]] ||
  fail 'Telegram secret file must contain only one non-empty TELEGRAM_BOT_TOKEN'
for path in "$internal_bridge_token"; do
  token_length=$(wc -c < "$path")
  (( token_length >= 33 && token_length <= 513 )) || fail "invalid bridge token length: $path"
done
dashboard_username_length=$(wc -c < "$dashboard_username")
dashboard_password_length=$(wc -c < "$dashboard_password")
dashboard_signing_secret_length=$(wc -c < "$dashboard_signing_secret")
ssh_identity_length=$(wc -c < "$devops_ssh_identity")
ssh_known_hosts_length=$(wc -c < "$devops_ssh_known_hosts")
yc_config_length=$(wc -c < "$devops_yc_config")
(( dashboard_username_length >= 1 && dashboard_username_length <= 129 )) || fail 'invalid dashboard username length'
(( dashboard_password_length >= 20 && dashboard_password_length <= 513 )) || fail 'invalid dashboard password length'
(( dashboard_signing_secret_length >= 32 && dashboard_signing_secret_length <= 513 )) || fail 'invalid dashboard signing secret length'
(( ssh_identity_length >= 100 && ssh_identity_length <= 16384 )) || fail 'invalid DevOps SSH identity length'
(( ssh_known_hosts_length >= 1 && ssh_known_hosts_length <= 65536 )) || fail 'invalid DevOps known_hosts length'
(( yc_config_length >= 2 && yc_config_length <= 65536 )) || fail 'invalid DevOps Yandex Cloud config length'
ssh-keygen -y -f "$devops_ssh_identity" >/dev/null 2>&1 || fail 'DevOps SSH identity is invalid'

for path in \
  "$deploy_root/infra/hermes-ascon/config.yaml" \
  "$deploy_root/infra/hermes-ascon/profiles/internal/config.yaml"; do
  [[ $(grep -Fxc '_config_version: 34' "$path") -eq 1 ]] ||
    fail "Hermes config does not declare schema version 34: $path"
done

compose=(
  docker compose
  --project-name "$project"
  --env-file "$environment_file"
  -f "$compose_file"
)

remove_readiness() {
  rm -f "$readiness_file"
}

remove_runtime_secrets() {
  rm -f "$runtime_internal_bridge_token" \
    "$runtime_github_repository_token" "$runtime_dashboard_username" \
    "$runtime_dashboard_password" "$runtime_dashboard_signing_secret" \
    "$runtime_devops_ssh_identity" "$runtime_devops_ssh_known_hosts" \
    "$runtime_devops_yc_config"
}

ensure_management_network() {
  if ! docker network inspect fai-hermes-management >/dev/null 2>&1; then
    docker network create --driver bridge --internal fai-hermes-management >/dev/null
  fi
  [[ $(docker network inspect --format '{{.Driver}}:{{.Internal}}' fai-hermes-management) == \
    bridge:true ]] || fail 'Hermes management network must be an internal bridge'
}

render_runtime_config() {
  local rendered
  [[ $(grep -Foc '__HERMES_MODEL__' "$deploy_root/infra/hermes-ascon/config.yaml") -eq 1 ]] ||
    fail 'Hermes config template must contain exactly one model placeholder'
  rendered=$(mktemp)
  trap 'rm -f "$rendered"' RETURN
  sed "s/__HERMES_MODEL__/$hermes_model/" "$deploy_root/infra/hermes-ascon/config.yaml" >"$rendered"
  grep -Fq '__HERMES_MODEL__' "$rendered" && fail 'Hermes config model was not rendered'
  install -o root -g root -m 0644 "$rendered" "$runtime_config_file"
  trap - RETURN
  rm -f "$rendered"
}

prepare_runtime() {
  install -d -o "$workload_uid" -g "$workload_gid" -m 0755 "$data_root"
  render_runtime_config
  install -d -o root -g root -m 0755 "$readiness_directory"
  install -d -o "$workload_uid" -g "$workload_gid" -m 0700 \
    "$work_directory" "$project_work_directory" "$codex_root" "$codex_home" \
    "$runtime_secret_directory" "$runtime_yc_config_directory"
  if [[ ! -s "$codex_home/auth.json" && -s "$legacy_codex_home/auth.json" ]]; then
    install -o "$workload_uid" -g "$workload_gid" -m 0600 "$legacy_codex_home/auth.json" "$codex_home/auth.json"
  fi
  [[ $(stat -c '%u:%g:%a' "$data_root") == "$workload_uid:$workload_gid:755" ]] ||
    fail 'Hermes data root permissions are invalid'
  [[ $(stat -c '%u:%g:%a' "$runtime_secret_directory") == \
    "$workload_uid:$workload_gid:700" ]] || fail 'runtime secret directory permissions are invalid'

  chown root:root "${readable_directories[@]}" "${readable_files[@]}"
  chmod 0755 "${readable_directories[@]}"
  chmod 0644 "${readable_files[@]}"

  for path in "${readable_directories[@]}"; do
    [[ $(stat -c '%U:%G:%a' "$path") == root:root:755 ]] ||
      fail "non-secret directory permissions are invalid: $path"
  done
  for path in "${readable_files[@]}"; do
    [[ $(stat -c '%U:%G:%a' "$path") == root:root:644 ]] ||
      fail "non-secret file permissions are invalid: $path"
  done
  [[ $(stat -c '%u:%g:%a' "$work_directory") == \
    "$workload_uid:$workload_gid:700" ]] || fail 'work directory permissions are invalid'
  [[ $(stat -c '%u:%g:%a' "$project_work_directory") == \
    "$workload_uid:$workload_gid:700" ]] || fail 'project work directory permissions are invalid'
  [[ $(stat -c '%u:%g:%a' "$codex_home") == \
    "$workload_uid:$workload_gid:700" ]] || fail 'Codex home permissions are invalid'
  [[ $(stat -c '%U:%G:%a' "$readiness_directory") == root:root:755 ]] ||
    fail 'readiness directory permissions are invalid'

  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$internal_bridge_token" "$runtime_internal_bridge_token"
  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$github_repository_token" "$runtime_github_repository_token"
  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$dashboard_username" "$runtime_dashboard_username"
  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$dashboard_password" "$runtime_dashboard_password"
  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$dashboard_signing_secret" "$runtime_dashboard_signing_secret"
  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$devops_ssh_identity" "$runtime_devops_ssh_identity"
  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$devops_ssh_known_hosts" "$runtime_devops_ssh_known_hosts"
  install -o "$workload_uid" -g "$workload_gid" -m 0600 \
    "$devops_yc_config" "$runtime_devops_yc_config"
  cmp -s "$internal_bridge_token" "$runtime_internal_bridge_token" ||
    fail 'internal runtime bridge token copy differs from its canonical source'
  cmp -s "$github_repository_token" "$runtime_github_repository_token" ||
    fail 'repository runtime token copy differs from its canonical source'
  for pair in \
    "$dashboard_username:$runtime_dashboard_username" \
    "$dashboard_password:$runtime_dashboard_password" \
    "$dashboard_signing_secret:$runtime_dashboard_signing_secret" \
    "$devops_ssh_identity:$runtime_devops_ssh_identity" \
    "$devops_ssh_known_hosts:$runtime_devops_ssh_known_hosts" \
    "$devops_yc_config:$runtime_devops_yc_config"; do
    canonical=${pair%%:*}
    runtime=${pair#*:}
    cmp -s "$canonical" "$runtime" || fail "runtime secret copy differs from its canonical source: $canonical"
  done
  for path in "$runtime_internal_bridge_token" \
    "$runtime_github_repository_token" "$runtime_dashboard_username" \
    "$runtime_dashboard_password" "$runtime_dashboard_signing_secret" \
    "$runtime_devops_ssh_identity" "$runtime_devops_ssh_known_hosts" \
    "$runtime_devops_yc_config"; do
    [[ $(stat -c '%u:%g:%a' "$path") == "$workload_uid:$workload_gid:600" ]] ||
      fail "runtime bridge token permissions are invalid: $path"
  done
}

quiet_checked() {
  local label=$1
  shift
  local output
  output=$(mktemp)
  if ! "$@" >"$output" 2>&1; then
    rm -f "$output"
    fail "$label failed; output withheld because it may contain authentication data"
  fi
  if grep -Eiq \
    'permission denied|fall(ing)? back.{0,40}(default|config)|pre-v12|config(uration)?.{0,40}migrat' \
    "$output"; then
    rm -f "$output"
    fail "$label reported a config permission, fallback, or schema warning"
  fi
  rm -f "$output"
}

probe_runtime() {
  quiet_checked 'UID-10000 runtime probe' \
    "${compose[@]}" run --rm --no-deps --user "$workload_uid:$workload_gid" \
      --entrypoint python gateway -c '
from pathlib import Path

readable = (
    "/opt/data/config.yaml",
    "/opt/data/profiles/internal/config.yaml",
    "/opt/data/plugins/fai-control-plane/plugin.yaml",
    "/opt/data/plugins/fai-control-plane/bridge_state.py",
    "/opt/data/plugins/fai-control-plane/__init__.py",
    "/opt/data/hooks/fai-identity/HOOK.yaml",
    "/opt/data/hooks/fai-identity/handler.py",
    "/opt/data/profiles/internal/bridge-token",
    "/opt/fai-devops/ssh/identity",
    "/opt/fai-devops/ssh/known_hosts",
    "/opt/data/.config/yandex-cloud/config.yaml",
)
for name in readable:
    Path(name).read_bytes()
probe = Path("/opt/data/work/.uid-10000-write-probe")
probe.write_bytes(b"")
probe.unlink()
project_probe = Path("/opt/data/work/project/.uid-10000-write-probe")
project_probe.write_bytes(b"")
project_probe.unlink()
'
}

probe_codex_runtime() {
  quiet_checked 'isolated Codex UID-10000 runtime probe' \
    "${compose[@]}" run --rm --no-deps --entrypoint python codex-cli -c '
import os
from pathlib import Path

assert os.environ["CODEX_HOME"] == "/opt/data/codex-home"
assert Path.cwd() == Path("/opt/data/work/project")
for name in ("/opt/data/work/project", "/opt/data/codex-home"):
    probe = Path(name) / ".uid-10000-write-probe"
    probe.write_bytes(b"")
    probe.unlink()
'
}

verify_codex_runtime() {
  local actual_version
  actual_version=$("${compose[@]}" run --rm --no-deps codex-cli \
    --version 2>/dev/null) || fail 'Codex CLI version probe failed'
  [[ "$actual_version" == "codex-cli $codex_version" ]] ||
    fail 'Codex CLI version does not match the pinned runtime'
  quiet_checked 'Codex OAuth status preflight' \
    "${compose[@]}" run --rm --no-deps codex-cli login status
}

write_readiness() {
  local evidence_sha256 image_id payload temporary verified_at
  image_id=$(docker image inspect --format '{{.Id}}' "$derived_image" 2>/dev/null) ||
    fail 'derived Hermes image ID is unavailable'
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'derived Hermes image ID is invalid'
  verified_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  payload=$(printf '%s\n' "$codex_contract" "$upstream_image" "$codex_version" \
    /opt/data/codex-home /opt/data/work/project authenticated "$image_id" "$verified_at")
  evidence_sha256=$(printf '%s' "$payload" | sha256sum | cut -d ' ' -f 1)
  [[ "$evidence_sha256" =~ ^[a-f0-9]{64}$ ]] || fail 'readiness self-hash is invalid'
  temporary=$(mktemp "$readiness_directory/.codex-cli.json.XXXXXX")
  trap 'rm -f "$temporary"' RETURN
  printf '{"contract":"%s","upstreamImage":"%s","codexVersion":"%s","codexHome":"%s","workdir":"%s","loginStatus":"authenticated","imageId":"%s","verifiedAt":"%s","evidenceSha256":"%s"}\n' \
    "$codex_contract" "$upstream_image" "$codex_version" /opt/data/codex-home \
    /opt/data/work/project "$image_id" "$verified_at" "$evidence_sha256" >"$temporary"
  chown root:root "$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "$readiness_file"
  trap - RETURN
  [[ $(stat -c '%U:%G:%a' "$readiness_file") == root:root:644 ]] ||
    fail 'readiness evidence permissions are invalid'
}

verify_native_execution() {
  [[ -f "$github_repository_token" && ! -L "$github_repository_token" ]] ||
    fail 'project-scoped repository token is missing or unsafe'
  [[ $(stat -c '%U:%G:%a' "$github_repository_token") == root:root:600 ]] ||
    fail 'project-scoped repository token must be root:root mode 0600'
  local token_length
  token_length=$(wc -c < "$github_repository_token")
  (( token_length >= 21 && token_length <= 513 )) || fail 'project-scoped repository token is invalid'
  [[ -s "$codex_home/auth.json" ]] || fail 'isolated Codex OAuth is missing'
  [[ $(stat -c '%u:%g:%a' "$codex_home/auth.json") == "$workload_uid:$workload_gid:600" ]] ||
    fail 'isolated Codex OAuth permissions are invalid'
  quiet_checked 'project-scoped GitHub credential preflight' \
    "${compose[@]}" run --rm --no-deps gateway --exec gh auth status
  quiet_checked 'direct Hermes SSH configuration preflight' \
    "${compose[@]}" run --rm --no-deps gateway --exec ssh -G -F /dev/null \
      -o BatchMode=yes -o IdentitiesOnly=yes \
      -o IdentityFile=/opt/fai-devops/ssh/identity \
      -o UserKnownHostsFile=/opt/fai-devops/ssh/known_hosts \
      -p "$(sed -n 's/^HERMES_DEVOPS_SSH_PORT=//p' "$environment_file")" \
      "$(sed -n 's/^HERMES_DEVOPS_SSH_USER=//p' "$environment_file")@$(sed -n 's/^HERMES_DEVOPS_SSH_HOST=//p' "$environment_file")"
  quiet_checked 'direct Hermes Yandex Cloud CLI preflight' \
    "${compose[@]}" run --rm --no-deps gateway --exec yc config list
}

wait_for_service_health() {
  local service=$1
  local deadline=$((SECONDS + 180))
  local container_id
  local status
  while (( SECONDS < deadline )); do
    container_id=$("${compose[@]}" ps --all -q "$service" 2>/dev/null || true)
    status=''
    if [[ -n "$container_id" ]]; then
      status=$(docker inspect --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container_id" 2>/dev/null || true)
    fi
    case "$status" in
      healthy) return 0 ;;
      unhealthy|exited|dead) return 1 ;;
    esac
    sleep 5
  done
  return 1
}

prune_superseded_project_images() {
  if ! docker image prune -f \
    --filter label=com.docker.compose.project=fai-hermes-ascon >/dev/null; then
    printf 'deploy-hermes-ascon: warning: superseded project images were not removed\n' >&2
  fi
}

nginx_backup=''
nginx_candidate=''
nginx_switch_applied=0
run_status_response=''

restore_nginx_config() {
  (( nginx_switch_applied )) || return 0
  nginx_candidate=$(mktemp /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf.restore.XXXXXX)
  install -o root -g root -m 0644 "$nginx_backup" "$nginx_candidate"
  mv -f "$nginx_candidate" "$nginx_file"
  nginx_candidate=''
  nginx -t && systemctl reload nginx || return 1
  nginx_switch_applied=0
  rm -f "$nginx_backup"
  nginx_backup=''
}

install_nginx_config() {
  [[ -f "$nginx_source" && -r "$nginx_source" ]] || fail 'versioned Hermes Nginx config is unavailable'
  [[ -f "$nginx_file" && -L "$nginx_enabled" ]] || fail 'Hermes Nginx topology is unavailable'
  [[ $(readlink -f "$nginx_enabled") == "$nginx_file" ]] || fail 'Hermes Nginx enabled target is unexpected'
  if cmp -s "$nginx_source" "$nginx_file"; then
    [[ $(stat -c '%U:%G:%a' "$nginx_file") == root:root:644 ]] ||
      fail 'installed Hermes Nginx config permissions are invalid'
    return 0
  fi

  nginx_backup=$(mktemp /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf.backup.XXXXXX)
  install -o root -g root -m 0600 "$nginx_file" "$nginx_backup"
  nginx_candidate=$(mktemp /etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf.candidate.XXXXXX)
  install -o root -g root -m 0644 "$nginx_source" "$nginx_candidate"
  mv -f "$nginx_candidate" "$nginx_file"
  nginx_candidate=''
  nginx_switch_applied=1
  if ! nginx -t || ! systemctl reload nginx; then
    restore_nginx_config || true
    fail 'Hermes Nginx switch failed; previous config restored where possible'
  fi
}

commit_nginx_config() {
  (( nginx_switch_applied )) || return 0
  rm -f "$nginx_backup"
  nginx_backup=''
  nginx_switch_applied=0
}

stage_cleanup_required=0
stage_exit_cleanup() {
  local status=$?
  if [[ -n "$nginx_candidate" ]]; then
    rm -f "$nginx_candidate"
    nginx_candidate=''
  fi
  if [[ -n "$run_status_response" ]]; then
    rm -f "$run_status_response"
    run_status_response=''
  fi
  if (( nginx_switch_applied )) && ! restore_nginx_config; then
    printf 'deploy-hermes-ascon: automatic Hermes Nginx restore failed\n' >&2
    status=1
  fi
  if (( ! nginx_switch_applied )) && [[ -n "$nginx_backup" ]]; then
    rm -f "$nginx_backup"
    nginx_backup=''
  fi
  if (( stage_cleanup_required )); then
    remove_readiness
    if "${compose[@]}" down --remove-orphans >/dev/null 2>&1; then
      remove_runtime_secrets
    else
      printf 'deploy-hermes-ascon: automatic isolated-stage cleanup failed\n' >&2
      status=1
    fi
  fi
  trap - EXIT
  exit "$status"
}
trap stage_exit_cleanup EXIT

"${compose[@]}" config --quiet
if [[ $action != rollback ]]; then
  ensure_management_network
fi

case "$action" in
  auth)
    prepare_runtime
    "${compose[@]}" build gateway
    probe_runtime
    "${compose[@]}" run --rm --no-deps gateway auth add openai-codex
    [[ -s "$data_root/auth.json" ]] || fail 'Codex OAuth store was not created'
    chown "$workload_uid:$workload_gid" "$data_root/auth.json"
    chmod 0600 "$data_root/auth.json"
    [[ $(stat -c '%u:%g:%a' "$data_root/auth.json") == "$workload_uid:$workload_gid:600" ]] ||
      fail 'Codex OAuth store permissions are invalid'
    remove_runtime_secrets
    ;;
  codex-auth)
    prepare_runtime
    "${compose[@]}" build codex-cli
    probe_codex_runtime
    "${compose[@]}" run --rm --no-deps codex-cli login --device-auth
    [[ -s "$codex_home/auth.json" ]] || fail 'isolated Codex OAuth store was not created'
    chown "$workload_uid:$workload_gid" "$codex_home/auth.json"
    chmod 0600 "$codex_home/auth.json"
    [[ $(stat -c '%u:%g:%a' "$codex_home/auth.json") == "$workload_uid:$workload_gid:600" ]] ||
      fail 'isolated Codex OAuth store permissions are invalid'
    verify_codex_runtime
    remove_runtime_secrets
    ;;
  stage)
    [[ -s "$data_root/auth.json" ]] ||
      fail 'Codex OAuth is missing; run the separately approved auth action first'
    [[ $(stat -c '%u:%g:%a' "$data_root/auth.json") == "$workload_uid:$workload_gid:600" ]] ||
      fail 'Codex OAuth store permissions are invalid'
    [[ -s "$codex_home/auth.json" ]] ||
      fail 'isolated Codex OAuth is missing; run the separately approved codex-auth action first'
    [[ $(stat -c '%u:%g:%a' "$codex_home/auth.json") == "$workload_uid:$workload_gid:600" ]] ||
      fail 'isolated Codex OAuth store permissions are invalid'
    stage_cleanup_required=1
    prepare_runtime
    "${compose[@]}" build gateway
    verify_native_execution
    probe_runtime
    quiet_checked 'Hermes provider OAuth status preflight' \
      "${compose[@]}" run --rm --no-deps \
        --entrypoint /opt/hermes/bin/hermes gateway auth status openai-codex
    verify_codex_runtime
    "${compose[@]}" down --remove-orphans
    rm -f "$gateway_pid_file"
    [[ ! -e "$gateway_pid_file" ]] || fail 'stale gateway PID file could not be removed'
    "${compose[@]}" up -d gateway dashboard
    wait_for_service_health gateway || fail 'gateway did not become healthy within 180 seconds'
    wait_for_service_health dashboard || fail 'dashboard did not become healthy within 180 seconds'
    curl -fsS --max-time 15 \
      https://hermes-ascon.f-ai.studio/health >/dev/null
    api_key=$(sed -n 's/^API_SERVER_KEY=//p' "$api_secret_file")
    [[ -n "$api_key" ]] || fail 'API_SERVER_KEY is empty'
    printf 'header = "Authorization: Bearer %s"\n' "$api_key" | \
      curl -fsS --max-time 15 --config - \
      https://hermes-ascon.f-ai.studio/v1/capabilities >/dev/null
    install_nginx_config
    run_status_response=$(mktemp)
    run_status_ready=0
    for attempt in {1..10}; do
      : >"$run_status_response"
      run_status_code=$(printf 'header = "Authorization: Bearer %s"\n' "$api_key" | \
        curl -sS --max-time 3 --config - --output "$run_status_response" \
        --write-out '%{http_code}' \
        https://hermes-ascon.f-ai.studio/v1/runs/run_fai_deploy_probe || true)
      if [[ "$run_status_code" == 404 ]] &&
        grep -Eq '"code"[[:space:]]*:[[:space:]]*"run_not_found"' "$run_status_response"; then
        run_status_ready=1
        break
      fi
      sleep 1
    done
    (( run_status_ready )) || fail 'public Hermes run-status route did not reach the bounded provider response'
    rm -f "$run_status_response"
    run_status_response=''
    unset api_key
    write_readiness
    commit_nginx_config
    prune_superseded_project_images
    stage_cleanup_required=0
    ;;
  rollback)
    "${compose[@]}" down --remove-orphans
    remove_readiness
    remove_runtime_secrets
    ;;
esac

printf 'deploy-hermes-ascon: %s complete; ASCON data preserved\n' "$action"
