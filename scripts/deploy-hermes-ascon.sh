#!/usr/bin/env bash
set -euo pipefail

readonly deploy_root=/opt/fai-hermes-ascon
readonly environment_file=/etc/fai-hermes-ascon/production.env
readonly compose_file="$deploy_root/infra/hermes-ascon/compose.yaml"
readonly api_secret_file=/etc/fai-hermes-ascon/secrets/api-server.env
readonly telegram_secret_file=/etc/fai-hermes-ascon/secrets/telegram.env
readonly internal_bridge_token=/etc/fai-hermes-ascon/secrets/internal-bridge-token
readonly client_bridge_token=/etc/fai-hermes-ascon/secrets/client-bridge-token
readonly project=fai-hermes-ascon

fail() {
  printf 'deploy-hermes-ascon: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 && ( $1 == auth || $1 == stage || $1 == rollback ) ]] ||
  fail 'usage: deploy-hermes-ascon.sh <auth|stage|rollback>'
readonly action=$1

[[ $EUID -eq 0 ]] || fail 'must run as root on the approved host'
[[ $(git rev-parse --show-toplevel) == "$deploy_root" ]] ||
  fail 'checkout is not the isolated ASCON Hermes directory'
[[ -z $(git status --porcelain) ]] || fail 'checkout is not clean'
[[ "${HERMES_APPROVED_IMAGE:-}" == *@sha256:* ]] ||
  fail 'exact approved image is missing'
[[ "${HERMES_APPROVED_CONFIG_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'approved config digest is missing or invalid'

for path in "$environment_file" "$api_secret_file" "$telegram_secret_file" \
  "$internal_bridge_token" "$client_bridge_token"; do
  [[ -f "$path" && -r "$path" ]] || fail "missing required file: $path"
  [[ $(stat -c '%U:%G:%a' "$path") == root:root:600 ]] ||
    fail "file must be root:root mode 0600: $path"
done

[[ $(sha256sum "$environment_file" | cut -d ' ' -f 1) == "$HERMES_APPROVED_CONFIG_SHA256" ]] ||
  fail 'production environment does not match approved digest'
grep -Eq '^HERMES_IMAGE=' "$environment_file" ||
  fail 'configured image is missing'
[[ $(sed -n 's/^HERMES_IMAGE=//p' "$environment_file") == "$HERMES_APPROVED_IMAGE" ]] ||
  fail 'configured image is not approved'
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

compose=(
  docker compose
  --project-name "$project"
  --env-file "$environment_file"
  -f "$compose_file"
)
"${compose[@]}" config --quiet

case "$action" in
  auth)
    install -d -o root -g root -m 0750 \
      /var/lib/fai-hermes-ascon \
      /var/lib/fai-hermes-ascon/work
    "${compose[@]}" pull gateway
    "${compose[@]}" run --rm --no-deps gateway auth add openai-codex
    [[ -s /var/lib/fai-hermes-ascon/auth.json ]] || fail 'Codex OAuth store was not created'
    ;;
  stage)
    [[ -s /var/lib/fai-hermes-ascon/auth.json ]] ||
      fail 'Codex OAuth is missing; run the separately approved auth action first'
    install -d -o root -g root -m 0750 \
      /var/lib/fai-hermes-ascon \
      /var/lib/fai-hermes-ascon/work
    "${compose[@]}" pull gateway
    "${compose[@]}" run --rm --no-deps gateway auth status openai-codex >/dev/null
    "${compose[@]}" up -d gateway
    curl -fsS --max-time 15 \
      https://hermes-ascon.f-ai.studio/health >/dev/null
    api_key=$(sed -n 's/^API_SERVER_KEY=//p' "$api_secret_file")
    [[ -n "$api_key" ]] || fail 'API_SERVER_KEY is empty'
    printf 'header = "Authorization: Bearer %s"\n' "$api_key" | curl -fsS --max-time 15 --config - \
      https://hermes-ascon.f-ai.studio/v1/capabilities >/dev/null
    unset api_key
    ;;
  rollback)
    "${compose[@]}" down
    ;;
esac

printf 'deploy-hermes-ascon: %s complete; ASCON data preserved\n' "$action"
