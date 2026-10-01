#!/usr/bin/env bash
# Build the exact files a human drill participant is given (docs/HUMAN-DRILL.md) from the CURRENT committed tree:
#   undokit-<version>.tgz, undokit-<version>.tgz.sha256 (shasum format) and DRILL-KIT.txt (git SHA, tarball name, sha256).
# It refuses a dirty tree so the printed SHA is the SHA of what was packed. It needs a built tree (npm run build) and changes
# nothing in the repository. Usage: bash scripts/make-drill-kit.sh <output-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: bash scripts/make-drill-kit.sh <output-dir>}"
cd "$ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: the working tree is not clean, so the printed SHA would not describe the tarball" >&2
  exit 1
fi
[ -d dist ] || { echo "dist/ is missing: run 'npm run build' first" >&2; exit 1; }
mkdir -p "$OUT"
NAME="$(npm pack --silent --pack-destination "$OUT" | tail -n 1)"
cd "$OUT"
shasum -a 256 "$NAME" > "$NAME.sha256"
shasum -a 256 -c "$NAME.sha256"
SHA="$(cut -d' ' -f1 "$NAME.sha256")"
{
  echo "UndoKit drill kit"
  echo "git sha:        $(git -C "$ROOT" rev-parse HEAD)"
  echo "node (packing): $(node -v)"
  echo "tarball:        $NAME"
  echo "sha256:         $SHA"
  echo "sha256 prefix (first 12, for the receipt): ${SHA:0:12}"
  echo "built (UTC):    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee DRILL-KIT.txt
