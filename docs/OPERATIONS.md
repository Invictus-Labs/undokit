# UndoKit operations guide

Audience: the person who installs, upgrades, backs up, restores and diagnoses a self-hosted UndoKit. For
what to do while an incident is in progress, use `docs/RUNBOOK.md`.

UndoKit is pre-release software. Use synthetic or sandbox data until the operator has approved the data
policy below and `docs/qa/AC-MATRIX.md` shows the criteria you depend on as PASS.

## 1. Concepts you need first

| Term | Meaning |
| --- | --- |
| Data directory | Where UndoKit keeps its database and evidence. Default `./.undokit`, created with owner-only permissions. Set with `--data-dir`. |
| Encryption key | Field snapshots and connector credentials are encrypted with an operator-managed key. The key is not stored in the database, **but by default the key file lives inside the data directory** (`<data-dir>/undokit.key`, created owner-only on first start). A `tar` of the data directory therefore contains the key. Losing the key makes encrypted data unreadable. See section 5.0 for custody. |
| Evidence bundle | A versioned, hashed, redacted JSON export. Portable and readable by a clean installation. Not a full backup. |
| Full backup | A copy of the data directory (or database) taken while side-effect workers are stopped. Restores everything including encrypted snapshots, given the key. The copy-the-directory path is documented here but **no automated test exercises it** (see section 5.2). |
| Provider | The CRM system UndoKit writes to. The built-in simulator is for the demo and tests only. A live provider must support an atomic conditional write. |

## 2. Install

### 2.1 Requirements

- Node.js 22.12 or newer (`node --version`).
- A writable data directory on a local disk with owner-only access.
- Network access only to install npm dependencies and, optionally, to reach your own CRM sandbox. The
  deterministic core makes no outbound calls and sends no telemetry.

### 2.2 From a release tarball

```bash
shasum -a 256 -c undokit-0.1.0.tgz.sha256      # must print OK
mkdir undokit-home && cd undokit-home
npm install ../undokit-0.1.0.tgz
npx undokit version
```

### 2.3 From source

```bash
npm ci
npm run build
node dist/src/cli/main.js version
```

### 2.4 First run (CLI)

```bash
npx undokit demo --out ./out           # synthetic, offline, writes report.html and evidence.json
npx undokit verify ./out/evidence.json # exit 0 means hashes match
```

### 2.5 First run (daemon)

```bash
npx undokit admin bootstrap --email admin@example.test --workspace "My Workspace"
npx undokit serve                      # http://localhost:8787, bound to 127.0.0.1
```

There is no default password. The password is prompted without echo, or read from `--password-stdin` or
`--password-file`; it is never accepted as a flag.

**Bind address.** `--host 127.0.0.1` (the default) is reachable from this machine only. `--host 0.0.0.0`
listens on every network interface. Only use it behind a trusted network or a TLS-terminating reverse proxy.
Sessions are HttpOnly cookies with CSRF protection, but UndoKit does not terminate TLS itself.

**Behind a TLS reverse proxy.** The browser's `Origin` is `https://your-host`, but UndoKit itself speaks plain HTTP to
the proxy, so by default it refuses the login with `CSRF_FAILED`. Set `UNDOKIT_TRUST_PROXY` so UndoKit trusts the
`X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` headers added by **your** proxies:

- `UNDOKIT_TRUST_PROXY=1` (or `true`): one proxy hop in front of UndoKit. A number `N` means N hops. A comma list of
  proxy addresses or CIDRs (for example `10.0.0.0/8,127.0.0.1`) trusts only connections from those proxies.
- UndoKit never trusts "every hop": it uses only the entries the declared proxies added, not the leftmost
  `X-Forwarded-For` value, which the client controls. This keeps the login lockout tied to a real address.
- The proxy must **overwrite** `X-Forwarded-Proto` and `X-Forwarded-Host` and **append** to `X-Forwarded-For` on every
  request, and nothing else may be able to reach UndoKit's port directly (anyone who can connect directly can forge
  the headers).
- Unset, `0`, `false`, `off` and `no` mean off, which is the default. A malformed list is refused at start-up.

### 2.6 Docker Compose (local provider sandbox only)

Status, stated plainly: `compose.yaml` currently defines **only** the local provider sandbox used by the live drill. There
is no daemon service in it yet. A `Dockerfile` for the daemon exists in the repository but has **not been built or run**
(the container engine was unavailable when it was written), so it is unverified and not a supported install path. Run the
daemon with `npx undokit serve` (section 2.5).

The sandbox bounds every published port to `127.0.0.1`; its container and volume are named `undokit-sandbox-*` so they are
easy to tell apart and remove. Credentials have no defaults: `docker compose` refuses to start without them.

```bash
cp .env.example .env                       # edit the placeholders; never commit .env
docker compose --profile sandbox up -d     # starts undokit-sandbox-couchdb on 127.0.0.1 only
docker compose --profile sandbox down      # stops it, keeps the volume
docker compose --profile sandbox down -v   # also deletes the undokit-sandbox-couchdb-data volume (destroys its data)
```

The sandbox is a local CouchDB record store used for testing only and holds no real data. It is a record store with
server-enforced optimistic concurrency, not a CRM product. Do not point real customer records at it.

## 3. Configuration and data policy

- Telemetry is off. There is no switch to turn it on in the deterministic core.
- Outbound endpoints for live connectors are configured by an administrator and checked against an
  allowlist, including redirects and DNS resolution. Private addresses are refused unless the operator
  explicitly allowlists them.
- **Logs: no application logger is enabled in this release**, so UndoKit writes no request or application log
  files. Redaction of credentials and sensitive values applies to API responses, evidence and reports. Redaction
  of "personal fields" in logs is **NOT IMPLEMENTED** because there are no logs to redact. If you run a reverse
  proxy or a process supervisor, their logs are yours to protect.
- **Retention: NOT IMPLEMENTED.** Nothing expires or is deleted automatically. The evidence tables are
  append-only (database triggers refuse UPDATE and DELETE), so there is no configurable retention window and no
  "primary deletion within 24 hours" mechanism. A deletion request is currently an operator action on the whole
  data directory (section 8). The 90-day, 24-hour and 30-day figures in earlier drafts were a *proposed* policy,
  not behavior. The operator must decide the policy before ingesting customer data.
- Import limits: 25 MB of metadata and 1,000 files by default (enforced before processing). Blob bundles and an
  override for a larger limit are **NOT IMPLEMENTED**. There is **no capacity pre-check**: a full disk surfaces as
  an error from the operation that hit it (see 7.4).
- Idempotency keys are stored with an expiry time and are never pruned in this release.
- Connector timeouts are bounded by the worker lease: two connector calls (the read and the write) plus a margin of a
  tenth of the lease must fit inside it, so with the default 30 s lease a connector's `timeout_ms` may be at most
  13500. A larger value is refused when the connector is created. The worker renews its lease while a job runs.
- Minimums: `UNDOKIT_LEASE_SECONDS` at least 5, `UNDOKIT_APPROVAL_TTL_SECONDS` at least 60,
  `UNDOKIT_WORKER_POLL_MS` at least 10. Smaller values (including 0) are refused at start-up.

## 4. Upgrade

UndoKit uses expand/contract migrations where possible. A schema downgrade may be unsafe, so the rollback
path is a verified snapshot.

1. **Read** the release notes and the new version's `docs/ARCHITECTURE.md` for schema changes.
2. **Stop side-effect workers.** Stop `undokit serve` (Ctrl-C or SIGTERM). No apply or
   compensate job may be running.
3. **Reconcile.** With the daemon stopped, run `undokit report --data-dir <dir>` and note every `UNKNOWN`, `CONFLICT` and blocked
   item. Do not upgrade while the count of unknown outcomes is a surprise.
4. **Back up** the data directory and, separately, the encryption key (section 5).
5. **Test the restore** of that backup in an isolated environment (section 6.3). An untested backup is not
   a backup.
6. **Install the new version** (tarball or source) next to the old one.
7. **Start it against a copy** of the data directory first. A failed migration must stop readiness; the
   server must not report ready and no worker may start. Check `GET /ready` returns 200.
8. **Enable writes only after reconciliation.** Keep the connector read-only until step 3's items are
   resolved on the new version.
9. **Rollback** if needed: stop the new version, restore the verified snapshot taken in step 4, start the
   old version, and reconcile external outcomes again (a restore cannot undo remote effects).

## 5. Backup

Take backups with workers stopped so a lease or an in-flight job cannot straddle the copy.

### 5.0 Key custody (read this first)

The database cannot be decrypted without the encryption key, and by default the key file sits inside the data
directory. Consequences:

- A plain `tar` of the data directory (section 5.1) **includes the key**. Anyone who holds that archive holds both
  the ciphertext and the key. Treat the archive as secret, or keep the key elsewhere.
- Recommended: keep the key **outside** the data directory, with separate custody (a different owner, location and
  backup from the database archive). Set `UNDOKIT_KEY_FILE=/secure/path/undokit.key` (owner-only, 0600) with
  `--data-dir`, or supply the key as `UNDOKIT_ENCRYPTION_KEY` (base64, 32 bytes) from your secret store. An explicit
  key file wins over the data directory default, and `UNDOKIT_ENCRYPTION_KEY` wins over any file.
- An explicit key file that does not exist **outside** the data directory is refused (exit 1, "Encryption key file
  not found") and nothing is created: UndoKit does not mint a key at a path you may have mistyped. Create the key
  file yourself before the first run. A missing key inside the data directory is created owner-only on first run.
- If the key file is missing and the database is **new and empty**, a new key is created (owner-only). If the key file
  is missing and the database **already holds data**, `serve` refuses to start ("encryption key file not found ...
  but the database already contains data") and creates nothing: put the original key in place (or set
  `UNDOKIT_ENCRYPTION_KEY`) first. Without that refusal a fresh key could not read old rows and new rows would be
  encrypted under a different key. The CLI data commands (`report`, `export`, `verify`, `import`) never create a
  key for an existing directory either.

### 5.1 Full backup

```bash
# stop undokit first
tar -czf undokit-backup-$(date -u +%Y%m%dT%H%M%SZ).tgz -C <parent-of-data-dir> <data-dir-name>
shasum -a 256 undokit-backup-*.tgz > undokit-backup.sha256
```

If the key file is inside the data directory (the default), this archive contains the key (section 5.0). Either
keep the key outside the directory, or protect the archive as you would the key. The archive is encrypted at the
field level but still holds operation metadata. Store the key's own backup in a **different** place with owner-only
access.

### 5.2 What is and is not tested, and PostgreSQL

- The documented path above (stop, `tar` the data directory, extract, start) is **not exercised by any automated
  test**. The tests cover the library functions `backupDatabase` and `restoreDatabase` (a logical dump with
  foreign-key and evidence-chain validation on restore, taken as one consistent snapshot even while a writer is
  active) and evidence export, verify and import. Those library
  functions have **no CLI command**: an operator cannot run them without writing code.
- UndoKit can run against PostgreSQL (`UNDOKIT_DATABASE_URL=postgres://...`). There is no UndoKit command to back
  it up and no tested procedure. Use your database's own backup tooling (for example `pg_dump` with the workers
  stopped, or a storage snapshot), keep the encryption key separately (section 5.0), and test a restore into a
  scratch database before relying on it. This guidance is untested.
- Whatever you use, finish a restore by reconciling every non-final operation (6.2 step 7).

### 5.3 Evidence bundle

```bash
npx undokit export --out ./evidence-$(date -u +%Y%m%d).json --data-dir <data-dir>
npx undokit verify ./evidence-$(date -u +%Y%m%d).json
```

A bundle is redacted and portable. It lets a clean installation read the evidence; it does not replace a
full backup.

## 6. Restore

### 6.1 Restore an evidence bundle into a clean installation

```bash
npx undokit verify ./evidence.json                       # read-only check, exit 0 required
npx undokit import ./evidence.json --data-dir ./restored # verifies again, then imports in one transaction
npx undokit report --data-dir ./restored --out ./restored-report.html
```

A truncated, damaged or unsupported bundle, or one edited without recomputing its hashes, is rejected before
anything is written. This check is **tamper-evident only**: bundles are not signed, so a deliberate forgery that
recomputes every hash verifies and imports. Import only bundles from sources you trust. Exit code 1 means a
verification failure (hash mismatch, truncated, unsupported version); 4 means input rejected before
processing (size, schema, path policy). Neither leaves partial state.

### 6.2 Restore a full backup

1. Stop UndoKit. Do not restore over a running instance.
2. Verify the archive: `shasum -a 256 -c undokit-backup.sha256`.
3. Extract into a **new** empty directory with owner-only permissions (`umask 077`).
4. Provide the **same** encryption key the backup was taken with.
5. Start UndoKit against the restored directory and check `GET /ready` returns 200.
6. Confirm references: open a known operation, its approval, attempts and field snapshots. Foreign keys are
   enforced; a restore into a database with dangling references must be rejected, not "repaired".
7. **Reconcile before enabling writes.** The restored database reflects the past, but the CRM moved on.
   For every operation in `APPLYING` or `COMPENSATING`, and every `UNKNOWN`, run read-only reconciliation
   and compare to the provider (section 7). A restore cannot undo remote effects.

### 6.3 Test the restore in isolation

Restore into a throwaway directory on a machine or container that has no connector credentials, run
`undokit report --data-dir <dir>` and compare the operation counts and plan hashes with the live
instance (read the live side from `GET /status`, or stop the daemon first to run `report` on it). Delete the
directory afterwards.

## 7. Failure diagnosis

Start with: `GET /ready`, `GET /status` (queued, running, failed and unknown counts with actionable
reasons), `undokit report --data-dir <dir>` (exit 5 means unresolved items are listed; the daemon must be stopped,
see below), and the evidence events of the operation in question (`GET /api/v1/operations/{id}/events`).

**The CLI data commands and a running daemon.** The embedded database allows one process at a time. While
`undokit serve` is running, `undokit report`, `export`, `verify`'s data-dir forms and `import` on the same data
directory fail with "The data directory is in use by process N" (exit 1; `report` writes an error-state report and
`export` writes nothing). Either stop the daemon first, or use the running daemon: `GET /status` for the overview and
`POST /api/v1/exports` (an operator session with its CSRF token; the Export action in the UI) for evidence. A
PostgreSQL deployment has no such single-process lock.

### 7.1 CLI exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Success and any verification passed | Nothing |
| 1 | Failure: verification mismatch, corrupt or unsupported bundle, runtime error | Read the message. Do not import. Re-export from the source. |
| 2 | Usage error | Nothing was done. Fix the command. |
| 3 | The database is not reachable (the help text calls it "a live connector or server is required but not connected"; today only an unreachable PostgreSQL database produces it) | Nothing was written. Fix `UNDOKIT_DATABASE_URL` or the database, or use the embedded database. |
| 4 | Input rejected before processing (size, schema, path policy) | Nothing was written. Fix or shrink the input. |
| 5 | Command succeeded but UNKNOWN, CONFLICT or blocked outcomes remain | Open the report. See the state table. |

### 7.2 HTTP errors

| Status | Meaning |
| --- | --- |
| 400 | malformed input |
| 401 | not logged in |
| 403 | role not allowed (viewers are read-only; only admins manage connectors) |
| 404 | not found, or the object belongs to another workspace (no state change) |
| 409 | version or idempotency conflict (changed body with a reused key; provider version moved; compensation blocked), or `UNRESOLVED_OPERATION` (another operation on the same record is unknown or in flight) |
| 413 | payload too large |
| 422 | schema or policy rejection (forbidden field, outside connector scope) |
| 429 | rate limited |
| 503 | dependency unavailable (database down, migration failed, connector disconnected) |

### 7.3 States, UNKNOWN and partial outcomes

An operation moves `planned -> approved -> applying -> applied | failed | unknown | conflict`. A
compensation moves `planned -> approved -> compensating -> compensated | conflict | unknown`.

| State | What it means | Safe next step |
| --- | --- | --- |
| `planned` | Plan stored, nothing written | Review, then approve or abandon |
| `approved` | Approval bound to the plan hash. Expires or is invalidated if the intent changes | Wait for the worker, or re-plan if expired |
| `applying` | A worker holds a lease and may have called the provider. The worker renews its lease while it works | If the process dies, the lease expires and the next worker converts the attempt to `unknown` (it never re-sends the write). If recording the result fails after the write, the attempt becomes `unknown` and a reconcile is queued. If an operation is still `applying` with no queued or leased job, requesting reconciliation converts it to `unknown`. Never re-issue the write by hand |
| `applied` | Provider accepted the conditional write and the observed after-state matches | Compensation may be planned later |
| `failed` | Confirmed non-effect: refused before dispatch, a definite provider rejection, or a read-only reconciliation that found the record untouched **after the quiet period** (below) | Fix the cause, plan again |
| `conflict` | The provider rejected the version precondition; nothing was written and the other change was kept | Review the record, plan again from the current version |
| `unknown` | The write may or may not have happened (crash or lost response after dispatch) | **Reconcile read-only** (below). Never retry the write blindly. |

**Resolving UNKNOWN.** Request reconciliation (`POST /api/v1/operations/{id}/reconcile`, or the Reconcile
action in the UI). Reconciliation only reads the provider. If the provider's current value and version match
the recorded intended state the operation resolves to `applied`. If they match the before-state the write
did not happen and it resolves to a confirmed non-effect, **but only once the quiet period has passed**. The
quiet period is the lease plus one connector deadline after the attempt started (43.5 s with the default 30 s
lease): a worker that lost its lease can still deliver a write inside that window, so reconciliation inside it
reports indeterminate and the operation stays `unknown`; ask again later. If the values match neither, someone
else changed the record: it **stays `unknown`**, the operator decides manually, and nothing is overwritten. An
operation that stays `unknown` after reconciliation can be closed by an administrator (next paragraph).

**Resolving by hand: `POST /api/v1/operations/{id}/resolve` (administrators only).** It is allowed **only after a
reconcile run has read the provider and could not settle the operation**: the latest reconcile ended
`STATE_AMBIGUOUS` (the record matches neither the before nor the intended values) or `RECORD_MISSING`. Before any
reconcile, after a reconcile that was deferred by the quiet period (`QUIET_PERIOD`), or after one that could not read
the provider (`CONNECTOR_UNAVAILABLE`), it is refused with 409 `INVALID_STATE` and the message says what to do. Use it
only when you have also checked the provider yourself. The body is `{"outcome": "not_applied" | "abandoned", "reason": "<why, at most 500 characters>"}` and
optionally `expected_version`. It records an attempt and an evidence event (`apply.operator_resolved`, or
`compensation.operator_resolved`) attributed to your user id with your reason (redacted), moves the operation (or its
unknown compensation) to `failed` with the code `OPERATOR_RESOLVED`, and releases the one-unresolved-operation guard
on the record so it can be planned again. What it **never** does: call the provider, write anything, or claim the
change was applied (there is no "applied" outcome; use reconciliation for that). Operators and viewers get 403,
another workspace's operation gets 404, and an operation that is not unknown gets 409 `INVALID_STATE`. The resolution
is not final against a late write: if the original write is still in flight and lands afterwards, the operation
returns to `unknown` with `LATE_RESULT` and reconciliation resolves it to `applied`.

**A late write after "not applied".** If a stalled worker's write is delivered after reconciliation had already
concluded `failed` (`NOT_APPLIED`), UndoKit does not leave the operation failed over a changed record: it records
the late result (evidence events `apply.late_result` and `apply.reopened`, or `compensate.late_result` and
`compensation.reopened`), returns the operation or compensation to `unknown` with the code `LATE_RESULT`, and queues
a read-only reconcile that resolves it to `applied` (or `compensated`). The write is never re-sent.

**One unresolved operation per record.** While an operation on a record is `unknown` or still in flight (or its
compensation is), planning or approving another change on that same record is refused with 409
`UNRESOLVED_OPERATION` and the id of the blocking operation: a later write with the same value could otherwise be
mistaken for the earlier operation's write when it is reconciled. Reconcile the blocking operation first. Other
records are not affected.

**Partial outcomes.** A multi-field operation records an outcome per field:
`apply_outcome` is `pending`, `applied`, `not_applied`, `changed_other` or `mismatch`;
`compensation_outcome` is `pending`, `restored`, `not_restored`, `changed_other` or `mismatch`. A partial
result is never shown as success. `changed_other` means a later edit by someone else was found and kept.
`mismatch` means the observed value matches neither expectation and needs a human decision.

**Why does compensation say blocked?** The current value or provider version differs from the recorded
post-write state. That is the protection working: a later edit exists. Review it, then either leave it or
plan a new change deliberately.

### 7.4 Common problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `GET /ready` returns 503 `NOT_READY` after an upgrade | A migration failed, or the database is unreachable | Read the error `undokit serve` printed and the `GET /ready` body (UndoKit enables no application log). Do not force workers. Restore the pre-upgrade snapshot if the migration cannot be fixed. |
| Worker restarted and a job is still `applying` | Lease not yet expired | Wait for the lease to expire (30 s by default); the reclaimed job becomes `unknown` and is reconciled read-only, it never discards an `unknown` outcome and never re-sends the write. |
| Connector check or planning fails with 503 `CONNECTOR_UNAVAILABLE` | Provider disconnected or credentials wrong | Fix the connection. Live operations fail explicitly when disconnected; they never fall back to the simulator. No CLI command returns exit 3 for a connector (exit 3 is an unreachable PostgreSQL database). |
| Reconcile returns 202 but the operation stays `unknown` | The provider could not be read, or the quiet period has not passed | Nothing failed loudly: the job finishes and the evidence event `reconcile.indeterminate` (code `CONNECTOR_UNAVAILABLE`) or `reconcile.deferred` records why. Fix the connection or wait, then request reconciliation again. |
| `import` exits 4 | Bundle too large, wrong schema or unsafe path | Nothing was imported. Regenerate the bundle. |
| `import` or `verify` exits 1 | Truncated or damaged bundle, an edit that did not recompute the hashes, or an unsupported version | Re-export from the source. Do not edit bundles by hand. (A forgery that recomputes the hashes is not detected: bundles are unsigned.) |
| Secrets visible in a log, report or API response | A redaction bug | Treat as a security incident: rotate the credential, report the defect, and preserve the evidence. |
| Disk full during export | There is no capacity pre-check; the write fails when space runs out | Free space, retry. A failed export is written to a temporary file and renamed, so it leaves no partial bundle. |

## 8. Decommission

Stop the service, take a final full backup if required, then delete the data directory and its backups
according to your retention policy. For Compose: `docker compose down -v` removes the `undokit-sandbox-*`
volumes.
