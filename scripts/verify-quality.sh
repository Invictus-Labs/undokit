#!/usr/bin/env bash
# UndoKit local quality gate (QA-owned). No GitHub Actions: this script is the gate.
#
#   bash scripts/verify-quality.sh
#
# Runs every step even when an earlier one fails, prints a table, writes a receipt JSON and exits:
#   0  every required step passed (live and human criteria are reported separately, see VERDICT)
#   1  at least one required step failed, was skipped for a failed dependency, or could not run
#
# Environment (all optional):
#   UNDOKIT_NODE_BIN_DIR       directory holding a supported node (>= 22.12) to put first on PATH
#   UNDOKIT_LIVE_SANDBOX=1     also run the live-provider drill (AC-07); otherwise it is reported NOT RUN
#   UNDOKIT_RECEIPT_DIR        where the receipt JSON goes (default: .undokit/receipts, git-ignored)
#   UNDOKIT_KEEP_WORK=1        keep the clean temp work dir for inspection
#
# Uncertainty never becomes success: a missing scanner, a missing browser or an empty test run is a FAILURE here,
# never a skip.

set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$ROOT/scripts/verify-quality.sh"
cd "$ROOT" || exit 1

if [ -n "${UNDOKIT_NODE_BIN_DIR:-}" ]; then
  PATH="$UNDOKIT_NODE_BIN_DIR:$PATH"
  export PATH
fi

MODE="full"
if [ "${1:-}" = "--seeded-control-inner" ]; then
  MODE="seeded-inner"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/undokit-gate.XXXXXX")" || exit 1
STEPS_TSV="$WORK/steps.tsv"
: > "$STEPS_TSV"
mkdir -p "$WORK/tmp"
# Every step (including packaged-CLI e2e in fresh temp dirs) works inside this clean, disposable temp root.
export TMPDIR="$WORK/tmp"
cleanup() {
  if [ "${UNDOKIT_KEEP_WORK:-0}" = "1" ]; then
    echo "work dir kept: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

FAILED=0
NOTRUN=0
BUILD_OK=0

record() { # name status exit_code started seconds command
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >> "$STEPS_TSV"
}

run_step() { # name command...
  local name="$1"
  shift
  local started start end rc
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  start="$(date +%s)"
  printf '\n=== STEP %s ===\n' "$name"
  "$@"
  rc=$?
  end="$(date +%s)"
  if [ "$rc" -eq 0 ]; then
    record "$name" PASS "$rc" "$started" "$((end - start))" "$*"
    printf -- '--- %s: PASS (%ss)\n' "$name" "$((end - start))"
  else
    record "$name" FAIL "$rc" "$started" "$((end - start))" "$*"
    printf -- '--- %s: FAIL exit=%s (%ss)\n' "$name" "$rc" "$((end - start))"
    FAILED=$((FAILED + 1))
  fi
  return 0
}

skip_step() { # name reason
  printf -- '\n=== STEP %s ===\n--- %s: FAIL (skipped, %s)\n' "$1" "$1" "$2"
  record "$1" FAIL 99 "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 "skipped: $2"
  FAILED=$((FAILED + 1))
}

notrun_step() { # name reason
  printf -- '\n=== STEP %s ===\n--- %s: NOT RUN (%s)\n' "$1" "$1" "$2"
  record "$1" NOT_RUN 0 "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 "not run: $2"
  NOTRUN=$((NOTRUN + 1))
}

# ---------------------------------------------------------------- seeded inner mode
# Used only by the negative control: one mandatory step that must fail, so the verdict must be RED.
if [ "$MODE" = "seeded-inner" ]; then
  run_step seeded-mandatory-failure false
  if [ "$FAILED" -gt 0 ]; then
    echo "VERDICT: RED"
    exit 1
  fi
  echo "VERDICT: GREEN"
  exit 0
fi

# ---------------------------------------------------------------- steps
step_runtime() {
  node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj < 22 || (maj === 22 && min < 12)) { console.error("node " + process.versions.node + " is below the supported 22.12"); process.exit(1); }
    console.log("node " + process.versions.node);
  '
}

step_deps_present() {
  if [ ! -d node_modules ]; then
    echo "node_modules missing. Run: npm ci"
    return 1
  fi
  return 0
}

step_typecheck() { npm run --silent typecheck; }
step_build() { npm run --silent build; }

step_tests_coverage() {
  # Single run: unit, integration (including the packaged-CLI e2e in fresh temp dirs) and web render tests,
  # with the 90% line and branch floor enforced by vitest.config.ts.
  npm run --silent test:coverage || return 1
  if [ -f coverage/coverage-summary.json ]; then
    node -e '
      const s = require("./coverage/coverage-summary.json").total;
      console.log("coverage lines=" + s.lines.pct + "% branches=" + s.branches.pct + "% statements=" + s.statements.pct + "% functions=" + s.functions.pct + "%");
      if (s.lines.pct < 90 || s.branches.pct < 90) { console.error("coverage below the 90% floor"); process.exit(1); }
    ' || return 1
  else
    echo "coverage/coverage-summary.json missing"
    return 1
  fi
}

step_pack() {
  local packdir="$WORK/pack"
  mkdir -p "$packdir/x"
  npm pack --pack-destination "$packdir" --json > "$packdir/pack.json" 2> "$packdir/pack.err" || { cat "$packdir/pack.err"; return 1; }
  node -e '
    const fs = require("fs");
    const files = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0].files.map((f) => f.path);
    const need = ["dist/src/cli/main.js", "dist/web/index.html", "package.json", "LICENSE"];
    const needPrefix = ["schemas/", "migrations/", "templates/"];
    const missing = need.filter((n) => !files.includes(n)).concat(needPrefix.filter((p) => !files.some((f) => f.startsWith(p))));
    if (missing.length) { console.error("packed artifact is missing: " + missing.join(", ")); process.exit(1); }
    console.log("packed artifact contains " + files.length + " files, required entries present");
  ' "$packdir/pack.json" || return 1
  local tgz
  tgz="$(ls "$packdir"/*.tgz 2>/dev/null | head -n 1)"
  [ -n "$tgz" ] || { echo "no tarball produced"; return 1; }
  if command -v shasum > /dev/null 2>&1; then
    ARTIFACT_SHA256="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
  else
    ARTIFACT_SHA256="$(sha256sum "$tgz" | cut -d' ' -f1)"
  fi
  echo "artifact sha256 $ARTIFACT_SHA256"
  tar -xzf "$tgz" -C "$packdir/x" || return 1
  node scripts/secret-scan.mjs --dir "$packdir/x"
}

step_browser_smoke() { npx playwright test; }

step_sec_scan() {
  if ! command -v sec-scan > /dev/null 2>&1; then
    echo "sec-scan is not installed; cannot claim a clean external scan"
    return 1
  fi
  sec-scan "$ROOT"
  local rc=$?
  # Program rule: exit 0 (clean) or 1 (warnings, reported) are acceptable; anything else is a failure.
  if [ "$rc" -le 1 ]; then
    [ "$rc" -eq 1 ] && echo "sec-scan reported warnings (exit 1): review the output above"
    return 0
  fi
  return "$rc"
}

step_secret_scan() { node scripts/secret-scan.mjs; }

step_sanitize() {
  if ! command -v sanitize-content > /dev/null 2>&1; then
    echo "sanitize-content is not installed; cannot claim public hygiene"
    return 1
  fi
  local files=()
  local f
  while IFS= read -r f; do
    [ -f "$f" ] && files+=("$f")
  done < <(git ls-files -co --exclude-standard | grep -v -E '^package-lock\.json$')
  [ "${#files[@]}" -gt 0 ] || { echo "no files to scan"; return 1; }
  sanitize-content --scope public "${files[@]}"
}

step_license_audit() { node scripts/license-audit.mjs --check; }

# Negative controls: each one must observe a FAILURE from the tool under test. If a control sees success,
# the control itself fails, because the gate would not catch a real regression.
step_negative_controls() {
  local rc ctl="$WORK/controls"
  mkdir -p "$ctl"

  # 1. Gate-level: a seeded mandatory failure must make the whole gate exit non-zero with VERDICT: RED.
  local out
  out="$(bash "$SELF" --seeded-control-inner 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! printf '%s' "$out" | grep -q 'VERDICT: RED'; then
    echo "CONTROL FAILED: seeded mandatory failure did not turn the gate red (exit=$rc)"
    return 1
  fi
  echo "control 1 ok: seeded mandatory failure turns the gate red"

  # 2. A failing test must make the test runner exit non-zero (exit codes are not swallowed).
  mkdir -p "$ctl/vt"
  printf 'test("seeded failure", () => { expect(1).toBe(2); });\n' > "$ctl/vt/seeded.test.ts"
  npx vitest run --root "$ctl/vt" --globals --config false > "$ctl/vt.out" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "CONTROL FAILED: a seeded failing test exited 0"
    return 1
  fi
  echo "control 2 ok: seeded failing test exits $rc"

  # 3. A planted fake secret must be caught by the secret scanner.
  local needle
  needle="$(node -e 'process.stdout.write(require("./fixtures/planted-fakes.json").needles[0])')"
  printf 'token = %s\n' "$needle" > "$ctl/planted.txt"
  node scripts/secret-scan.mjs --file "$ctl/planted.txt" > "$ctl/secret.out" 2>&1
  rc=$?
  if [ "$rc" -ne 1 ]; then
    echo "CONTROL FAILED: planted secret was not flagged (exit=$rc)"
    return 1
  fi
  if grep -q "$needle" "$ctl/secret.out"; then
    echo "CONTROL FAILED: scanner printed the secret value"
    return 1
  fi
  echo "control 3 ok: planted secret flagged and not echoed"

  # 4. Public hygiene scanner must flag a planted raw UUID (built at runtime so this script holds no UUID literal).
  if command -v sanitize-content > /dev/null 2>&1; then
    printf 'Config id: %s-%s-%s-%s-%s\n' 7f3a9c1e 4b2d 4e8a 9c61 0a1b2c3d4e5f > "$ctl/planted-id.md"
    sanitize-content --scope public "$ctl/planted-id.md" > "$ctl/sanitize.out" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "CONTROL FAILED: sanitize-content accepted a planted raw UUID"
      return 1
    fi
    echo "control 4 ok: planted raw UUID flagged (exit $rc)"
  else
    echo "CONTROL FAILED: sanitize-content missing, control 4 cannot run"
    return 1
  fi
  return 0
}

step_live_sandbox() {
  UNDOKIT_LIVE_SANDBOX=1 npx vitest run tests/integration/live-sandbox.test.ts
}

# ---------------------------------------------------------------- run
echo "UndoKit quality gate"
echo "root: $ROOT"
echo "start (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"

run_step runtime step_runtime
run_step deps-present step_deps_present

run_step typecheck step_typecheck
run_step build step_build
if grep -q $'^build\tPASS' "$STEPS_TSV"; then BUILD_OK=1; fi

if [ "$BUILD_OK" -eq 1 ]; then
  run_step tests-and-coverage step_tests_coverage
  run_step package-artifact step_pack
  run_step browser-smoke step_browser_smoke
else
  skip_step tests-and-coverage "build failed"
  skip_step package-artifact "build failed"
  skip_step browser-smoke "build failed"
fi

run_step secret-scan step_secret_scan
run_step sec-scan step_sec_scan
run_step sanitize-public step_sanitize
run_step license-audit step_license_audit
run_step negative-controls step_negative_controls

if [ "${UNDOKIT_LIVE_SANDBOX:-0}" = "1" ]; then
  run_step live-sandbox-ac07 step_live_sandbox
else
  notrun_step live-sandbox-ac07 "opt-in; set UNDOKIT_LIVE_SANDBOX=1 with the real local provider running"
fi
notrun_step human-drill-ac11 "PENDING_HUMAN_RECEIPT: a non-builder human must run docs/HUMAN-DRILL.md"

# ---------------------------------------------------------------- receipt and verdict
SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
FIXTURE_VERSION="$(node -e 'process.stdout.write(require("./fixtures/demo.json").fixture_version)' 2>/dev/null || echo unknown)"
RECEIPT_DIR="${UNDOKIT_RECEIPT_DIR:-$ROOT/.undokit/receipts}"
mkdir -p "$RECEIPT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RECEIPT="$RECEIPT_DIR/gate-$STAMP.json"
node scripts/write-receipt.mjs "$STEPS_TSV" "$RECEIPT" \
  "sha=$SHA" "dirty_files=$DIRTY" "node=$(node -v 2>/dev/null)" "platform=$(uname -s)-$(uname -m)" \
  "fixture_version=$FIXTURE_VERSION" "artifact_sha256=${ARTIFACT_SHA256:-none}" "finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /dev/null

printf '\n%-24s %-8s %s\n' STEP STATUS EXIT
while IFS=$'\t' read -r name status code _started _secs _cmd; do
  printf '%-24s %-8s %s\n' "$name" "$status" "$code"
done < "$STEPS_TSV"
printf '\nsha=%s dirty_files=%s receipt=%s\n' "$SHA" "$DIRTY" "$RECEIPT"

if [ "$FAILED" -gt 0 ]; then
  echo "VERDICT: RED ($FAILED required step(s) failed)"
  exit 1
fi
echo "VERDICT: GREEN-LOCAL (all required local steps passed; $NOTRUN row(s) NOT RUN: AC-07 live drill unless opted in, AC-11 PENDING_HUMAN_RECEIPT). This is NOT a claim that the AC matrix passed."
exit 0
