#!/bin/sh
set -eu

umask 077

for source_path in /run/secrets/source-*; do
  [ -f "$source_path" ] || continue
  secret_name=${source_path##*/source-}
  [ -n "$secret_name" ]
  install -o node -g node -m 0400 "$source_path" "/run/secrets/$secret_name"
done

exec setpriv --reuid=node --regid=node --init-groups --no-new-privs --bounding-set=-all -- "$@"
