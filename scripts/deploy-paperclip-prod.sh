#!/usr/bin/env bash
# Invoked only through deploy-prod.sh; preflight never creates host resources.
set -euo pipefail
fail() { printf 'paperclip-release: %s\n' "$1" >&2; exit 1; }
[[ $# == 2 && $1 =~ ^(preflight|deploy|activate)$ && $2 =~ ^[0-9a-f]{40}$ ]] || fail 'expected preflight|deploy|activate and exact 40-hex plugin commit'
[[ $EUID == 0 ]] || fail 'run on the approved VPS as root'
action=$1
commit=$2
release=/opt/fai-paperclip/releases/$commit
control=$release/control
core=$release/core
config=$control/infra/paperclip
core_sha=65ec059bde30d98c92165b24a30a540800dd1f6f
hermes_sha=sha256:b994d0d9fd22691b9f922ec72274e6f4c6654d55d0db79a34e517b4c5abca0dc
[[ $(git -C "$control" rev-parse HEAD) == "$commit" ]] || fail 'plugin commit differs'
[[ $(git -C "$core" rev-parse HEAD) == "$core_sha" ]] || fail 'Core pin differs'
for tree in "$control" "$core"; do
  [[ -z $(git -C "$tree" status --porcelain --untracked-files=no) ]] || fail 'tracked release sources differ'
done
"$release/toolchain/bin/node" -e 'let [a,b]=process.versions.node.split(".").map(Number);if(a<24||(a===24&&b<11))process.exit(1)' || fail 'isolated Node >=24.11 required'
[[ $("$release/toolchain/bin/pnpm" --version) == 9.15.4 ]] || fail 'isolated pnpm pin differs'
for file in server/dist/index.js ui/dist/index.html packages/plugins/sdk/dist/index.js; do
  [[ -f $core/$file ]] || fail "missing Core build artifact: $file"
done
[[ -f $control/plugins/fai-control/dist/worker.js ]] || fail 'missing plugin build'
[[ $(docker image inspect --format '{{.Id}}' fai-hermes-project:codex-0.153.4) == "$hermes_sha" ]] || fail 'retained Hermes image differs'
[[ $(stat -c '%g:%a' /var/run/docker.sock) == 110:660 ]] || fail 'Docker socket contract changed'
[[ $(getent group docker | cut -d: -f3) == 110 ]] || fail 'docker supplementary group contract differs'
if getent passwd fai-paperclip >/dev/null; then
  [[ $(id -u fai-paperclip):$(id -g fai-paperclip) == 10000:10000 ]] || fail 'service UID/GID differs'
else
  ! getent passwd 10000 >/dev/null || fail 'UID10000 belongs to another account'
  ! getent group 10000 >/dev/null || fail 'GID10000 belongs to another group'
fi
for unit in myshopai-website fai-content-platform hermes-gateway; do systemctl is-active --quiet "$unit" || fail "protected service unhealthy: $unit"; done
[[ $(docker inspect --format '{{.State.Running}}' amnezia-awg2) == true ]] || fail 'protected VPN unhealthy'
[[ -z $(ss -Hlnpt 'sport = :13010') ]] || fail 'public pilot port already occupied'
if [[ $action != activate ]]; then
  [[ -z $(ss -Hlnpt 'sport = :13110 or sport = :15432') ]] || fail 'bootstrap/database ports occupied; first-install only'
fi
[[ $(df -Pk /opt | awk 'NR==2{print $4}') -ge 2097152 ]] || fail 'less than 2GiB runtime disk headroom after staging'
for file in /etc/fai-paperclip/production.env /etc/fai-paperclip/bootstrap.env /etc/fai-paperclip/secrets/postgres-password /etc/fai-paperclip/release.env; do
  [[ -f $file && ! -L $file && $(stat -c '%U:%G:%a' "$file") == root:root:600 ]] || fail 'required root-owned0600 configuration missing'
done
! grep -q 'REPLACE_' /etc/fai-paperclip/production.env || fail 'secret placeholders remain'
! grep -q 'REPLACE_' /etc/fai-paperclip/bootstrap.env || fail 'bootstrap placeholders remain'
"$release/toolchain/bin/node" "$config/validate-env.mjs" /etc/fai-paperclip/production.env /etc/fai-paperclip/bootstrap.env /etc/fai-paperclip/secrets/postgres-password || fail 'configuration invariants differ'
# Do not source configuration: validate only the bounded non-secret image reference.
image=$(sed -n 's/^FCP_POSTGRES_IMAGE=//p' /etc/fai-paperclip/release.env)
[[ $image =~ ^postgres:17\.[0-9]+@sha256:[0-9a-f]{64}$ ]] || fail 'Postgres17 minor+digest must be approved'
docker image inspect "$image" >/dev/null || fail 'approved database image must be staged first'
export FCP_POSTGRES_IMAGE=$image
docker compose -f "$config/compose.yaml" config --quiet
[[ -f $release/artifacts.sha256 ]] || fail 'prepared Linux artifact checksums missing'
(cd "$release" && sha256sum --check --status artifacts.sha256) || fail 'prepared artifacts differ'
config_digest=$({ sha256sum "$config/config.json" "$config/bootstrap-config.json" "$config/paperclip.service" "$config/compose.yaml" "$release/artifacts.sha256" /etc/fai-paperclip/production.env /etc/fai-paperclip/bootstrap.env /etc/fai-paperclip/release.env /etc/fai-paperclip/secrets/postgres-password; } | sha256sum | cut -d' ' -f1)
printf 'Plugin=%s Core=%s Configuration=%s\n' "$commit" "$core_sha" "$config_digest"
[[ $action != preflight ]] || exit 0
[[ ${FCP_APPROVED_RELEASE_COMMIT:-} == "$commit" && ${FCP_APPROVED_CONFIG_SHA256:-} == "$config_digest" ]] || fail 'exact commit and configuration approval required'
[[ ${FCP_APPROVED_PAPERCLIP_RUNTIME:-} == native-uid10000-docker-postgres17 ]] || fail 'exact new resource boundary approval required'
if [[ $action == activate ]]; then
  [[ ${FCP_APPROVED_PAPERCLIP_ACTIVATION:-} == accepted-native-auth-plugin-hermes-qa ]] || fail 'separate public activation approval and actual acceptance required'
  [[ $(readlink /opt/fai-paperclip/current) == "$release" ]] || fail 'active private release differs'
  systemctl is-active --quiet paperclip.service || fail 'private pilot not active'
  install -o root -g root -m 600 /etc/fai-paperclip/production.env /etc/fai-paperclip/active.env
  install -o 10000 -g 10000 -m 600 "$config/config.json" /var/lib/paperclip/instances/default/config.json
  systemctl restart paperclip.service
  curl --retry 20 --retry-connrefused --retry-delay 1 --fail --silent http://127.0.0.1:13010/api/health >/dev/null
  for unit in myshopai-website fai-content-platform hermes-gateway; do systemctl is-active --quiet "$unit" || fail "protected service unhealthy after activation: $unit"; done
  [[ $(docker inspect --format '{{.State.Running}}' amnezia-awg2) == true ]] || fail 'protected VPN unhealthy after activation'
  printf '%s\n' 'Public native authenticated pilot activated through existing Nginx route; no Nginx changes.'
  exit 0
fi
[[ ! -e /opt/fai-paperclip/current && ! -e /var/lib/paperclip && ! -e /var/lib/fai-control/hermes && ! -e /etc/systemd/system/paperclip.service ]] || fail 'first-install resources already exist; never overwrite retained state'
if ! getent passwd fai-paperclip >/dev/null; then
  groupadd --gid 10000 fai-paperclip
  useradd --uid 10000 --gid 10000 --home-dir /var/lib/paperclip --no-create-home --shell /usr/sbin/nologin fai-paperclip
fi
install -d -o 10000 -g 10000 -m 700 /var/lib/paperclip /var/lib/paperclip/instances/default /var/lib/fai-control/hermes
install -o 10000 -g 10000 -m 600 "$config/bootstrap-config.json" /var/lib/paperclip/instances/default/config.json
install -o root -g root -m 600 /etc/fai-paperclip/bootstrap.env /etc/fai-paperclip/active.env
ln -s "$release" /opt/fai-paperclip/current
docker compose -f "$config/compose.yaml" up -d --wait postgres
install -o root -g root -m 644 "$config/paperclip.service" /etc/systemd/system/paperclip.service
systemctl daemon-reload
systemctl enable --now paperclip.service
curl --retry 20 --retry-connrefused --retry-delay 1 --fail --silent http://127.0.0.1:13110/api/health >/dev/null
for unit in myshopai-website fai-content-platform hermes-gateway; do systemctl is-active --quiet "$unit" || fail "protected service unhealthy after start: $unit"; done
[[ $(docker inspect --format '{{.State.Running}}' amnezia-awg2) == true ]] || fail 'protected VPN unhealthy after start'
printf '%s\n' 'Core started. Complete private bootstrap, authenticated single-plugin installation and acceptance gates before opening public access. No Nginx changes performed.'
