# UndoKit runbook: an automation changed the wrong field

Use this while an incident is in progress. Installation, backup and restore live in `docs/OPERATIONS.md`.

Ground rules
- UndoKit can only undo changes that were made through it (instrumented mutations). If the change was not,
  there is no receipt and no compensation. Stop and recover the value from another source.
- A human approves every compensation. Nothing here is automatic.
- If anything is `UNKNOWN`, resolve it by read-only reconciliation. Never re-run a write by hand.

## 1. Orient (2 minutes)

1. Confirm the service is healthy: `GET /ready` returns 200. If it returns 503, go to OPERATIONS section 7.4.
2. Look at the overall picture: `GET /status`, or `undokit report --data-dir <dir>` (exit 5 means unresolved
   items are listed). `report` needs the daemon stopped: with the embedded database it fails with "The data
   directory is in use by process N" while `undokit serve` runs. Use `GET /status` while the daemon is up.
3. Find the operation: list operations, filter by record reference. Note its id, state and plan hash.

## 2. Decide by state

| State of the original operation | Do this |
| --- | --- |
| `applied` | Go to step 3 (plan the compensation). |
| `unknown` | Reconcile first (step 4). Do not plan compensation until it resolves. Until it does, no new change can be planned or approved on the same record (409 `UNRESOLVED_OPERATION`). |
| `applying` | A worker may be mid-flight or crashed. Wait about one lease (30 s by default) and re-read: a dead worker's attempt becomes `unknown` and is reconciled read-only. If it is still `applying` with no worker running, request reconciliation: that converts it to `unknown` first. Never re-issue the write. |
| `conflict` | The provider kept someone else's change and nothing was written. There is nothing of ours to undo. Review the record. |
| `failed` | Confirmed non-effect (refused, rejected, or reconciled as not applied after the quiet period). Nothing to undo. If the failure code is `NOT_APPLIED`, the record was read untouched only after a worker could no longer deliver a late write. |
| `planned` or `approved` | Nothing was written yet. Abandon, or let it proceed deliberately. |

## 3. Plan and approve the compensation

1. Create the compensation plan (UI: Compensate, or `POST /api/v1/operations/{id}/compensation-plans`).
2. Read the preview. It lists the **exact fields**, the value that would be restored, the current value and
   the provider version.
3. If the response lists `conflicts` or the plan state is `conflict`, compensation is **blocked** because
   the record changed after the original write. This is the protection working. Do not look for a way
   around it. Decide whether the later edit is correct; if it is, leave it.
4. If the preview is clean, approve it with its own plan hash. The approval for the original change does
   not authorize this.
5. Watch the compensation: `compensating -> compensated`. Per-field outcomes show `restored`.

## 4. Resolve UNKNOWN (read-only)

1. Request reconciliation (UI: Reconcile, or `POST /api/v1/operations/{id}/reconcile`).
2. Read the result:
   - Provider shows the intended value and version: the original write did happen. State becomes `applied`.
   - Provider shows the before value: the write did not happen, **but only once the quiet period has passed**
     (the lease plus one connector deadline after the attempt started, 43.5 s by default). Inside it the result is
     indeterminate and the state stays `unknown`, because a slow write could still land. Ask again after the
     window. After it, the state becomes `failed` (`NOT_APPLIED`): the record was read untouched after no worker could still be holding the write. (If a stalled write lands later anyway, see step 3.) Plan again if still wanted.
   - Provider shows something else: someone changed it. State stays `unknown`. Escalate to the record owner.
     Do not overwrite.
3. If a write that looked lost lands later (evidence `apply.late_result` then `apply.reopened`), the operation returns to
   `unknown` with code `LATE_RESULT` and a reconcile resolves it to `applied`; compare the provider's value if you
   need to be sure.
4. If reconciliation could not settle it (the latest reconcile ended `STATE_AMBIGUOUS` or `RECORD_MISSING`, which the
   page and the evidence show) and you have checked the provider yourself, an administrator can close it with `POST /api/v1/operations/{id}/resolve` (outcome
   `not_applied` or `abandoned`, and a reason). It never calls the provider and never claims `applied`; it records who
   decided and why, marks the operation `failed` (`OPERATOR_RESOLVED`) and lets the record be planned again. If the
   original write was merely slow and lands later, the operation reopens to `unknown` (`LATE_RESULT`).
5. If the provider is unreachable, the request still returns 202 and the operation **stays `unknown`**; the
   only trace is the evidence event `reconcile.indeterminate` with code `CONNECTOR_UNAVAILABLE` (and the attempt
   `reconciled_indeterminate`). It does not return 503 or exit 3. Fix the connection and request reconciliation
   again. A connector that cannot do an atomic conditional write is read-only: it cannot apply or compensate.

## 5. Partial results

Multi-field operations report each field. Read them one by one:

| Field outcome | Meaning | Action |
| --- | --- | --- |
| `applied` / `restored` | As designed | None |
| `not_applied` / `not_restored` | The field was not changed | Re-plan if still wanted |
| `changed_other` | A later edit by someone else was found and kept | Review, usually leave |
| `mismatch` | Observed value matches neither expectation | Human decision, no automatic action |

A partial operation is never success. Say so in the incident notes.

## 6. Record

- Export evidence: with the daemon stopped, `undokit export --out ./incident-<date>.json --data-dir <dir>`; while the
  daemon runs, use `POST /api/v1/exports` (the Export action in the UI). Then `undokit verify ./incident-<date>.json`
  (exit 0).
- Attach the bundle, or a link to the operation, to the incident record. The bundle is redacted.
- Note any `UNKNOWN` or blocked items that remain and who owns them.

## 7. Escalate when

- Secrets appear in a log or report: rotate the credential and report a defect.
- A cross-workspace object is visible, or a viewer can write: stop, preserve logs, report a security defect.
- `GET /ready` stays 503 after a restore: do not force workers; restore the last verified snapshot and
  reconcile before enabling writes.
