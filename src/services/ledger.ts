import type { UndoKit } from "../context.js";
import { assertTransition, COMPENSATION_TRANSITIONS, OPERATION_TRANSITIONS } from "../domain/state.js";
import type { AttemptOutcome, AttemptPhase, CompensationState, JobKind, OperationState } from "../domain/types.js";
import type { Queryable } from "../db/client.js";
import { appendEvent } from "../evidence/events.js";
import type { OperationRow } from "./common.js";

export interface AttemptInput {
  workspace_id: string;
  operation_id: string;
  compensation_id?: string | null;
  phase: AttemptPhase;
  outcome: AttemptOutcome;
  started_attempt_id?: string | null;
  provider_request_id?: string | null;
  observed_version?: string | null;
  error_code?: string | null;
  detail?: Record<string, unknown>;
  id?: string;
}

/** Attempts are append-only: a terminal outcome is a new row that points at its `started` row. */
export async function recordAttempt(kit: UndoKit, tx: Queryable, a: AttemptInput): Promise<string> {
  const id = a.id ?? kit.ids.next();
  await tx.query(
    `INSERT INTO attempts (id, workspace_id, operation_id, compensation_id, phase, outcome, started_attempt_id, provider_request_id, observed_version, error_code, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)`,
    [
      id,
      a.workspace_id,
      a.operation_id,
      a.compensation_id ?? null,
      a.phase,
      a.outcome,
      a.started_attempt_id ?? null,
      a.provider_request_id ?? null,
      a.observed_version ?? null,
      a.error_code ?? null,
      JSON.stringify(a.detail ?? {}),
      kit.clock.now().toISOString(),
    ],
  );
  return id;
}

export interface JobInput {
  workspace_id: string;
  operation_id: string;
  compensation_id?: string | null;
  kind: JobKind;
  dedupe_key: string;
  /** Do not run before this time (deferred reconciliation). Defaults to now. */
  available_at?: Date;
}

/** Idempotent enqueue: the same dedupe key returns the existing job instead of creating a second one. */
export async function enqueueJob(kit: UndoKit, tx: Queryable, j: JobInput): Promise<{ id: string; created: boolean }> {
  const now = kit.clock.now().toISOString();
  const id = kit.ids.next();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO jobs (id, workspace_id, operation_id, compensation_id, kind, state, available_at, dedupe_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', $8::timestamptz, $7, $6::timestamptz, $6::timestamptz)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [id, j.workspace_id, j.operation_id, j.compensation_id ?? null, j.kind, now, j.dedupe_key, (j.available_at ?? kit.clock.now()).toISOString()],
  );
  if (inserted.rows[0]) return { id, created: true };
  // A reconcile job that failed (e.g. one transient database error) must not block reconciliation forever: re-queue it
  // (keeping last_error) instead of handing back the dead job.
  const requeued = await tx.query<{ id: string }>(
    `UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, available_at = $2::timestamptz, updated_at = $3::timestamptz
      WHERE dedupe_key = $1 AND kind = 'reconcile' AND state = 'failed' RETURNING id`,
    [j.dedupe_key, (j.available_at ?? kit.clock.now()).toISOString(), now],
  );
  if (requeued.rows[0]) return { id: requeued.rows[0].id, created: true };
  const existing = await tx.query<{ id: string }>("SELECT id FROM jobs WHERE dedupe_key = $1", [j.dedupe_key]);
  return { id: existing.rows[0]?.id ?? id, created: false };
}

export interface StateExtra {
  observed_version?: string | null;
  failure?: { code: string; message: string } | null;
}

/** Validated operation transition. Callers hold the row lock (SELECT ... FOR UPDATE). */
export async function setOperationState(kit: UndoKit, tx: Queryable, op: OperationRow, to: OperationState, extra: StateExtra = {}): Promise<void> {
  assertTransition(OPERATION_TRANSITIONS, op.state as OperationState, to, "operation");
  await tx.query(
    `UPDATE operations SET state = $2, observed_version = COALESCE($3::text, observed_version), failure_code = $4, failure_message = $5, updated_at = $6::timestamptz WHERE id = $1::uuid`,
    [op.id, to, extra.observed_version ?? null, extra.failure?.code ?? null, extra.failure?.message ?? null, kit.clock.now().toISOString()],
  );
  op.state = to;
}

export async function setCompensationState(
  kit: UndoKit,
  tx: Queryable,
  comp: { id: string; state: string },
  to: CompensationState,
  extra: { failure?: { code: string; message: string } | null } = {},
): Promise<void> {
  assertTransition(COMPENSATION_TRANSITIONS, comp.state as CompensationState, to, "compensation");
  await tx.query(
    `UPDATE compensations SET state = $2, failure_code = $3, failure_message = $4, updated_at = $5::timestamptz WHERE id = $1::uuid`,
    [comp.id, to, extra.failure?.code ?? null, extra.failure?.message ?? null, kit.clock.now().toISOString()],
  );
  comp.state = to;
}

/** Append a hash-chained evidence event (and its outbox envelope) in the caller's transaction. */
export async function emit(kit: UndoKit, tx: Queryable, op: { id: string; workspace_id: string }, type: string, payload: Record<string, unknown>): Promise<void> {
  await appendEvent(tx, kit.ids, kit.secrets, { workspaceId: op.workspace_id, operationId: op.id, type, payload, now: kit.clock.now() });
}

/**
 * Reopen an operation (or compensation) that reconciliation concluded "NOT_APPLIED" because a definitive WRITTEN
 * result for the very same attempt arrived late (a stalled worker's write landed after the quiet period). The
 * remote value may have changed, so it must not stay failed: it returns to UNKNOWN with code LATE_RESULT, its field
 * outcomes go back to pending, and a read-only reconcile is queued (which resolves it to applied/compensated,
 * inferred). This is the ONLY way out of `failed`, it is guarded to failure_code NOT_APPLIED or OPERATOR_RESOLVED (an admin closed it without proof), and it never re-sends a write.
 */
/** failure_code values that a late WRITTEN result may reopen: reconcile concluded "not applied", or an admin resolved it. */
export function isReopenable(failureCode: string | null): boolean {
  return failureCode === "NOT_APPLIED" || failureCode === "OPERATOR_RESOLVED";
}

export async function reopenAfterLateResult(
  kit: UndoKit,
  tx: Queryable,
  op: OperationRow,
  comp: { id: string; state: string } | null,
  startedAttemptId: string,
): Promise<void> {
  const now = kit.clock.now().toISOString();
  const message = "a late write result arrived after reconciliation concluded not applied; outcome unknown until reconciled";
  const attemptId = await recordAttempt(kit, tx, {
    workspace_id: op.workspace_id,
    operation_id: op.id,
    compensation_id: comp?.id ?? null,
    phase: comp ? "compensate" : "apply",
    outcome: "unknown",
    started_attempt_id: startedAttemptId,
    error_code: "LATE_RESULT",
    detail: { reason: "late definitive result after a NOT_APPLIED conclusion" },
  });
  if (comp) {
    await tx.query("UPDATE compensations SET state = 'unknown', failure_code = 'LATE_RESULT', failure_message = $2, updated_at = $3::timestamptz WHERE id = $1::uuid AND state = 'failed' AND failure_code IN ('NOT_APPLIED','OPERATOR_RESOLVED')", [comp.id, message, now]);
    await tx.query("UPDATE field_snapshots SET compensation_outcome = 'pending' WHERE operation_id = $1::uuid", [op.id]);
    comp.state = "unknown";
  } else {
    await tx.query("UPDATE operations SET state = 'unknown', failure_code = 'LATE_RESULT', failure_message = $2, updated_at = $3::timestamptz WHERE id = $1::uuid AND state = 'failed' AND failure_code IN ('NOT_APPLIED','OPERATOR_RESOLVED')", [op.id, message, now]);
    await tx.query("UPDATE field_snapshots SET apply_outcome = 'pending' WHERE operation_id = $1::uuid", [op.id]);
    op.state = "unknown";
  }
  await emit(kit, tx, op, comp ? "compensation.reopened" : "apply.reopened", { attempt_id: attemptId, reason: "LATE_RESULT", compensation_id: comp?.id ?? null });
  await enqueueJob(kit, tx, {
    workspace_id: op.workspace_id,
    operation_id: op.id,
    compensation_id: comp?.id ?? null,
    kind: "reconcile",
    dedupe_key: `reconcile:${comp?.id ?? op.id}:${attemptId}`,
  });
}

/**
 * Mark an in-flight attempt (crash, lease loss or a failed finalize) UNKNOWN and queue a read-only reconciliation.
 * The remote write may have happened, so it is never re-sent. Callers hold the operation row lock (and the
 * compensation row lock when `comp` is given) and have verified the row is still applying/compensating.
 */
export async function markInterrupted(
  kit: UndoKit,
  tx: Queryable,
  op: OperationRow,
  comp: { id: string; state: string } | null,
  code: string,
  reason: string,
): Promise<void> {
  const startedQuery = comp
    ? "SELECT id FROM attempts WHERE compensation_id = $1::uuid AND outcome = 'started' ORDER BY created_at DESC, id DESC LIMIT 1"
    : "SELECT id FROM attempts WHERE operation_id = $1::uuid AND compensation_id IS NULL AND phase = 'apply' AND outcome = 'started' ORDER BY created_at DESC, id DESC LIMIT 1";
  // applying/compensating are only ever set in the transaction that inserts the started attempt.
  const started = (await tx.query<{ id: string }>(startedQuery, [comp ? comp.id : op.id])).rows[0]!;
  const attemptId = await recordAttempt(kit, tx, {
    workspace_id: op.workspace_id,
    operation_id: op.id,
    compensation_id: comp?.id ?? null,
    phase: comp ? "compensate" : "apply",
    outcome: "unknown",
    started_attempt_id: started.id,
    error_code: code,
    detail: { reason },
  });
  const failure = { code, message: "attempt interrupted; outcome unknown until reconciled" };
  if (comp) await setCompensationState(kit, tx, comp, "unknown", { failure });
  else await setOperationState(kit, tx, op, "unknown", { failure });
  await emit(kit, tx, op, comp ? "compensation.unknown" : "apply.unknown", { attempt_id: attemptId, reason: code, compensation_id: comp?.id ?? null });
  await enqueueJob(kit, tx, {
    workspace_id: op.workspace_id,
    operation_id: op.id,
    compensation_id: comp?.id ?? null,
    kind: "reconcile",
    dedupe_key: `reconcile:${comp?.id ?? op.id}:${attemptId}`,
  });
}
