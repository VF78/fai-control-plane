#!/usr/bin/env bash
set -euo pipefail

readonly verification_container="fai-control-plane-verify-$$"
readonly postgres_image='postgres:16-bookworm@sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537'
readonly verification_docker_config="$(mktemp -d)"
docker_cli() { docker --config "$verification_docker_config" "$@"; }
cleanup() {
  docker_cli rm -f "$verification_container" >/dev/null 2>&1 || true
  rm -rf -- "$verification_docker_config"
}
trap cleanup EXIT

pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 -m unittest discover -s infra/production/tests -p 'test_*.py'

docker_cli run --detach --rm --name "$verification_container" \
  --env POSTGRES_DB=fai_control_plane_mvp --env POSTGRES_USER=fai --env POSTGRES_PASSWORD=fai \
  --publish 127.0.0.1::5432 "$postgres_image" >/dev/null
for _ in {1..30}; do
  docker_cli exec "$verification_container" pg_isready -U fai -d fai_control_plane_mvp >/dev/null 2>&1 && break
  sleep 1
done
docker_cli exec "$verification_container" pg_isready -U fai -d fai_control_plane_mvp >/dev/null
readonly postgres_port="$(docker_cli port "$verification_container" 5432/tcp | sed -n 's/.*://p')"
[[ "$postgres_port" =~ ^[0-9]+$ ]]

export DATABASE_URL="postgresql://fai:fai@127.0.0.1:${postgres_port}/fai_control_plane_mvp"
export FCP_WORKSPACE_ID='10000000-0000-4000-8000-000000000001'
export FCP_PROJECT_ID='10000000-0000-4000-8000-000000000002'
export GITHUB_BINDING_ID='10000000-0000-4000-8000-000000000003'
export BOOTSTRAP_OWNER_ACTOR_ID='10000000-0000-4000-8000-000000000004'
export BOOTSTRAP_TRACKER_SECRET_REF_ID='10000000-0000-4000-8000-000000000005'
export BOOTSTRAP_WORKSPACE_SLUG='verify'
export BOOTSTRAP_WORKSPACE_NAME='Verification'
export BOOTSTRAP_OWNER_NAME='Verification Owner'
export BOOTSTRAP_OWNER_GITHUB_USER_ID='1'
export GITHUB_PROJECTS_TOKEN_FILE='/run/secrets/github-projects-token'

pnpm db:migrate
pnpm mvp:bootstrap
pnpm mvp:bootstrap
docker_cli exec "$verification_container" psql -v ON_ERROR_STOP=1 -U fai -d fai_control_plane_mvp -c \
  "insert into projects(id,workspace_id,slug,name,repository_url) values('$FCP_PROJECT_ID','$FCP_WORKSPACE_ID','verify','Verification','https://github.com/VF78/fai-control-plane'); insert into project_memberships(project_id,actor_id,role,active) values('$FCP_PROJECT_ID','$BOOTSTRAP_OWNER_ACTOR_ID','project_owner',true); insert into tracker_bindings(id,project_id,secret_ref_id,provider,external_project_id,project_url,repository_id,repository_url) values('$GITHUB_BINDING_ID','$FCP_PROJECT_ID','$BOOTSTRAP_TRACKER_SECRET_REF_ID','github','PVT_verify','https://github.com/users/VF78/projects/1','VF78/fai-control-plane','https://github.com/VF78/fai-control-plane');" >/dev/null
pnpm db:check
pnpm vitest run packages/db/src/mvp/thin-control-plane.integration.test.ts packages/db/src/mvp/trust-contours.integration.test.ts
