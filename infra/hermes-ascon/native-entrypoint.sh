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
if [[ ${1:-} == --exec ]]; then
  shift
  exec "$@"
fi
exec /opt/hermes/bin/hermes "$@"
