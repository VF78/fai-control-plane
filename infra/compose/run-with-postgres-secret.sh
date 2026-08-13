#!/bin/sh
set -eu
test -r /run/secrets/postgres-password
export PGHOST="${PGHOST:?required}" PGPORT="${PGPORT:-5432}" PGDATABASE="${PGDATABASE:?required}" PGUSER="${PGUSER:?required}"
PGPASSWORD=$(tr -d '\r\n' < /run/secrets/postgres-password)
test -n "$PGPASSWORD"
export PGPASSWORD
exec "$@"
