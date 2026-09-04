#!/usr/bin/env bash
set -euo pipefail

readonly deploy_root=/opt/fai-control-plane-mvp
readonly environment_file=/etc/fai-control-plane-mvp/production.env
readonly compose_file="$deploy_root/infra/production/compose.yaml"
readonly runtime_image=fai-hermes-project:codex-0.144.1

case "${1:-}" in
  ps|logs|config) ;;
  *)
    printf '%s\n' 'usage: scripts/production-compose-readonly.sh {ps|logs|config} [read-only options]' >&2
    exit 64
    ;;
esac
[[ $EUID -eq 0 ]] || { printf '%s\n' 'production-compose-readonly: run with sudo' >&2; exit 1; }
[[ -f "$environment_file" && ! -L "$environment_file" ]] || {
  printf '%s\n' 'production-compose-readonly: production environment is unavailable' >&2; exit 1;
}
runtime_image_id=$(docker image inspect --format '{{.Id}}' "$runtime_image")
[[ "$runtime_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf '%s\n' 'production-compose-readonly: pinned Hermes image is unavailable' >&2; exit 1;
}
export FCP_PROJECT_HERMES_IMAGE_ID="$runtime_image_id"
exec docker compose --project-name fai-control-plane-mvp --env-file "$environment_file" -f "$compose_file" "$@"
