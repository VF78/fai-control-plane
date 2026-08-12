#!/usr/bin/env bash
set -euo pipefail

dry_run=false; confirmed=false; release_commit=; release_bundle=; release_sha256=
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    --confirm-activate-fai-hermes-planner) confirmed=true ;;
    --release-commit=*) release_commit="${argument#*=}" ;;
    --release-bundle=*) release_bundle="${argument#*=}" ;;
    --release-sha256=*) release_sha256="${argument#*=}" ;;
    *) echo "invalid argument" >&2; exit 2 ;;
  esac
done
[[ "$dry_run" == true || "$confirmed" == true ]] || { echo "explicit planner confirmation required" >&2; exit 2; }
[[ "$release_commit" =~ ^[0-9a-f]{40}$ && "$release_sha256" =~ ^[0-9a-f]{64}$ &&
   "$release_bundle" = /* && -f "$release_bundle" && ! -L "$release_bundle" ]] || {
  echo "exact absolute release artifact, commit and SHA-256 are required" >&2; exit 2;
}
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
installer="$repo_root/scripts/install-hermes-release.sh"
[[ -f "$installer" && ! -L "$installer" ]] || { echo "release installer missing" >&2; exit 1; }
installer_arguments=(--release-commit="$release_commit" --release-bundle="$release_bundle" --release-sha256="$release_sha256")
[[ "$dry_run" == false ]] || installer_arguments+=(--dry-run)
"$installer" "${installer_arguments[@]}"

planner_user=fai-hermes-planner
planner_home=/var/lib/fai-hermes-planner
planner_env=/etc/fai-hermes-planner/planner.env
planner_token=$planner_home/credentials/planning-token
model_credential=$planner_home/credentials/model-credential
planner_config=$planner_home/hermes/config.yaml
web_token=/etc/fai-control-plane/secrets/hermes-semantic-planning-token
production_env=/etc/fai-control-plane/production.env
release_root="/opt/fai-control-plane-runner/releases/$release_commit"
hermes_runtime=/opt/fai-control-plane-runner/hermes-runtime/0.18.2
hermes_python=$hermes_runtime/venv/bin/python

env_value() {
  local file="$1" key="$2"
  awk -F= -v key="$key" '$1==key {if (++count>1) exit 3; print substr($0,index($0,"=")+1)} END{if(count!=1) exit 2}' "$file"
}
file_binding() {
  local path="$1" owner="$2" mode="$3"
  [[ -f "$path" && ! -L "$path" && "$(readlink -f "$path")" == "$path" &&
     "$(stat -c '%U:%G:%a' "$path")" == "$owner:$mode" ]]
}

if [[ "$dry_run" == false ]]; then
  [[ "$(id -u)" == 0 ]] || { echo "planner activation must run as root" >&2; exit 1; }
  getent group "$planner_user" >/dev/null || groupadd --system "$planner_user"
  if ! getent passwd "$planner_user" >/dev/null; then
    useradd --system --gid "$planner_user" --home-dir "$planner_home" --shell /usr/sbin/nologin "$planner_user"
    usermod -L "$planner_user"
  fi
fi
planner_uid="$(id -u "$planner_user")"; planner_gid="$(id -g "$planner_user")"
[[ "$planner_uid" != 0 && "$planner_gid" != 0 && "$planner_uid" != "$(id -u fai-hermes-controller)" &&
   "$planner_uid" != "$(id -u fai-codex-executor)" && "$planner_gid" != "$(id -g fai-hermes-controller)" &&
   "$planner_gid" != "$(id -g fai-codex-executor)" ]] || { echo "planner identity is not isolated" >&2; exit 1; }
[[ "$(id -Gn "$planner_user")" == "$planner_user" ]] || { echo "planner has unexpected supplementary groups" >&2; exit 1; }
[[ -d "$planner_home" && ! -L "$planner_home" && "$(stat -c '%U:%G:%a' "$planner_home")" == "root:$planner_user:750" &&
   -d "$planner_home/hermes" && ! -L "$planner_home/hermes" && "$(stat -c '%U:%G:%a' "$planner_home/hermes")" == "root:$planner_user:550" &&
   -d "$planner_home/credentials" && ! -L "$planner_home/credentials" && "$(stat -c '%U:%G:%a' "$planner_home/credentials")" == "root:$planner_user:710" ]] || {
  echo "planner home binding mismatch" >&2; exit 1;
}
file_binding "$planner_env" "root:$planner_user" 640 && file_binding "$planner_config" "root:$planner_user" 440 &&
  file_binding "$planner_token" "$planner_user:$planner_user" 600 &&
  file_binding "$model_credential" "$planner_user:$planner_user" 600 || { echo "planner file binding mismatch" >&2; exit 1; }
[[ -f "$web_token" && ! -L "$web_token" && "$(stat -c '%u:%a' "$web_token")" == "1000:400" &&
   "$(sha256sum "$planner_token" | awk '{print $1}')" == "$(sha256sum "$web_token" | awk '{print $1}')" ]] || {
  echo "planner/web authentication binding mismatch" >&2; exit 1;
}
grep -Eq '^[A-Za-z0-9._~+/=-]{32,256}$' "$planner_token"
grep -Eq '^[A-Za-z0-9._~+/=-]{32,256}$' "$model_credential"
[[ "$(env_value "$planner_env" FAI_HERMES_PLANNING_TOKEN_FILE)" == "$planner_token" &&
   "$(env_value "$planner_env" FAI_HERMES_PLANNING_MODEL_CREDENTIAL_FILE)" == "$model_credential" &&
   "$(env_value "$planner_env" FAI_HERMES_PLANNING_SOCKET)" == /run/fai-hermes-planner/planner.sock &&
   "$(env_value "$planner_env" FAI_HERMES_PLANNING_EXPECTED_CLIENT_UID)" == 1000 &&
   "$(env_value "$planner_env" FCP_HERMES_CONFIG_SHA256)" == "$(sha256sum "$planner_config" | awk '{print $1}')" ]] || {
  echo "planner environment binding mismatch" >&2; exit 1;
}
planning_enabled="$(env_value "$planner_env" FAI_HERMES_PLANNING_ENABLED)"
[[ "$planning_enabled" == true || "$planning_enabled" == false ]] || { echo "planner enabled binding invalid" >&2; exit 1; }
[[ "$(env_value "$production_env" HERMES_SEMANTIC_PLANNING_ENABLED)" == "$planning_enabled" ]] || {
  echo "web/planner enabled state mismatch" >&2; exit 1;
}
for denied in /var/lib/fai-hermes-controller /etc/fai-hermes-controller /var/lib/fai-codex-executor /etc/fai-codex-executor; do
  runuser -u "$planner_user" -- test ! -r "$denied" || { echo "planner can access protected runtime tree" >&2; exit 1; }
done
for denied in /etc/fai-control-plane/production.env /etc/fai-control-plane/secrets/runtime-observation-token /etc/fai-control-plane/secrets/local-runner-token; do
  runuser -u "$planner_user" -- test ! -r "$denied" || { echo "planner can access production/controller secret" >&2; exit 1; }
done

[[ -d "$release_root" && ! -L "$release_root" ]] || { echo "exact immutable shared release is not installed" >&2; exit 1; }
/usr/bin/python3 "$release_root/scripts/hermes_runner_bundle.py" verify-install "$release_root" "$release_commit" "$release_sha256"
unit_source=$release_root/infra/production/fai-hermes-planner.service
tmpfiles_source=$release_root/infra/production/fai-hermes-planner.tmpfiles
health_client=$release_root/scripts/hermes_planner_health.py
for file in "$unit_source" "$tmpfiles_source" "$health_client" "$hermes_python"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "planner release file missing" >&2; exit 1; }
done
rendered="$(mktemp --suffix=.service)"; sed "s/@RELEASE_COMMIT@/$release_commit/g" "$unit_source" >"$rendered"
systemd-analyze verify "$rendered"
if [[ "$dry_run" == true ]]; then
  rm -f "$rendered"
  echo "dry-run: dedicated planner identity, files, isolation, CAS release and staged unit validated"
  exit 0
fi

unit=/etc/systemd/system/fai-hermes-planner.service
tmpfiles=/etc/tmpfiles.d/fai-hermes-planner.conf
unit_backup="$(mktemp)"; tmpfiles_backup="$(mktemp)"; had_unit=false; had_tmpfiles=false
[[ ! -e "$unit" ]] || { cp --preserve=all "$unit" "$unit_backup"; had_unit=true; }
[[ ! -e "$tmpfiles" ]] || { cp --preserve=all "$tmpfiles" "$tmpfiles_backup"; had_tmpfiles=true; }
was_active="$(systemctl is-active fai-hermes-planner.service 2>/dev/null || true)"
was_enabled="$(systemctl is-enabled fai-hermes-planner.service 2>/dev/null || true)"
unit_staged="$(mktemp /etc/systemd/system/.fai-hermes-planner.service.XXXXXX)"
tmpfiles_staged="$(mktemp /etc/tmpfiles.d/.fai-hermes-planner.conf.XXXXXX)"
rollback() {
  trap - ERR
  rm -f "$unit_staged" "$tmpfiles_staged"
  if [[ "$had_unit" == true ]]; then install -m 0644 -o root -g root "$unit_backup" "$unit"; else rm -f "$unit"; fi
  if [[ "$had_tmpfiles" == true ]]; then install -m 0644 -o root -g root "$tmpfiles_backup" "$tmpfiles"; else rm -f "$tmpfiles"; fi
  [[ "$had_tmpfiles" == false ]] || systemd-tmpfiles --create "$tmpfiles"
  systemctl daemon-reload
  if [[ "$was_active" == active ]]; then systemctl restart fai-hermes-planner.service; else systemctl stop fai-hermes-planner.service 2>/dev/null || true; fi
  [[ "$was_enabled" == enabled ]] && systemctl enable fai-hermes-planner.service >/dev/null || systemctl disable fai-hermes-planner.service >/dev/null 2>&1 || true
  [[ "$had_tmpfiles" == true ]] || rmdir /run/fai-hermes-planner 2>/dev/null || true
  echo "planner activation rolled back without changing controller or executor" >&2
}
trap rollback ERR
install -m 0644 -o root -g root "$rendered" "$unit_staged"
install -m 0644 -o root -g root "$tmpfiles_source" "$tmpfiles_staged"
mv -T -- "$unit_staged" "$unit"
mv -T -- "$tmpfiles_staged" "$tmpfiles"
systemd-tmpfiles --create "$tmpfiles"
[[ "$(stat -c '%U:%G:%a' /run/fai-hermes-planner)" == "$planner_user:$planner_user:2711" ]]
systemctl daemon-reload
[[ "$(systemctl show fai-hermes-planner.service -p User --value)" == "$planner_user" &&
   "$(systemctl show fai-hermes-planner.service -p Group --value)" == "$planner_user" &&
   "$(systemctl show fai-hermes-planner.service -p NoNewPrivileges --value)" == yes &&
   -z "$(systemctl show fai-hermes-planner.service -p SupplementaryGroups --value)" &&
   "$(systemctl show fai-hermes-planner.service -p UMask --value)" == 0077 &&
   "$(systemctl show fai-hermes-planner.service -p ReadWritePaths --value)" == /run/fai-hermes-planner &&
   "$(systemctl show fai-hermes-planner.service -p FragmentPath --value)" == "$unit" ]]
effective_inaccessible="$(systemctl show fai-hermes-planner.service -p InaccessiblePaths --value)"
for denied in /var/lib/fai-hermes-controller /etc/fai-hermes-controller /var/lib/fai-codex-executor /etc/fai-codex-executor /etc/fai-control-plane /root /home; do
  [[ " $effective_inaccessible " == *" $denied "* ]]
done
if [[ "$planning_enabled" == true ]]; then
  systemctl enable fai-hermes-planner.service
  systemctl restart fai-hermes-planner.service
  pid="$(systemctl show fai-hermes-planner.service -p MainPID --value)"
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$(readlink -f "/proc/$pid/exe")" == "$hermes_python" ]]
  tr '\0' '\n' <"/proc/$pid/cmdline" | grep -Fx "$release_root/packages/runners/runtime/hermes_project_planner_socket.py" >/dev/null
  client_user="$(getent passwd 1000 | cut -d: -f1)"; [[ -n "$client_user" ]]
  runuser -u "$client_user" -- /usr/bin/python3 "$health_client" --socket /run/fai-hermes-planner/planner.sock \
    --token-file "$web_token" --release-commit "$release_commit"
else
  systemctl disable --now fai-hermes-planner.service
fi
trap - ERR
rm -f "$rendered" "$unit_backup" "$tmpfiles_backup" "$unit_staged" "$tmpfiles_staged"
echo "planner activation complete for exact commit $release_commit; controller and executor were not modified or restarted"
