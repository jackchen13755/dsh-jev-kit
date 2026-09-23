#!/usr/bin/env bash
#
# Install (or refresh) this repository's pre-push privacy scan.
#
#   bash scripts/install-hooks.sh            # into the current repository
#   bash scripts/install-hooks.sh --all      # also into sibling dsh-* checkouts
#
# It copies rather than symlinks on purpose: a hook that silently follows a moved
# or deleted script would stop scanning without anyone noticing, and "no findings"
# from a hook that is not running is exactly the failure this is meant to prevent.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook="$here/pre-push"
[ -f "$hook" ] || { echo "找不到 $hook" >&2; exit 1; }

install_into () {
  local repo="$1"
  [ -d "$repo/.git/hooks" ] || { echo "  跳过（不是 git 仓库）: $repo"; return; }
  # Three hooks, three events: privacy at push time, i18n + scope at commit time,
  # message-vs-diff right after the message exists. Each one is copied rather than
  # symlinked, and none of them clobbers a hook written by someone else.
  for name in pre-push pre-commit commit-msg; do
    src="$here/$name"
    [ -f "$src" ] || continue
    if [ -f "$repo/.git/hooks/$name" ] && ! grep -q "dsh-jev-kit" "$repo/.git/hooks/$name" 2>/dev/null; then
      echo "  ⚠️ $repo 已有别人的 $name，未覆盖（请手工合并 $src）"
      continue
    fi
    cp "$src" "$repo/.git/hooks/$name"
    chmod +x "$repo/.git/hooks/$name"
    echo "  ✓ $name → $repo/.git/hooks/"
  done
}

if [ "${1:-}" = "--all" ]; then
  for repo in "$here/.." "$here/../../dsh-jev-lens" "$here/../../dsh-source-control" "$here/../../dsh-fetch-page"; do
    [ -d "$repo/.git" ] && install_into "$(cd "$repo" && pwd)"
  done
else
  install_into "$(git rev-parse --show-toplevel)"
fi

echo
echo "用法：正常 git push 即可。"
echo "  JEV_SKIP_PRIVACY=1  跳过扫描    JEV_ALLOW_PUSH=1  有发现但不阻塞"
