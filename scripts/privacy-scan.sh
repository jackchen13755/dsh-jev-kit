#!/usr/bin/env bash
# Pre-push privacy scan for this repository.
#
# Written after GitHub's push protection rejected a push that an earlier version of
# this scan would have missed: the fixture corpus carried "secrets" in *real vendor
# formats* (a Slack `xoxb-` token and a Stripe `sk_live_` key), which no scanner —
# including GitHub's — can distinguish from live credentials. Two lessons are baked
# in:
#
#   1. Scan the **content that will be pushed**, not a diff. A diff of a rewrite
#      contains the removed lines, so a scanner reading it fails on text that is
#      about to disappear (that mistake was made once, here).
#   2. Separate **hard failures** (vendor-shaped credentials: never intentional in a
#      public repository) from **warnings** (home paths, internal domains, phones:
#      this repository's fixtures use them deliberately, with fictional names).
#
# Usage: bash scripts/privacy-scan.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

HARD=0
echo "硬失败（厂商形态凭据，公开仓库里不可能是故意的）："
while IFS='|' read -r label pattern; do
  [ -z "$label" ] && continue
  hits=$(git grep -nEI "$pattern" -- . | wc -l | tr -d ' ')
  printf '  %-22s %s\n' "$label" "$hits"
  [ "$hits" != "0" ] && { HARD=1; git grep -nEI "$pattern" -- . | head -3 | sed 's/^/      /'; }
done <<'PATTERNS'
github token|ghp_[A-Za-z0-9]{20,}
github pat|github_pat_[A-Za-z0-9_]{20,}
openai-style key|sk-[A-Za-z0-9]{20,}
stripe live key|sk_live_[A-Za-z0-9]{10,}
slack token|xox[baprs]-[A-Za-z0-9-]{10,}
aws key id|AKIA[0-9A-Z]{16}
private key body|MIIE[A-Za-z0-9+/]{20,}
PATTERNS

echo "警告（本仓库夹具故意包含，确认新增项仍是虚构的）："
while IFS='|' read -r label pattern; do
  [ -z "$label" ] && continue
  hits=$(git grep -nEI "$pattern" -- . | wc -l | tr -d ' ')
  printf '  %-22s %s\n' "$label" "$hits"
  [ "$hits" != "0" ] && git grep -nEI "$pattern" -- . | head -2 | sed 's/^/      /'
done <<'PATTERNS'
home path|/Users/[a-z][a-z0-9._-]+
internal domain|shangri-la|sgrl\.io|acme-corp\.internal
phone (CN)|[^0-9]1[3-9][0-9]{9}[^0-9]
private key header|BEGIN [A-Z ]*PRIVATE KEY
PATTERNS

if [ "$HARD" = "0" ]; then echo "✅ 无厂商形态凭据"; else echo "❌ 有厂商形态凭据，拒绝推送"; fi
exit "$HARD"
