#!/bin/sh
set -eu

core_dir=${PAPERCLIP_CORE_DIR:?Set PAPERCLIP_CORE_DIR to the pinned Paperclip checkout.}
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../plugins/fai-control" && pwd)
expected_core_sha=65ec059bde30d98c92165b24a30a540800dd1f6f
git_bin=${FAI_GIT_BIN:-git}
if [ -z "${FAI_GIT_BIN:-}" ] && [ -x /Library/Developer/CommandLineTools/usr/bin/git ]; then
  git_bin=/Library/Developer/CommandLineTools/usr/bin/git
fi
actual_core_sha=$("$git_bin" -C "$core_dir" rev-parse HEAD)

if [ "$actual_core_sha" != "$expected_core_sha" ]; then
  echo "Expected Paperclip $expected_core_sha; found $actual_core_sha" >&2
  exit 1
fi
if [ -n "$("$git_bin" -C "$core_dir" status --porcelain --untracked-files=no)" ]; then
  echo "Paperclip tracked sources must be unchanged." >&2
  exit 1
fi

pnpm9() {
  npm exec --yes --package=pnpm@9.15.4 -- pnpm --dir "$core_dir" "$@"
}

mkdir -p "$plugin_dir/.paperclip-sdk"
pnpm9 install --frozen-lockfile
pnpm9 --filter @paperclipai/shared build
pnpm9 --filter @paperclipai/plugin-sdk build
npm exec --yes --package=pnpm@9.15.4 -- pnpm --dir "$core_dir/packages/shared" pack \
  --pack-destination "$plugin_dir/.paperclip-sdk"
npm exec --yes --package=pnpm@9.15.4 -- pnpm --dir "$core_dir/packages/plugins/sdk" pack \
  --pack-destination "$plugin_dir/.paperclip-sdk"
(cd "$plugin_dir" && npm exec --yes --package=pnpm@9.15.4 -- pnpm install --ignore-workspace && npm exec --yes --package=pnpm@9.15.4 -- pnpm build)

echo "Built f(AI) plugin at $plugin_dir using Paperclip $actual_core_sha"
