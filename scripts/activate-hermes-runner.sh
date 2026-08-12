#!/usr/bin/env bash
set -euo pipefail

dry_run=false; confirmed=false; release_commit=; release_bundle=; release_sha256=
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    --confirm-activate-fai-hermes-runner) confirmed=true ;;
    --release-commit=*) release_commit="${argument#*=}" ;;
    --release-bundle=*) release_bundle="${argument#*=}" ;;
    --release-sha256=*) release_sha256="${argument#*=}" ;;
    *) echo "invalid argument" >&2; exit 2 ;;
  esac
done
[[ "$dry_run" == true || "$confirmed" == true ]] || { echo "explicit confirmation required" >&2; exit 2; }
[[ "$release_commit" =~ ^[0-9a-f]{40}$ && "$release_sha256" =~ ^[0-9a-f]{64}$ &&
   "$release_bundle" = /* && -f "$release_bundle" && ! -L "$release_bundle" ]] || {
  echo "exact absolute release artifact, commit and SHA-256 are required" >&2; exit 2;
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$(/usr/bin/git -C "$repo_root" rev-parse HEAD)" == "$release_commit" &&
   -z "$(/usr/bin/git -C "$repo_root" status --porcelain)" ]] || {
  echo "activation must run from the exact clean release commit" >&2; exit 1;
}
bundle_verifier="$repo_root/scripts/hermes_runner_bundle.py"
[[ -f "$bundle_verifier" && ! -L "$bundle_verifier" ]] || { echo "bundle verifier missing" >&2; exit 1; }
/usr/bin/python3 "$bundle_verifier" verify "$release_bundle" "$release_commit" "$release_sha256" "$repo_root" || {
  echo "release bundle provenance validation failed" >&2; exit 1;
}

for command in /usr/bin/node /usr/bin/codex /usr/bin/git /usr/bin/systemctl /usr/bin/systemd-tmpfiles \
  /usr/bin/python3 /usr/local/bin/hermes /usr/local/lib/hermes-agent/venv/bin/python; do
  [[ -x "$command" ]] || { echo "missing prerequisite: $command" >&2; exit 1; }
done
[[ "$(/usr/bin/codex --version)" == "codex-cli 0.144.1" ]] || { echo "Codex version mismatch" >&2; exit 1; }
[[ "$(/usr/local/bin/hermes --version 2>/dev/null)" == *"0.18.2"* ]] || { echo "Hermes version mismatch" >&2; exit 1; }

transport_group=fai-hermes-transport
controller_user=fai-hermes-controller
executor_user=fai-codex-executor
controller_home=/var/lib/fai-hermes-controller
executor_home=/var/lib/fai-codex-executor

if [[ "$dry_run" == false ]]; then
  [[ "$(id -u)" == 0 ]] || { echo "activation must run as root" >&2; exit 1; }
  getent group "$transport_group" >/dev/null || groupadd --system "$transport_group"
  for user in "$controller_user" "$executor_user"; do
    getent group "$user" >/dev/null || groupadd --system "$user"
    if ! getent passwd "$user" >/dev/null; then
      useradd --system --gid "$user" --groups "$transport_group" --home-dir "/var/lib/$user" \
        --shell /usr/sbin/nologin "$user"
      usermod -L "$user"
    fi
  done
fi

controller_env=/etc/fai-hermes-controller/controller.env
executor_env=/etc/fai-codex-executor/executor.env
claim_token=$controller_home/credentials/claim-token
observation_token=$controller_home/credentials/observation-token
hermes_config=$controller_home/hermes/config.yaml
/usr/bin/python3 "$bundle_verifier" host-check || { echo "host identity or permission validation failed" >&2; exit 1; }

env_value() {
  local file="$1" key="$2" value
  value="$(awk -F= -v key="$key" '$1==key {if (++count>1) exit 3; print substr($0,index($0,"=")+1)} END{if(count!=1) exit 2}' "$file")" || {
    echo "missing or duplicate non-secret binding: $key" >&2; exit 1;
  }
  printf '%s' "$value"
}
controller_config_hash="$(env_value "$controller_env" FAI_HERMES_RUNNER_CONFIG_SHA256)"
executor_config_hash="$(env_value "$executor_env" FAI_EXECUTOR_EXPECTED_HERMES_CONFIG_SHA256)"
[[ "$controller_config_hash" == "$executor_config_hash" &&
   "$controller_config_hash" == "$(sha256sum "$hermes_config" | awk '{print $1}')" ]] || {
  echo "Hermes config binding mismatch" >&2; exit 1;
}
release_root="/opt/fai-control-plane-runner/releases/$release_commit"
[[ "$release_root" == /opt/fai-control-plane-runner/releases/* && "$release_root" != /opt/fai-control-plane/* ]] || {
  echo "release root must be outside the production checkout" >&2; exit 1;
}
controller_entrypoint="$(env_value "$controller_env" FAI_HERMES_RUNNER_ENTRYPOINT)"
executor_bundle="$(env_value "$executor_env" FAI_EXECUTOR_BUNDLE)"
[[ "$controller_entrypoint" == "$release_root/packages/runners/runtime/hermes_no_tools_orchestrator.py" &&
   "$executor_bundle" == "$release_root/packages/runners/dist/hermes-executor-cli.js" ]] || {
  echo "release paths are not pinned to the exact immutable release" >&2; exit 1;
}
[[ "$(env_value "$executor_env" FAI_CONTROLLER_UID)" == "$(id -u "$controller_user")" &&
   "$(env_value "$executor_env" FAI_EXECUTOR_CODEX_VERSION)" == "0.144.1" &&
   "$(env_value "$controller_env" FAI_HERMES_EXECUTOR_SOCKET)" == "/run/fai-hermes-executor/executor.sock" &&
   "$(env_value "$executor_env" FAI_EXECUTOR_SOCKET)" == "/run/fai-hermes-executor/executor.sock" ]] || {
  echo "controller UID, Codex version, or socket binding mismatch" >&2; exit 1;
}
repository="$(env_value "$executor_env" FAI_EXECUTOR_REPOSITORY)"
repository_root="$(env_value "$executor_env" FAI_EXECUTOR_REPOSITORY_ROOT)"
repository_remote="$(/usr/bin/git -C "$repository_root" config --get remote.origin.url)"
[[ "$repository" == "$(env_value "$controller_env" FAI_HERMES_RUNNER_REPOSITORY)" &&
   "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ && "$repository_root" == "$executor_home/repository" &&
   ( "$repository_remote" == "https://github.com/$repository.git" ||
     "$repository_remote" == "git@github.com:$repository.git" ) ]] || {
  echo "executor repository identity mismatch" >&2; exit 1;
}

if [[ "$dry_run" == true ]]; then
  echo "dry-run: release provenance, binaries, identities, files, permissions and bindings validated"
  echo "dry-run: would atomically install immutable release $release_commit outside the production checkout"
  exit 0
fi

install -d -m 0755 -o root -g root /opt/fai-control-plane-runner /opt/fai-control-plane-runner/releases
if [[ -e "$release_root" ]]; then
  [[ -d "$release_root" && ! -L "$release_root" && -f "$release_root/RELEASE_COMMIT" &&
     -f "$release_root/RELEASE_ARTIFACT_SHA256" &&
     "$(tr -d '\r\n' <"$release_root/RELEASE_COMMIT")" == "$release_commit" &&
     "$(tr -d '\r\n' <"$release_root/RELEASE_ARTIFACT_SHA256")" == "$release_sha256" ]] || {
    echo "existing release identity mismatch" >&2; exit 1;
  }
  /usr/bin/python3 "$release_root/scripts/hermes_runner_bundle.py" verify-install "$release_root" "$release_commit" "$release_sha256"
else
  staging="$(mktemp -d "/opt/fai-control-plane-runner/releases/.staging-${release_commit}.XXXXXX")"
  trap '[[ -n "${staging:-}" && "$staging" == /opt/fai-control-plane-runner/releases/.staging-* ]] && rm -rf -- "$staging"' EXIT
  tar -xzf "$release_bundle" --no-same-owner --strip-components=1 -C "$staging"
  /usr/bin/python3 "$staging/scripts/hermes_runner_bundle.py" verify "$release_bundle" "$release_commit" "$release_sha256"
  printf '%s\n' "$release_sha256" >"$staging/RELEASE_ARTIFACT_SHA256"
  chown -R root:root "$staging"
  find "$staging" -type d -exec chmod 0555 {} +
  chmod 0644 "$staging/RELEASE_ARTIFACT_SHA256"
  /usr/bin/python3 "$staging/scripts/hermes_runner_bundle.py" verify-install "$staging" "$release_commit" "$release_sha256"
  mv -T -- "$staging" "$release_root"
  staging=
  trap - EXIT
fi
executor_bundle_hash="$(env_value "$executor_env" FAI_EXECUTOR_BUNDLE_SHA256)"
[[ "$executor_bundle_hash" == "$(sha256sum "$executor_bundle" | awk '{print $1}')" ]] || {
  echo "executor bundle binding mismatch" >&2; exit 1;
}

controller_unit="$release_root/infra/production/fai-hermes-runner.service"
executor_unit="$release_root/infra/production/fai-codex-executor.service"
tmpfiles_source="$release_root/infra/production/fai-hermes-executor.tmpfiles"
for file in "$controller_unit" "$executor_unit" "$tmpfiles_source"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "release unit file missing" >&2; exit 1; }
done
controller_rendered="$(mktemp)"; executor_rendered="$(mktemp)"
trap 'rm -f -- "${controller_rendered:-}" "${executor_rendered:-}"' EXIT
sed "s/@RELEASE_COMMIT@/$release_commit/g" "$controller_unit" >"$controller_rendered"
sed "s/@RELEASE_COMMIT@/$release_commit/g" "$executor_unit" >"$executor_rendered"
install -m 0644 -o root -g root "$controller_rendered" /etc/systemd/system/fai-hermes-runner.service
install -m 0644 -o root -g root "$executor_rendered" /etc/systemd/system/fai-codex-executor.service
install -m 0644 -o root -g root "$tmpfiles_source" /etc/tmpfiles.d/fai-hermes-executor.conf
systemd-tmpfiles --create /etc/tmpfiles.d/fai-hermes-executor.conf
[[ "$(stat -c '%U:%G:%a' /run/fai-hermes-executor)" == "fai-codex-executor:fai-hermes-transport:2770" ]] || {
  echo "executor socket directory ownership/mode mismatch" >&2; exit 1;
}
systemd-analyze verify /etc/systemd/system/fai-hermes-runner.service /etc/systemd/system/fai-codex-executor.service
systemctl daemon-reload

assert_unit_property() {
  local unit="$1" property="$2" expected="$3" actual
  actual="$(systemctl show "$unit" --property="$property" --value)"
  [[ "$actual" == "$expected" ]] || { echo "effective systemd $property mismatch: $unit" >&2; exit 1; }
}
assert_unit_property fai-hermes-runner.service User "$controller_user"
assert_unit_property fai-hermes-runner.service Group "$controller_user"
assert_unit_property fai-hermes-runner.service NoNewPrivileges yes
assert_unit_property fai-hermes-runner.service SupplementaryGroups "$transport_group"
assert_unit_property fai-codex-executor.service User "$executor_user"
assert_unit_property fai-codex-executor.service Group "$executor_user"
assert_unit_property fai-codex-executor.service NoNewPrivileges yes
assert_unit_property fai-codex-executor.service SupplementaryGroups "$transport_group"
assert_unit_path_set() {
  local unit="$1" property="$2" expected="$3" actual path actual_count=0 expected_count=0
  actual="$(systemctl show "$unit" --property="$property" --value)"
  for path in $expected; do expected_count=$((expected_count + 1)); done
  for path in $actual; do
    [[ " $expected " == *" $path "* ]] || {
      echo "effective systemd $property includes an unexpected path: $unit" >&2; exit 1;
    }
    actual_count=$((actual_count + 1))
  done
  [[ "$actual_count" == "$expected_count" ]] || {
    echo "effective systemd $property path set mismatch: $unit" >&2; exit 1;
  }
}
assert_unit_path_set fai-hermes-runner.service ReadWritePaths \
  "/var/lib/fai-hermes-controller/state /var/lib/fai-hermes-controller/hermes"
assert_unit_path_set fai-codex-executor.service ReadWritePaths \
  "/var/lib/fai-codex-executor/repository /var/lib/fai-codex-executor/worktrees /var/lib/fai-codex-executor/artifacts /run/fai-hermes-executor /var/lib/fai-codex-executor/codex-home"
assert_unit_path_set fai-hermes-runner.service ReadOnlyPaths \
  "$release_root /usr/local/lib/hermes-agent /var/lib/fai-hermes-controller/hermes/config.yaml /var/lib/fai-hermes-controller/credentials"
assert_unit_path_set fai-codex-executor.service ReadOnlyPaths \
  "$release_root /usr/local/lib/hermes-agent /usr/bin/codex /usr/bin/git"
executor_inaccessible="$(systemctl show fai-codex-executor.service --property=InaccessiblePaths --value)"
for path in /etc/fai-control-plane /etc/fai-hermes-controller /var/lib/fai-hermes-controller; do
  [[ " $executor_inaccessible " == *" $path "* ]] || { echo "effective executor isolation mismatch" >&2; exit 1; }
done
controller_inaccessible="$(systemctl show fai-hermes-runner.service --property=InaccessiblePaths --value)"
for path in /var/lib/fai-codex-executor /etc/fai-codex-executor; do
  [[ " $controller_inaccessible " == *" $path "* ]] || { echo "effective controller isolation mismatch" >&2; exit 1; }
done

systemctl enable --now fai-codex-executor.service
systemctl start fai-hermes-runner.service
systemctl enable fai-hermes-runner.service
