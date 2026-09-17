#!/bin/sh
set -eu

core_dir=${PAPERCLIP_CORE_DIR:?Set PAPERCLIP_CORE_DIR to the pinned Paperclip checkout.}
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../plugins/fai-control" && pwd)
paperclip_home=${PAPERCLIP_HOME:-/private/tmp/fai-paperclip-home}
paperclip_port=${PAPERCLIP_SERVER_PORT:-3120}
git_bin=${FAI_GIT_BIN:-git}
if [ -z "${FAI_GIT_BIN:-}" ] && [ -x /Library/Developer/CommandLineTools/usr/bin/git ]; then
  git_bin=/Library/Developer/CommandLineTools/usr/bin/git
fi
if [ "$("$git_bin" -C "$core_dir" rev-parse HEAD)" != 65ec059bde30d98c92165b24a30a540800dd1f6f ] ||
   [ -n "$("$git_bin" -C "$core_dir" status --porcelain --untracked-files=no)" ]; then
  echo "Run requires the pinned, unchanged Paperclip Core checkout. See the plugin README." >&2
  exit 1
fi

FAI_GIT_BIN="$git_bin" PAPERCLIP_HOME="$paperclip_home" PAPERCLIP_SERVER_PORT="$paperclip_port" PORT="$paperclip_port" \
  npm exec --yes --package=pnpm@9.15.4 -- pnpm --dir "$core_dir" paperclipai run

# In a separate shell after local onboarding:
# PAPERCLIP_API_URL="http://127.0.0.1:$paperclip_port" \
#   npm exec --yes --package=pnpm@9.15.4 -- pnpm --dir "$core_dir" paperclipai plugin install "$plugin_dir"
