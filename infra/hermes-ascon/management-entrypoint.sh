#!/usr/bin/env bash
set -euo pipefail
set +x

username_file=${HERMES_DASHBOARD_USERNAME_FILE:-/run/secrets/hermes-dashboard-username}
password_file=${HERMES_DASHBOARD_PASSWORD_FILE:-/run/secrets/hermes-dashboard-password}
signing_secret_file=${HERMES_DASHBOARD_SIGNING_SECRET_FILE:-/run/secrets/hermes-dashboard-signing-secret}

for secret_file in "$username_file" "$password_file" "$signing_secret_file"; do
  [[ -f "$secret_file" && ! -L "$secret_file" && -r "$secret_file" ]] || {
    printf 'Hermes dashboard credential is unavailable\n' >&2
    exit 1
  }
done

export HERMES_DASHBOARD_BASIC_AUTH_USERNAME
export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
export HERMES_DASHBOARD_BASIC_AUTH_SECRET
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=$(tr -d '\r\n' < "$username_file")
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=$(tr -d '\r\n' < "$password_file")
HERMES_DASHBOARD_BASIC_AUTH_SECRET=$(tr -d '\r\n' < "$signing_secret_file")
[[ ${#HERMES_DASHBOARD_BASIC_AUTH_USERNAME} -ge 1 && ${#HERMES_DASHBOARD_BASIC_AUTH_USERNAME} -le 128 ]] || exit 1
[[ ${#HERMES_DASHBOARD_BASIC_AUTH_PASSWORD} -ge 20 && ${#HERMES_DASHBOARD_BASIC_AUTH_PASSWORD} -le 512 ]] || exit 1
[[ ${#HERMES_DASHBOARD_BASIC_AUTH_SECRET} -ge 32 && ${#HERMES_DASHBOARD_BASIC_AUTH_SECRET} -le 512 ]] || exit 1

exec /opt/hermes/bin/hermes dashboard --host 0.0.0.0 --port 9119 --no-open
