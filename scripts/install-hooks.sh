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
  # Refuse to clobber someone else's hook without saying so.
  if [ -f "$repo/.git/hooks/pre-push" ] && ! grep -q "dsh-jev-kit" "$repo/.git/hooks/pre-push" 2>/dev/null; then
    echo "  ⚠️ $repo 已有别人的 pre-push，未覆盖（请手工合并 $hook）"
    return
  fi
  cp "$hook" "$repo/.git/hooks/pre-push"
  chmod +x "$repo/.git/hooks/pre-push"
  echo "  ✓ 已安装: $repo/.git/hooks/pre-push"
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
