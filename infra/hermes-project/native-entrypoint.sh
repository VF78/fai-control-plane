#!/usr/bin/env bash
set -euo pipefail
set +x

token_file=${HERMES_GITHUB_REPOSITORY_TOKEN_FILE:-/run/secrets/github-repository-token}
[[ -f "$token_file" && ! -L "$token_file" && -r "$token_file" ]] || {
  printf 'Hermes repository token is unavailable\n' >&2
  exit 1
}
GH_TOKEN=$(tr -d '\r\n' < "$token_file")
[[ ${#GH_TOKEN} -ge 20 && ${#GH_TOKEN} -le 512 ]] || {
  printf 'Hermes repository token is invalid\n' >&2
  exit 1
}
readonly gh_config_dir=${GH_CONFIG_DIR:-$HOME/.config/gh}
install -d -m 0700 "$gh_config_dir"
if ! env -u GH_TOKEN GH_CONFIG_DIR="$gh_config_dir" \
  gh auth login --hostname github.com --git-protocol https --with-token \
  <"$token_file" >/dev/null 2>&1; then
  printf 'Hermes repository token could not initialize GitHub CLI\n' >&2
  exit 1
fi
if ! GH_CONFIG_DIR="$gh_config_dir" gh auth setup-git >/dev/null 2>&1; then
  printf 'Hermes Git credential helper could not be initialized\n' >&2
  exit 1
fi
unset GH_TOKEN
export GH_CONFIG_DIR="$gh_config_dir"
for binding in \
  "API_SERVER_KEY:${HERMES_API_SERVER_KEY_FILE:-}" \
  "TELEGRAM_BOT_TOKEN:${HERMES_TELEGRAM_BOT_TOKEN_FILE:-}"; do
  name=${binding%%:*}
  secret_file=${binding#*:}
  if [[ -n "$secret_file" ]]; then
    [[ -f "$secret_file" && ! -L "$secret_file" && -r "$secret_file" ]] || {
      printf 'Hermes runtime credential is unavailable\n' >&2
      exit 1
    }
    printf -v "$name" '%s' "$(tr -d '\r\n' < "$secret_file")"
    export "$name"
  fi
done
if [[ ${1:-} == --exec ]]; then
  shift
  exec "$@"
fi
exec /opt/hermes/bin/hermes "$@"
