# UndoKit architecture and frozen contract (schema freeze v1)

UndoKit wraps an allowlisted set of scalar CRM field updates in durable before/after receipts and
provides human-approved, conflict-aware compensation. The deterministic core has no outbound network
and no telemetry; connectors are optional adapters.

```
CLI / UI / API  ->  services (authorization, idempotency, plans)  ->  PostgreSQL semantics (PGlite | pg)
                                   |                                        ^
                                   v                                        |
                           jobs + outbox (same txn)  ->  worker (leases)  --+--> connector (simulator | CouchDB)
```

## Source map (backend territory)

| Path | Role |
| --- | --- |
| `src/domain/` | types + zod schemas (`types.ts`), canonical JSON and hashes, state machines, allowlist, plan hashing, redaction, clock/ids, error codes |
| `src/db/` | database client (PGlite default, `pg` optional), migrations runner, logical backup/restore |
| `src/evidence/` | encryption (operator-managed key), hash-chained evidence events, evidence bundle export/verify/import |
| `src/connectors/` | CRM connector contract, deterministic simulator, CouchDB provider connector, outbound allowlist |
| `src/services/` | auth/sessions, connectors, operations (plans, approvals, compensation), jobs, status, demo |
| `src/workers/` | DB-lease worker: apply, compensate, reconcile |
| `src/api/` + `src/server.ts` | Fastify routes under `/api/v1`, error envelope, CSRF, rate limits |
| `schemas/` | JSON Schema generated from the zod schemas |
| `migrations/` | SQL migrations (`001_initial.sql`) |

## State machines

Apply: `planned -> approved -> applying -> applied | failed | unknown | conflict`. `unknown` leaves only
through read-only reconciliation. `approved -> planned` invalidates an expired or tampered approval;
`approved -> failed` is a pre-dispatch refusal. `conflict` means the provider rejected the version
precondition and nothing was written.

Compensation (own record, own approval): `planned -> approved -> compensating -> compensated | conflict |
unknown` (+ `failed` for a confirmed non-effect). A plan whose preview already shows conflicts starts
`conflict`. Per-field outcomes are explicit: `apply_outcome` in `pending|applied|not_applied|changed_other|mismatch`,
`compensation_outcome` in `pending|restored|not_restored|changed_other|mismatch`.

## Frozen HTTP API (`/api/v1`)

Errors are `{error:{code,message,request_id,details?}}`. Codes and HTTP statuses: see `src/domain/errors.ts`
(`ERROR_STATUS`). Mutations with a session cookie need header `X-CSRF-Token`. Lists use `?limit=` (max 100)
and `?cursor=` and return `{items, next_cursor}`. Roles: admin > operator > viewer.

| Method and path | Role | Success | Notes |
| --- | --- | --- | --- |
| `GET /health` | none | 200 | liveness |
| `GET /ready` | none | 200 / 503 `NOT_READY` | 503 when a migration failed or the database is unreachable |
| `POST /auth/login` | none | 200 `SessionView` | sets HttpOnly `undokit_session` cookie; 401 `INVALID_CREDENTIALS`; 429 `RATE_LIMITED` |
| `POST /auth/logout` | any | 204 | revokes the session |
| `GET /auth/me` | any | 200 `SessionView` | |
| `GET /sessions`, `DELETE /sessions/{id}` | admin (own session: any) | 200 / 204 | revoke |
| `GET /members`, `POST /members` | admin | 200 / 201 `MemberView` | no default password |
| `GET /connectors`, `GET /connectors/{id}` | any | 200 `ConnectorView` | credentials never returned |
| `POST /connectors` | admin | 201 `ConnectorView` | `kind` simulator or couchdb |
| `POST /connectors/{id}/check` | admin | 200 | read-only reachability; 503 `CONNECTOR_UNAVAILABLE` when disconnected |
| `POST /operations` | operator | 201 `PlanResponse` | requires `Idempotency-Key`; replay returns the same status/body plus header `Idempotency-Replayed: true`; changed body -> 409 `IDEMPOTENCY_CONFLICT` |
| `GET /operations`, `GET /operations/{id}` | any | 200 `OperationView` | viewers get sensitive fields redacted |
| `GET /operations/{id}/events` | any | 200 `EventView[]` | hash-chained evidence events |
| `POST /operations/{id}/approve` | operator | 202 `ApproveResponse` | body `{plan_hash, expected_version}`; enqueues the apply job |
| `POST /operations/{id}/reconcile` | operator | 202 `ReconcileResponse` | read-only reconciliation of an `unknown` operation or compensation |
| `POST /operations/{id}/resolve` | admin | 200 `ResolveResponse` | body `{outcome:"not_applied"\|"abandoned", reason (1-500 chars), expected_version?}`; only after a reconcile run read the provider and ended `reconciled_indeterminate` with `STATE_AMBIGUOUS` or `RECORD_MISSING` (an unreadable provider, a deferred `QUIET_PERIOD` reconcile or no reconcile yet gives 409 `INVALID_STATE` with "run reconcile first"); never calls the provider; closes an UNKNOWN operation (or, when the operation is applied, its UNKNOWN compensation) as `failed` with code `OPERATOR_RESOLVED`, an operator-attributed attempt and an `apply.operator_resolved` / `compensation.operator_resolved` event, and releases the unresolved-record guard; no `applied` outcome (use reconcile); 403 non-admin, 404 other workspace, 409 `INVALID_STATE` when nothing is UNKNOWN, 409 `VERSION_CONFLICT` for a stale expected_version; a later definitive WRITTEN result for the same attempt still reopens it to UNKNOWN (`LATE_RESULT`) |
| `POST /operations/{id}/compensation-plans` | operator | 201 `CompensationPlanResponse` | `{plan_hash, conflicts, fields}` preview; blocked plan has `state:"conflict"` |
| `GET /operations/{id}/compensations` | any | 200 `CompensationView[]` | |
| `POST /operations/{id}/compensate` | operator | 202 `CompensateResponse` | body `{plan_hash}`; separate fresh approval; 409 `COMPENSATION_BLOCKED` when values/version changed |
| `GET /jobs`, `GET /jobs/{id}` | any | 200 `JobView` | |
| `GET /status` | any | 200 `StatusView` | queued/running/failed/unknown counts and actionable reasons |
| `POST /exports` | operator | 200 `EvidenceBundle` | body `{operation_ids?}`; redacted, hashed |
| `POST /imports` | operator | 201 `ImportResult` | body is the bundle; verified fully before any state is written |
| `GET /imports`, `GET /imports/{id}` | any | 200 | read an imported bundle |

Cross-workspace or missing object ids return 404 `NOT_FOUND` with no state change.

## Library API (`src/index.ts`, used by the CLI)

`createUndoKit(options)` is async and returns a context (`kit`) with `db`, `keyring`, `clock`, `ids`, `faults`,
`secrets`, `connectors`, `config`, `readiness`. Service functions take the context and an `Actor
{user_id, workspace_id, role}`:

| Area | Functions |
| --- | --- |
| Setup | `createUndoKit`, `loadConfig`, `resolveKeyRing`, `openDatabase`, `runMigrations` / `initializeDatabase`, `startServer`, `buildServer` |
| Identity | `createWorkspaceWithAdmin` (library only), `bootstrapAdmin` (zero users only), `createMember`, `listMembers`, `login`, `authenticate`, `logout`, `listSessions`, `revokeSession` |
| Connectors | `createConnector`, `listConnectors`, `getConnector`, `checkConnector` |
| Operations | `planOperation`, `approveOperation`, `getOperation`, `listOperations`, `listOperationEvents`, `requestReconcile`, `getStatus`, `listJobs`, `getJob` |
| Compensation | `createCompensationPlan`, `compensateOperation`, `listCompensations` |
| Evidence | `exportBundle`, `verifyBundleText` (pure), `importBundle`, `listImports`, `getImport`, `verifyEventChain` |
| Operations of the system | `createWorker(kit).runOnce()/drain()/start()`, `backupDatabase`, `restoreDatabase`, `runDemo` |

## Fault injection and determinism

`options.clock` (`FixedClock`), `options.ids` (`SequentialIds`) and `options.faults` (a `FaultInjector`)
make every AC testable without sleeps. `faults.at(point, ctx)` may throw `InjectedCrash` at
`apply.after_remote_success`, `apply.before_remote`, `compensate.after_remote_success`,
`compensate.before_remote`; the worker never catches it (simulated process death). The simulator exposes
`externalEdit`, `failNextWrite`, and `seed` for planted intervening edits and lost-response faults.

## Evidence bundle (v1)

A single JSON document: `{schema_version, kind, bundle_id, created_at, workspace_id, generator, redacted,
manifest{files[{path,sha256,bytes}],file_count,total_bytes}, bundle_hash, files{path->doc}, complete:true}`.
Each file hash is `sha256(canonicalJson(doc))`; `bundle_hash` covers the manifest. A truncated file fails
JSON parsing or lacks `complete`; unsupported `schema_version`/`kind` is rejected; nothing is written until
the whole bundle verifies.


## Data model and encryption

Tables (migration `001_initial.sql`): `workspaces users memberships sessions connectors operations field_snapshots
compensations approvals attempts evidence_events jobs outbox idempotency_keys evidence_imports`, plus
`schema_version`. Every workspace-owned table carries `workspace_id`; foreign keys are composite
`(workspace_id, id)` so a row can never point at another workspace's parent. `attempts`, `evidence_events`,
`approvals` and `evidence_imports` are append-only (a trigger rejects UPDATE and DELETE). A terminal attempt
outcome is a new row that references its `started` row.

Field snapshots (`before`, `intended`, `observed_after`), connector credentials and stored compensation
conflicts are AES-256-GCM envelopes under sub-keys derived (HKDF) from one operator-managed key held outside the
database. Each envelope is bound to its row and column with associated data, so a ciphertext copied to another
row fails to decrypt. Value hashes of non-sensitive fields are plain `sha256` over `{operation_id, field, role,
value}`; hashes and plan documents for sensitive fields use a keyed HMAC so a low-entropy value cannot be recovered
from a hash that appears in an export. Passwords are scrypt hashes. Session tokens are stored only as sha256.
A backup (`backupDatabase`) never contains sessions and needs the same key to be read after a restore.

## Execution model

Approval creates the `approvals` row, moves the operation to `approved` and enqueues an apply job in one
transaction. The worker claims jobs with `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` and a lease.
For an apply: pre-dispatch checks under the row lock (approval present and unexpired, plan hash recomputed from the
stored values, connector writable, policy still allows the fields) -> `started` attempt and `applying` in one
transaction -> the provider `conditionalWrite` outside any transaction -> read-back -> one final transaction
records the outcome. A crash between any two steps leaves `applying` plus a `started` attempt; the lease expires,
the next worker marks it `unknown`, queues a read-only reconcile and never repeats the write.

| Provider result | Operation | Fields | Notes |
| --- | --- | --- | --- |
| written, read-back equals intended | `applied` | `applied` | `observed_version` is the read-back version |
| written, value differs | `applied` | `mismatch` (provider normalised) or `changed_other` (version moved after our write) | compensation treats these as conflicts |
| provider rejected the version precondition | `conflict` | `not_applied` | nothing written |
| unreachable / definite rejection | `failed` | `not_applied` | `CONNECTOR_UNAVAILABLE` / `CONNECTOR_REJECTED` |
| timeout, reset, lost response, unexpected error | `unknown` | `pending` | read-only reconcile decides |

Reconcile (apply): values equal the intended values and the version advanced -> `applied` (attribution recorded as
`inferred`, never claimed as proven); version unchanged and values equal the originals -> `failed` with `NOT_APPLIED`;
anything else -> remains `unknown` (`reconciled_indeterminate`). Compensation reconciles the same way against the
restore values. Compensation is blocked whenever the provider version differs from the version observed after the
apply (conservative by design) or any field differs from what the apply left; a blocked plan is stored as
`conflict`, an approval attempt is refused with `COMPENSATION_BLOCKED`, and the worker re-checks the live record
immediately before writing.

## Lease, deadline and recovery guarantees

- **Heartbeat.** While a handler runs, the worker renews its job lease every `lease/3` (`createWorker({heartbeatMs})`;
  `0` disables it, which tests use to simulate a stalled worker). A slow connector call is therefore not reclaimed.
- **Bounded connector time.** `timeout_ms` is the total budget of one connector call (allowlist/DNS check, read, PUT and
  the 409 re-read share one deadline). Two such calls plus a margin of a tenth of the lease must fit in the lease, i.e.
  `timeout_ms <= floor((lease - lease/10) / 2)` (`connectorDeadlineMs`; 13 500 ms for the default 30 s lease).
  `createConnector` rejects a larger value with `CONNECTOR_TIMEOUT_TOO_LONG`; larger stored values are clamped. A
  deadline that fires after the PUT was sent is ambiguous (UNKNOWN); before it was sent it is a definite non-effect.
- **Fencing.** The worker's final job update and the executors' final transactions are fenced by lease owner. A worker
  whose lease was reclaimed cannot finalize an operation or mark its job done; its result is recorded as late evidence
  and the reclaiming worker's reconcile resolves the state.
- **Errors after the write.** An ordinary error between the remote write and the final transaction converts the
  in-flight attempt to UNKNOWN (`FINALIZE_FAILED`) with a queued read-only reconcile, in one transaction; the job is
  `done` (its `last_error` keeps the message). If that conversion itself fails the job stays leased and lease expiry
  reclaims it. `POST /operations/{id}/reconcile` also accepts an `applying`/`compensating` attempt that has no queued
  or leased job (it becomes UNKNOWN with code `ABANDONED`).
- **Quiet period.** Reconciliation concludes "not applied" only after `started + lease + connector deadline`
  (`quietPeriodMs`). Earlier, it records `reconciled_indeterminate` (`QUIET_PERIOD`), emits `reconcile.deferred`,
  re-queues itself for the end of the quiet period and the state stays UNKNOWN. "Applied" conclusions are never delayed.
- **Late results.** A result that arrives after reclaim (or after the operation was resolved elsewhere) is never
  dropped: it is recorded as an attempt (`detail.late`, `lease_lost`) and an `apply.late_result` /
  `compensation.late_result` evidence event, and does not change the state, with one exception: if reconciliation had
  already concluded `NOT_APPLIED` (failed) and a definitive WRITTEN result for the same attempt then arrives, the
  remote value may have changed, so the operation (or compensation) is reopened to UNKNOWN with code `LATE_RESULT`
  (`apply.reopened` / `compensation.reopened`), its field outcomes return to pending and a read-only reconcile is
  queued; that reconcile resolves it to applied (or compensated), inferred, so it stays reconcilable and compensable.
  This reopening is the only way out of `failed`, is guarded to `failure_code = NOT_APPLIED`, and never re-sends a
  write. `POST /operations/{id}/reconcile` also works on a reopened operation. The lease holder itself may still
  resolve an UNKNOWN operation with a definitive result. Not implemented: requiring that the original attempt's lease
  was expired with no later heartbeat before concluding `NOT_APPLIED`; the quiet period plus the reopening is the
  safety net.
- **One unresolved change per record.** Planning or approving a change is refused with `UNRESOLVED_OPERATION` (409)
  while another operation on the same connector and record is UNKNOWN or in flight, or has a compensation that is. This
  keeps a later reconcile from mistaking a newer write for the old operation's. Idempotent replays are unaffected. If
  reconciliation can never settle it (ambiguous state, record gone), an admin closes it with
  `POST /operations/{id}/resolve`, which records the decision and releases the guard without touching the provider.
- **Failed reconcile jobs.** Enqueuing a reconcile job whose dedupe key belongs to a `failed` job re-queues that job
  (keeping `last_error`) instead of returning the dead one, so `POST /reconcile` works again after a transient error.

## Security model

- Roles: admin (members, connectors, sessions) > operator (plan, approve, compensate, reconcile, export, import) >
  viewer (read, sensitive values redacted). A workspace id is never accepted from the client for data access;
  cross-workspace or missing ids both return 404.
- Session cookie `undokit_session`: HttpOnly, SameSite=Strict, Secure unless bound to loopback. Every
  non-login mutation needs `X-CSRF-Token`; a mutating request whose `Origin` differs from `Host` is refused.
- Behind reverse proxies set `UNDOKIT_TRUST_PROXY` (default off): a hop count (`1`, `true` = one hop) or a comma list of
  proxy addresses/CIDRs. Only the headers added by the declared hops are trusted; the client-controlled leftmost
  `X-Forwarded-For` entry is never used. The proxy must overwrite `X-Forwarded-Proto`/`X-Forwarded-Host` and append to
  `X-Forwarded-For`. The same-origin check then compares the browser's Origin to `<forwarded proto>://<forwarded host>`.
  A CIDR/address list must contain proxy addresses only, never client ranges (a trusted address may set the forwarded
  headers on behalf of any client); the hop count is the safer setting when the number of proxies is fixed.
- `serve` mints an encryption key file only for a brand-new empty database; if the key file is missing and the database
  already holds data it refuses to start (restore the original key or set `UNDOKIT_ENCRYPTION_KEY`).
- `backupDatabase` reads every table in one read-only REPEATABLE READ transaction (a consistent snapshot).
- The worker and login limits: leases are at least 5 s, approvals at least 60 s and the poll interval at least 10 ms when
  set through the environment; the login limiter tracks at most 10 000 keys (expired first, then unlocked least-recently-failed, locked-out last).
- Login failures are rate limited per (ip, email); unknown users still pay the password-hash cost.
- Outbound network: connector URLs must match the allowlist (default loopback only), carry no credentials, and
  resolve to loopback unless the operator allowlisted a non-loopback host; redirects are never followed.
- Output hygiene: error messages never echo submitted values; unknown request keys are classified (deletion,
  send-style) before schema validation; evidence events, logs and exports pass through the redaction pass and the
  secret registry; the API sets CSP, `nosniff`, `Cache-Control: no-store`, `X-Frame-Options: DENY`.

## Known limits and risks

- The simulator is in-process and re-seeded from its config on start; it is a stand-in, not a provider.
- PGlite is single-connection and single-process; use `postgres://` for several processes. Two UndoKit processes
  must never open the same PGlite directory.
- A timeout is genuinely ambiguous: a request still in flight at the provider could land after a reconcile has
  concluded `NOT_APPLIED`. Reconciliation reports what it observed, not what will happen.
- Reconciled `applied` is inferred from values and version; identical values written by someone else are
  indistinguishable from our write.
- Compensation is intentionally conservative: any provider version change blocks it, even for unrelated fields.
- The CouchDB connector proves the contract against a real database server, not against any CRM product.
- Rate limiting covers sign-in only; put a reverse proxy in front for general abuse control.

## Builder self-reports (not release evidence)

These are the implementer's own smoke runs, recorded for transparency. They are not the AC-07 receipt and not
independent QA evidence; the acceptance status lives in `docs/qa/AC-MATRIX.md`, and AC-07 (live provider) is NOT RUN
until QA records a drill against its own sandbox.

- Scenario script run by the builder on PGlite and, once, against a throwaway PostgreSQL 17 container through the `pg`
  driver (container no longer running; later changes such as the REPEATABLE READ backup were checked on PGlite only):
  plan, approve, apply, compensate, idempotent replay, rejected intents, planted intervening edit, lost response then
  reconcile, crash after the remote success then lease reclaim, evidence export, verify and import, truncated and
  tampered bundle rejection, backup and restore with chain re-verification, four concurrent workers over twelve approved
  operations (twelve provider writes), three concurrent approvals (one success) and four concurrent plan requests with one
  Idempotency-Key (one operation).
- Builder smoke run of the real CouchDB connector against a throwaway `apache/couchdb:3.5.2.1` container, before the
  deadline and quiet-period changes: apply, compensate, stale expected version at plan time, an edit between the
  connector's read and its PUT (provider conflict), a planted edit blocking compensation, an outage at apply time, a
  dropped response reconciled to applied. See the self-report in `docs/PROVIDER-DECISION.md`.
