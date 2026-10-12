# UndoKit

Recover an approved CRM field change without overwriting later work.

An automation updates the wrong fields on a CRM record. Recovering by guessing the old values risks
overwriting legitimate edits made after the incident. UndoKit wraps a small allowlist of scalar CRM
field updates in durable before/after receipts and offers human-approved, conflict-aware compensation:
it restores the recorded value only if the record is still exactly as UndoKit left it.

UndoKit is self-hosted and open source (MIT). The core is deterministic, makes no outbound network
calls, sends no telemetry and needs no license server, vendor account or paid provider.

## What it does

1. **Plan.** You describe a patch for one record (for example `lifecycle_stage: lead -> customer`).
   UndoKit checks it against the allowlist, reads the current value and version, and stores a before
   snapshot with a plan hash.
2. **Approve.** A human approves that exact plan hash. A changed patch or an expired approval is invalid.
3. **Apply.** The worker performs a conditional write using the provider's version precondition. If the
   record changed in the meantime the result is `CONFLICT` and nothing is overwritten.
4. **Compensate.** Later, UndoKit previews exactly which fields would be restored. A separate approval is
   required. If the current value or version no longer matches the recorded post-write state, compensation
   is blocked and the later edit is kept.

Every boundary appends evidence. Outcomes that cannot be confirmed stay visible as `UNKNOWN` until a
read-only reconciliation resolves them. UndoKit never retries a remote write blindly.

## Honest limits

- **Instrumented mutations only.** UndoKit can only undo changes that were made through it. Historical,
  uninstrumented changes cannot be reconstructed.
- **Atomic compare-and-set is required.** A connector without an atomic conditional write is read-only.
  A local check followed by an unconditional write is not accepted.
- **Scalar fields only.** Deletion, sends (email, messages, payments), nested values, arrays and unknown
  fields are rejected before any write.
- **No exactly-once claim.** UndoKit does not claim exactly-once external writes without provider support.
  After a crash it reports `UNKNOWN` and reconciles read-only.
- **No cross-provider transactions** and **no automatic rollback.** A human approves every apply and every
  compensation.
- **A restored backup cannot undo remote effects.** After a restore, reconcile external outcomes before
  enabling writes (see `docs/OPERATIONS.md`).
- **The simulator is not a live provider.** The built-in simulator makes the demo and the deterministic tests
  possible. Only a real provider run counts as a live drill, and its status is recorded in
  `docs/qa/AC-MATRIX.md`.
- **Pre-release.** The problem and willingness to pay are unvalidated product hypotheses. Read
  `docs/qa/AC-MATRIX.md` for what is and is not proven.

## Install

Requirements: Node.js 22.12 or newer.

From a release tarball with its checksum file:

```bash
shasum -a 256 -c undokit-0.1.0.tgz.sha256
mkdir undokit-try && cd undokit-try
npm install ../undokit-0.1.0.tgz
npx undokit version
```

From source:

```bash
npm ci
npm run build
node dist/src/cli/main.js version
```

Docker: `compose.yaml` currently provides only the local provider sandbox (`docs/OPERATIONS.md` section 2.6). A daemon
`Dockerfile` exists but has not been built or run, so it is unverified and not a supported install path yet.

## Synthetic smoke (about five minutes, no account, no network)

```bash
mkdir undokit-smoke && cd undokit-smoke
npx undokit demo --out ./out
npx undokit verify ./out/evidence.json
```

`demo` runs a synthetic scenario against the built-in simulator with a fixed UTC clock: plan, approve,
apply, a later edit by someone else, then a compensation preview. One record restores cleanly; the other is
blocked because the later edit must be kept. Open `out/report.html` in a browser to read the result.
`verify` re-checks the bundle hashes. The exit codes are listed by `npx undokit --help`.

The full guided procedure for a first-time operator, including timing and a cleanup receipt, is in
`docs/HUMAN-DRILL.md`.

## Daemon (API and web UI)

```bash
npx undokit admin bootstrap --email admin@example.test --workspace "My Workspace"
npx undokit serve
```

`serve` binds to `127.0.0.1` (this machine only) by default and prints the URL, normally
`http://localhost:8787`. Passing `--host 0.0.0.0` exposes it on every network interface; do that only behind
a trusted network or a TLS reverse proxy. There is no default password.

## Backup and restore

Two different things, both documented step by step in `docs/OPERATIONS.md`:

- **Evidence bundle** (`undokit export`, `undokit verify`, `undokit import`): a portable, redacted, hashed
  export that a clean installation can read. Truncated, damaged or unsupported bundles, and edits that do not
  recompute the hashes, are rejected without partial state. Integrity is **tamper-evident only**: there is no
  signature or authentication, so a bundle that was edited **and had every hash recomputed** still verifies and
  imports. A bundle proves it was not damaged or naively edited, not who made it.
- **Full backup** of the data directory or database together with the operator-managed encryption key.
  The key is not in the database, but **by default the key file is inside the data directory**, so a `tar` of the
  data directory contains it: keep the key elsewhere (`UNDOKIT_ENCRYPTION_KEY`, or `UNDOKIT_KEY_FILE`) with separate custody. The copy-the-directory procedure is documented but **not covered by an
  automated test**, there is no CLI backup command, and there is no tested PostgreSQL backup procedure
  (`docs/OPERATIONS.md` section 5). Restore into an isolated environment first.

## Quality gate

```bash
npm ci
bash scripts/verify-quality.sh
```

The gate runs typecheck, build, unit, integration and web tests, coverage (90% lines and branches floor),
the packaged CLI in a fresh temporary directory, a browser smoke, secret and public-hygiene scans, a
dependency license audit, and seeded negative controls that must turn the verdict red. It exits non-zero on
any failure and writes a receipt JSON. Green here is not a claim that the acceptance matrix passed: the live
drill needs a real local provider and the documentation drill needs a human receipt. The script exits 0 when every automated step passes even though those two rows are `NOT RUN`:
read the `GREEN-LOCAL` verdict line, not just the exit code. Known limitations are in `docs/KNOWN-LIMITATIONS.md`.

## Documents

| File | Purpose |
| --- | --- |
| `docs/PRD.md` | Product requirements |
| `docs/DOD.md` | Definition of done, acceptance criteria |
| `docs/qa/AC-MATRIX.md` | Evidence matrix: status per acceptance criterion and test |
| `docs/ARCHITECTURE.md` | Architecture and frozen API contract |
| `docs/OPERATIONS.md` | Install, upgrade, backup, restore, failure diagnosis |
| `docs/RUNBOOK.md` | What to do during an incident, including UNKNOWN and partial states |
| `docs/KNOWN-LIMITATIONS.md` | What is not done or has a caveat, with severity and mitigation |
| `docs/HUMAN-DRILL.md` | Guided synthetic smoke for a first-time operator |
| `docs/DEPENDENCY-LICENSES.md` | Dependency license audit (generated) |

## License

MIT. See `LICENSE`.
