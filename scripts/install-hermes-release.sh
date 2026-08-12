#!/usr/bin/env bash
# Validate and atomically install one immutable Hermes release. This script
# deliberately does not mutate or inspect any systemd service.
set -Eeuo pipefail

dry_run=false; release_commit=; release_bundle=; release_sha256=
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    --release-commit=*) release_commit="${argument#*=}" ;;
    --release-bundle=*) release_bundle="${argument#*=}" ;;
    --release-sha256=*) release_sha256="${argument#*=}" ;;
    *) echo "invalid argument" >&2; exit 2 ;;
  esac
done
[[ "$release_commit" =~ ^[0-9a-f]{40}$ && "$release_sha256" =~ ^[0-9a-f]{64}$ &&
   "$release_bundle" = /* && -f "$release_bundle" && ! -L "$release_bundle" ]] || {
  echo "exact absolute release artifact, commit and SHA-256 are required" >&2; exit 2;
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
verifier="$repo_root/scripts/hermes_runner_bundle.py"
[[ -f "$verifier" && ! -L "$verifier" ]] || { echo "bundle verifier missing" >&2; exit 1; }
/usr/bin/python3 "$verifier" verify "$release_bundle" "$release_commit" "$release_sha256"
if [[ "$dry_run" == true ]]; then
  echo "dry-run: exact Hermes bundle validated; no release or service state changed"
  exit 0
fi
[[ "$(id -u)" == 0 ]] || { echo "release installation must run as root" >&2; exit 1; }

release_parent=/opt/fai-control-plane-runner/releases
artifact_parent=/opt/fai-control-plane-runner/release-artifacts
release_root="$release_parent/$release_commit"
artifact="$artifact_parent/${release_commit}-${release_sha256}.tar.gz"
install -d -m 0755 -o root -g root /opt/fai-control-plane-runner "$release_parent" "$artifact_parent"
for parent in /opt/fai-control-plane-runner "$release_parent" "$artifact_parent"; do
  [[ -d "$parent" && ! -L "$parent" && "$(readlink -f "$parent")" == "$parent" &&
     "$(stat -c '%U:%G:%a' "$parent")" == root:root:755 ]] || {
    echo "release parent binding mismatch" >&2; exit 1;
  }
done

if [[ -e "$artifact" ]]; then
  [[ -f "$artifact" && ! -L "$artifact" && "$(stat -c '%U:%G:%a' "$artifact")" == root:root:444 &&
     "$(sha256sum "$artifact" | awk '{print $1}')" == "$release_sha256" ]] || {
    echo "existing release artifact identity mismatch" >&2; exit 1;
  }
else
  artifact_staged="$(mktemp "$artifact_parent/.artifact-${release_commit}.XXXXXX")"
  trap 'rm -f -- "${artifact_staged:-}"; [[ -z "${release_staged:-}" || "$release_staged" != "$release_parent"/.staging-* ]] || rm -rf -- "$release_staged"' EXIT
  install -m 0444 -o root -g root "$release_bundle" "$artifact_staged"
  [[ "$(sha256sum "$artifact_staged" | awk '{print $1}')" == "$release_sha256" ]]
  mv -T -- "$artifact_staged" "$artifact"
  artifact_staged=
fi

if [[ -e "$release_root" ]]; then
  /usr/bin/python3 "$release_root/scripts/hermes_runner_bundle.py" verify-install \
    "$release_root" "$release_commit" "$release_sha256"
else
  release_staged="$(mktemp -d "$release_parent/.staging-${release_commit}.XXXXXX")"
  trap 'rm -f -- "${artifact_staged:-}"; [[ -z "${release_staged:-}" || "$release_staged" != "$release_parent"/.staging-* ]] || rm -rf -- "$release_staged"' EXIT
  tar -xzf "$artifact" --no-same-owner --strip-components=1 -C "$release_staged"
  /usr/bin/python3 "$release_staged/scripts/hermes_runner_bundle.py" verify \
    "$artifact" "$release_commit" "$release_sha256"
  printf '%s\n' "$release_sha256" >"$release_staged/RELEASE_ARTIFACT_SHA256"
  chown -R root:root "$release_staged"
  find "$release_staged" -type d -exec chmod 0555 {} +
  chmod 0644 "$release_staged/RELEASE_ARTIFACT_SHA256"
  /usr/bin/python3 "$release_staged/scripts/hermes_runner_bundle.py" verify-install \
    "$release_staged" "$release_commit" "$release_sha256"
  mv -T -- "$release_staged" "$release_root"
  release_staged=
fi
trap - EXIT
echo "immutable Hermes release installed for exact commit $release_commit; no service state changed"
