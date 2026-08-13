#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
  'deploy-prod: blocked: this branch contains the fresh MVP architecture.' \
  'deploy-prod: issue #174 must supply and approve an MVP-specific runbook and deployment path.' \
  'deploy-prod: the legacy production host, database, credentials and services must remain unchanged.' >&2
exit 1
