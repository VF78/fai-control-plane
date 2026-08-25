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
export GH_TOKEN

git config --global credential.https://github.com.helper \
  '!f() { test "$1" = get || exit 0; printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f'
if [[ ${1:-} == --exec ]]; then
  shift
  exec "$@"
fi
exec /opt/hermes/bin/hermes "$@"
