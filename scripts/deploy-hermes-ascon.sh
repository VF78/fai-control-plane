#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

readonly deploy_root=/opt/fai-hermes-ascon
readonly environment_file=/etc/fai-hermes-ascon/production.env
readonly compose_file="$deploy_root/infra/hermes-ascon/compose.yaml"
readonly api_secret_file=/etc/fai-hermes-ascon/secrets/api-server.env
readonly telegram_secret_file=/etc/fai-hermes-ascon/secrets/telegram.env
readonly internal_bridge_token=/etc/fai-hermes-ascon/secrets/internal-bridge-token
readonly client_bridge_token=/etc/fai-hermes-ascon/secrets/client-bridge-token
readonly data_root=/var/lib/fai-hermes-ascon
readonly runtime_config_file="$data_root/runtime-config.yaml"
readonly work_directory="$data_root/work"
readonly project_work_directory="$work_directory/project"
readonly codex_home="$data_root/codex-home"
readonly readiness_directory="$data_root/readiness"
readonly readiness_file="$readiness_directory/codex-cli.json"
readonly runtime_secret_directory="$data_root/runtime-secrets"
readonly runtime_internal_bridge_token="$runtime_secret_directory/internal-bridge-token"
readonly runtime_client_bridge_token="$runtime_secret_directory/client-bridge-token"
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
  "$deploy_root/infra/hermes-ascon/profiles/bitrix-client/config.yaml"
  "$deploy_root/infra/hermes-ascon/extensions/fai-control-plane/plugin.yaml"
  "$deploy_root/infra/hermes-ascon/extensions/fai-control-plane/bridge_state.py"
  "$deploy_root/infra/hermes-ascon/extensions/fai-control-plane/__init__.py"
  "$deploy_root/infra/hermes-ascon/extensions/fai-identity/HOOK.yaml"
  "$deploy_root/infra/hermes-ascon/extensions/fai-identity/handler.py"
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
  "$internal_bridge_token" "$client_bridge_token"; do
  [[ -f "$path" && -r "$path" ]] || fail "missing required file: $path"
  [[ $(stat -c '%U:%G:%a' "$path") == root:root:600 ]] ||
    fail "file must be root:root mode 0600: $path"
done

[[ $(sed -n 's/^HERMES_INTERNAL_BRIDGE_TOKEN_FILE=//p' "$environment_file") == \
  "$runtime_internal_bridge_token" ]] ||
  fail 'internal bridge token must use the isolated runtime copy'
[[ $(sed -n 's/^HERMES_CLIENT_BRIDGE_TOKEN_FILE=//p' "$environment_file") == \
  "$runtime_client_bridge_token" ]] ||
  fail 'client bridge token must use the isolated runtime copy'
[[ $(sed -n 's/^HERMES_RENDERED_CONFIG_FILE=//p' "$environment_file") == \
  "$runtime_config_file" ]] ||
  fail 'Hermes must use the isolated rendered config'
readonly hermes_model=$(sed -n 's/^HERMES_MODEL=//p' "$environment_file")
[[ "$hermes_model" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] ||
  fail 'Hermes model is invalid'

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
for path in "$internal_bridge_token" "$client_bridge_token"; do
  token_length=$(wc -c < "$path")
  (( token_length >= 33 && token_length <= 513 )) || fail "invalid bridge token length: $path"
done

for path in \
  "$deploy_root/infra/hermes-ascon/config.yaml" \
  "$deploy_root/infra/hermes-ascon/profiles/internal/config.yaml" \
  "$deploy_root/infra/hermes-ascon/profiles/bitrix-client/config.yaml"; do
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
  rm -f "$runtime_internal_bridge_token" "$runtime_client_bridge_token"
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
    "$work_directory" "$project_work_directory" "$codex_home" "$runtime_secret_directory"
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
    "$client_bridge_token" "$runtime_client_bridge_token"
  cmp -s "$internal_bridge_token" "$runtime_internal_bridge_token" ||
    fail 'internal runtime bridge token copy differs from its canonical source'
  cmp -s "$client_bridge_token" "$runtime_client_bridge_token" ||
    fail 'client runtime bridge token copy differs from its canonical source'
  for path in "$runtime_internal_bridge_token" "$runtime_client_bridge_token"; do
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
    "/opt/data/profiles/bitrix-client/config.yaml",
    "/opt/data/plugins/fai-control-plane/plugin.yaml",
    "/opt/data/plugins/fai-control-plane/bridge_state.py",
    "/opt/data/plugins/fai-control-plane/__init__.py",
    "/opt/data/hooks/fai-identity/HOOK.yaml",
    "/opt/data/hooks/fai-identity/handler.py",
    "/opt/data/profiles/internal/bridge-token",
    "/opt/data/profiles/bitrix-client/bridge-token",
)
for name in readable:
    Path(name).read_bytes()
probe = Path("/opt/data/work/.uid-10000-write-probe")
probe.write_bytes(b"")
probe.unlink()
project_probe = Path("/opt/data/work/project/.uid-10000-write-probe")
project_probe.write_bytes(b"")
project_probe.unlink()
codex_probe = Path("/opt/data/codex-home/.uid-10000-write-probe")
codex_probe.write_bytes(b"")
codex_probe.unlink()
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

wait_for_gateway_health() {
  local deadline=$((SECONDS + 180))
  local container_id
  local status
  while (( SECONDS < deadline )); do
    container_id=$("${compose[@]}" ps --all -q gateway 2>/dev/null || true)
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

stage_cleanup_required=0
stage_exit_cleanup() {
  local status=$?
  if (( stage_cleanup_required )); then
    remove_readiness
    if "${compose[@]}" down >/dev/null 2>&1; then
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
    probe_runtime
    quiet_checked 'Hermes provider OAuth status preflight' \
      "${compose[@]}" run --rm --no-deps \
        --entrypoint /opt/hermes/bin/hermes gateway auth status openai-codex
    verify_codex_runtime
    "${compose[@]}" down
    rm -f "$gateway_pid_file"
    [[ ! -e "$gateway_pid_file" ]] || fail 'stale gateway PID file could not be removed'
    "${compose[@]}" up -d gateway
    wait_for_gateway_health || fail 'gateway did not become healthy within 180 seconds'
    curl -fsS --max-time 15 \
      https://hermes-ascon.f-ai.studio/health >/dev/null
    api_key=$(sed -n 's/^API_SERVER_KEY=//p' "$api_secret_file")
    [[ -n "$api_key" ]] || fail 'API_SERVER_KEY is empty'
    printf 'header = "Authorization: Bearer %s"\n' "$api_key" | \
      curl -fsS --max-time 15 --config - \
      https://hermes-ascon.f-ai.studio/v1/capabilities >/dev/null
    unset api_key
    write_readiness
    stage_cleanup_required=0
    ;;
  rollback)
    "${compose[@]}" down
    remove_readiness
    remove_runtime_secrets
    ;;
esac

printf 'deploy-hermes-ascon: %s complete; ASCON data preserved\n' "$action"
