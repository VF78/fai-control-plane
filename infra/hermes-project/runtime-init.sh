#!/command/with-contenv sh
set -eu

token_file=${HERMES_GITHUB_REPOSITORY_TOKEN_FILE:-}
if [ -n "$token_file" ]; then
  [ -f "$token_file" ] && [ ! -L "$token_file" ] && [ -r "$token_file" ] || {
    echo 'Hermes repository token is unavailable' >&2
    exit 1
  }
  token_length=$(tr -d '\r\n' < "$token_file" | wc -c | tr -d ' ')
  [ "$token_length" -ge 20 ] && [ "$token_length" -le 512 ] || {
    echo 'Hermes repository token is invalid' >&2
    exit 1
  }
  runtime_home=/opt/data/home
  gh_config_dir=$runtime_home/.config/gh
  runtime_user=$(getent passwd 10000 | cut -d: -f1)
  [ -n "$runtime_user" ] || { echo 'Hermes runtime user is unavailable' >&2; exit 1; }
  install -d -o 10000 -g 10000 -m 0700 "$runtime_home" "$runtime_home/.config" "$gh_config_dir"
  if ! s6-setuidgid "$runtime_user" env -u GH_TOKEN HOME="$runtime_home" GH_CONFIG_DIR="$gh_config_dir" \
    gh auth login --hostname github.com --git-protocol https --with-token < "$token_file" >/dev/null 2>&1; then
    echo 'Hermes repository token could not initialize GitHub CLI' >&2
    exit 1
  fi
  if ! s6-setuidgid "$runtime_user" env HOME="$runtime_home" GH_CONFIG_DIR="$gh_config_dir" gh auth setup-git >/dev/null 2>&1; then
    echo 'Hermes Git credential helper could not be initialized' >&2
    exit 1
  fi
fi

install -d -m 0700 /run/s6/container_environment
for binding in \
  "API_SERVER_KEY:${HERMES_API_SERVER_KEY_FILE:-}" \
  "TELEGRAM_BOT_TOKEN:${HERMES_TELEGRAM_BOT_TOKEN_FILE:-}"; do
  name=${binding%%:*}
  secret_file=${binding#*:}
  if [ -n "$secret_file" ]; then
    [ -f "$secret_file" ] && [ ! -L "$secret_file" ] && [ -r "$secret_file" ] || {
      echo 'Hermes runtime credential is unavailable' >&2
      exit 1
    }
    value=$(tr -d '\r\n' < "$secret_file")
    [ -n "$value" ] && [ "${#value}" -le 65536 ] || {
      echo 'Hermes runtime credential is invalid' >&2
      exit 1
    }
    printf '%s' "$value" > "/run/s6/container_environment/$name"
    chmod 0600 "/run/s6/container_environment/$name"
  fi
done

case "${HERMES_DASHBOARD:-}" in
  1|true|TRUE|True|yes|YES|Yes)
    for binding in \
      "HERMES_DASHBOARD_BASIC_AUTH_USERNAME:${HERMES_DASHBOARD_USERNAME_FILE:-}" \
      "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD:${HERMES_DASHBOARD_PASSWORD_FILE:-}" \
      "HERMES_DASHBOARD_BASIC_AUTH_SECRET:${HERMES_DASHBOARD_SIGNING_SECRET_FILE:-}"; do
      name=${binding%%:*}
      secret_file=${binding#*:}
      [ -n "$secret_file" ] && [ -f "$secret_file" ] && [ ! -L "$secret_file" ] && [ -r "$secret_file" ] || {
        echo 'Hermes dashboard credential is unavailable' >&2
        exit 1
      }
      value=$(tr -d '\r\n' < "$secret_file")
      case "$name" in
        HERMES_DASHBOARD_BASIC_AUTH_USERNAME) minimum=1; maximum=128 ;;
        HERMES_DASHBOARD_BASIC_AUTH_PASSWORD) minimum=20; maximum=512 ;;
        *) minimum=32; maximum=512 ;;
      esac
      [ "${#value}" -ge "$minimum" ] && [ "${#value}" -le "$maximum" ] || {
        echo 'Hermes dashboard credential is invalid' >&2
        exit 1
      }
      printf '%s' "$value" > "/run/s6/container_environment/$name"
      chmod 0600 "/run/s6/container_environment/$name"
    done
    ;;
esac
