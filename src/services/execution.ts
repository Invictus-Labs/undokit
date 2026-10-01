import {
  ConnectorAmbiguousError,
  ConnectorRejectedError,
  ConnectorUnavailableError,
  readWithRetry,
  type ConnectorRecord,
  type CrmConnector,
  type WriteResult,
} from "../connectors/crm.js";
import { quietPeriodMs } from "../config.js";
import type { UndoKit } from "../context.js";
import { validateIntent } from "../domain/allowlist.js";
import { AppError } from "../domain/errors.js";
import { computeApplyPlanHash, computeCompensationPlanHash } from "../domain/plan.js";
import type { ApplyFieldOutcome, CompensationFieldOutcome, Scalar } from "../domain/types.js";
import type { Queryable } from "../db/client.js";
import { loadOperationRow, type OperationRow } from "./common.js";
import type { ConnectorDbRow } from "./connectors.js";
import { emit, enqueueJob, isReopenable, markInterrupted, recordAttempt, reopenAfterLateResult, setCompensationState, setOperationState } from "./ledger.js";
import { applyPlanInput, compensationPlanInput, connectorPolicyOf } from "./operations.js";
import { computeConflicts, encryptValue, loadSnapshots, valueHash, type Snapshot } from "./views.js";

export interface JobRecord {
  id: string;
  /** Worker holding the lease; final writes are fenced by it. Absent for jobs run outside a worker. */
  lease_owner?: string;
  workspace_id: string;
  operation_id: string;
  compensation_id: string | null;
  kind: "apply" | "compensate" | "reconcile";
}

export interface ExecutionSummary {
  job_id: string;
  kind: string;
  note: string;
}

type Outcome =
  | { kind: "written"; newVersion: string; requestId: string }
  | { kind: "conflict"; currentVersion: string; requestId: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "unknown"; code: string; message: string };

/** Map a thrown connector error to a definite non-effect (failed) or an ambiguous outcome (unknown). */
function classifyWriteError(err: unknown): Outcome {
  if (err instanceof ConnectorUnavailableError) return { kind: "failed", code: "CONNECTOR_UNAVAILABLE", message: "connector was not reachable; nothing was written" };
  if (err instanceof ConnectorRejectedError) return { kind: "failed", code: "CONNECTOR_REJECTED", message: "provider rejected the write; nothing was written" };
  if (err instanceof ConnectorAmbiguousError) return { kind: "unknown", code: "OUTCOME_UNKNOWN", message: "the provider response was lost; the write may or may not have happened" };
  return { kind: "unknown", code: "OUTCOME_UNKNOWN", message: "unexpected error during the write; the write may or may not have happened" };
}

function fromWriteResult(res: WriteResult): Outcome {
  return res.outcome === "written"
    ? { kind: "written", newVersion: res.new_version, requestId: res.provider_request_id }
    : { kind: "conflict", currentVersion: res.current_version, requestId: res.provider_request_id };
}

async function tryRead(connector: CrmConnector, recordRef: string): Promise<ConnectorRecord | null | undefined> {
  try {
    return await readWithRetry(connector, recordRef);
  } catch {
    return undefined; // unreadable right now
  }
}

async function setApplyOutcome(kit: UndoKit, tx: Queryable, op: OperationRow, s: Snapshot, outcome: ApplyFieldOutcome, observed: { value: Scalar } | null): Promise<void> {
  await tx.query(
    "UPDATE field_snapshots SET apply_outcome = $3, observed_after = $4::jsonb, observed_after_hash = $5 WHERE operation_id = $1::uuid AND field = $2",
    [
      op.id,
      s.field,
      outcome,
      observed ? JSON.stringify(encryptValue(kit, op.id, s.field, "observed_after", observed.value)) : null,
      observed ? valueHash(kit, s.sensitive, op.id, s.field, "observed_after", observed.value) : null,
    ],
  );
}

async function setCompensationOutcome(tx: Queryable, op: OperationRow, field: string, outcome: CompensationFieldOutcome): Promise<void> {
  await tx.query("UPDATE field_snapshots SET compensation_outcome = $3 WHERE operation_id = $1::uuid AND field = $2", [op.id, field, outcome]);
}

/** Foreign keys guarantee the connector and compensation rows exist for any job; a miss is a corrupted database. */
async function findConnector(tx: Queryable, id: string): Promise<ConnectorDbRow> {
  const row = (await tx.query<ConnectorDbRow>("SELECT * FROM connectors WHERE id = $1::uuid", [id])).rows[0];
  if (!row) throw new AppError("INTERNAL_ERROR", "connector row is missing");
  return row;
}

async function loadCompensation(tx: Queryable, id: string, lock: boolean): Promise<CompensationRecord> {
  const res = await tx.query<CompensationRecord>(
    `SELECT id, workspace_id, operation_id, state, plan_hash, expected_version, failure_code FROM compensations WHERE id = $1::uuid${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new AppError("INTERNAL_ERROR", "compensation row is missing");
  return row;
}


type ProviderResult = Outcome;

/** True when another worker has reclaimed the job (or it was finished): this worker must not finalize anything. */
async function leaseLost(tx: Queryable, job: JobRecord): Promise<boolean> {
  if (!job.lease_owner) return false;
  const held = await tx.query("SELECT 1 FROM jobs WHERE id = $1::uuid AND lease_owner = $2 AND state = 'leased'", [job.id, job.lease_owner]);
  return held.rows.length === 0;
}

/**
 * A result that arrives after the operation (or compensation) was already resolved by someone else, typically
 * a worker whose lease was reclaimed. It cannot change the resolved state, but it is never dropped: it is recorded
 * as an attempt and an evidence event so the discrepancy is visible.
 */
async function recordLateResult(
  kit: UndoKit,
  tx: Queryable,
  op: OperationRow,
  comp: { id: string } | null,
  attemptId: string,
  outcome: ProviderResult,
  readback: ConnectorRecord | null | undefined,
  stateNow: string,
  lostLease: boolean,
): Promise<void> {
  const phase = comp ? "compensate" : "apply";
  const providerRequestId = outcome.kind === "written" || outcome.kind === "conflict" ? outcome.requestId : null;
  const observed = readback?.version ?? (outcome.kind === "written" ? outcome.newVersion : outcome.kind === "conflict" ? outcome.currentVersion : null);
  const id = await recordAttempt(kit, tx, {
    workspace_id: op.workspace_id,
    operation_id: op.id,
    compensation_id: comp?.id ?? null,
    phase,
    outcome: outcome.kind === "written" ? "succeeded" : outcome.kind,
    started_attempt_id: attemptId,
    provider_request_id: providerRequestId,
    observed_version: observed,
    error_code: outcome.kind === "failed" || outcome.kind === "unknown" ? outcome.code : null,
    detail: { late: true, state_at_finalize: stateNow, lease_lost: lostLease },
  });
  await emit(kit, tx, op, `${phase}.late_result`, { attempt_id: id, outcome: outcome.kind, state_at_finalize: stateNow, lease_lost: lostLease, observed_version: observed, compensation_id: comp?.id ?? null });
}

/**
 * Called by the worker when a handler failed with an ordinary error. If the failure left an attempt in flight
 * (applying/compensating with a started attempt), convert it to UNKNOWN with a queued read-only reconcile in one
 * transaction; never re-send the write. Returns true when it converted something.
 */
export async function recoverInFlight(kit: UndoKit, job: JobRecord, code: string): Promise<boolean> {
  const reason = "the worker failed after the remote write may have been sent and before the result was recorded";
  return kit.db.transaction(async (tx) => {
    if (await leaseLost(tx, job)) return false; // the worker that reclaimed the job owns recovery
    const op = await loadOperationRow(tx, job.workspace_id, job.operation_id, true);
    if (job.kind === "apply") {
      if (op.state !== "applying") return false;
      await markInterrupted(kit, tx, op, null, code, reason);
      return true;
    }
    if (job.kind === "compensate" && job.compensation_id) {
      const comp = await loadCompensation(tx, job.compensation_id, true);
      if (comp.state !== "compensating") return false;
      await markInterrupted(kit, tx, op, comp, code, reason);
      return true;
    }
    return false;
  });
}

/* =====================================================================================
 * apply
 * ===================================================================================== */

type ApplyPre =
  | { kind: "skip"; note: string }
  | { kind: "dispatch"; op: OperationRow; snaps: Snapshot[]; connectorRow: ConnectorDbRow; attemptId: string };

export async function executeApply(kit: UndoKit, job: JobRecord): Promise<ExecutionSummary> {
  const summary = (note: string): ExecutionSummary => ({ job_id: job.id, kind: "apply", note });
  const pre = await kit.db.transaction<ApplyPre>(async (tx) => {
    const op = await loadOperationRow(tx, job.workspace_id, job.operation_id, true);
    if (op.state === "applying") {
      await markInterrupted(kit, tx, op, null, "INTERRUPTED", "worker lease expired while the attempt was in flight; the remote write may have happened");
      return { kind: "skip", note: "interrupted attempt recovered as unknown; reconciliation queued" };
    }
    if (op.state !== "approved") return { kind: "skip", note: `operation is ${op.state}; nothing to do` };

    const now = kit.clock.now();
    const approvalRes = await tx.query<{ id: string; plan_hash: string; expires_at: string }>(
      "SELECT id, plan_hash, expires_at FROM approvals WHERE operation_id = $1::uuid AND phase = 'apply' ORDER BY created_at DESC, id DESC LIMIT 1",
      [op.id],
    );
    const approval = approvalRes.rows[0];
    const snaps = await loadSnapshots(kit, tx, op.id);

    const invalidate = async (code: string, message: string, type: string): Promise<ApplyPre> => {
      await setOperationState(kit, tx, op, "planned", { failure: { code, message } });
      await emit(kit, tx, op, type, { code, approval_id: approval?.id ?? null });
      return { kind: "skip", note: message };
    };
    const refuse = async (code: string, message: string): Promise<ApplyPre> => {
      await setOperationState(kit, tx, op, "failed", { failure: { code, message } });
      await emit(kit, tx, op, "apply.refused", { code });
      return { kind: "skip", note: message };
    };

    if (!approval) return refuse("APPROVAL_MISSING", "no approval is recorded for this operation; nothing was written");
    if (Date.parse(approval.expires_at) <= now.getTime()) {
      return invalidate("APPROVAL_EXPIRED", "the approval expired before the write ran; approve again", "approval.expired");
    }
    const recomputed = computeApplyPlanHash(applyPlanInput(kit, op, snaps));
    if (recomputed !== approval.plan_hash || recomputed !== op.plan_hash) {
      return invalidate("PLAN_HASH_MISMATCH", "the plan changed after approval; approval invalidated, nothing was written", "approval.invalidated");
    }
    const connectorRow = await findConnector(tx, op.connector_id);
    if (connectorRow.disabled_at) return refuse("CONNECTOR_UNAVAILABLE", "connector is disabled; nothing was written");
    const connector = kit.connectors.get(connectorRow);
    if (!connector.supportsAtomicConditionalWrite) return refuse("CONNECTOR_READ_ONLY", "connector does not support atomic conditional writes; nothing was written");
    try {
      validateIntent(connectorPolicyOf(connectorRow), op.record_ref, Object.fromEntries(snaps.map((s) => [s.field, s.intended])));
    } catch (err) {
      return refuse(err instanceof AppError ? err.code : "VALIDATION_FAILED", "the connector policy no longer allows this change; nothing was written");
    }
    const attemptId = await recordAttempt(kit, tx, { workspace_id: op.workspace_id, operation_id: op.id, phase: "apply", outcome: "started", detail: { approval_id: approval.id } });
    await setOperationState(kit, tx, op, "applying");
    await emit(kit, tx, op, "apply.started", { attempt_id: attemptId, approval_id: approval.id, expected_version: op.expected_version });
    return { kind: "dispatch", op, snaps, connectorRow, attemptId };
  });
  if (pre.kind === "skip") return summary(pre.note);

  const { op, snaps, connectorRow, attemptId } = pre;
  const connector = kit.connectors.get(connectorRow);
  await kit.faults.at("apply.before_remote", { operation_id: op.id });
  let outcome: Outcome;
  try {
    outcome = fromWriteResult(
      await connector.conditionalWrite(op.record_ref, Object.fromEntries(snaps.map((s) => [s.field, s.intended])), op.expected_version, { requestId: attemptId }),
    );
  } catch (err) {
    outcome = classifyWriteError(err);
  }
  let readback: ConnectorRecord | null | undefined;
  if (outcome.kind === "written") {
    await kit.faults.at("apply.after_remote_success", { operation_id: op.id });
    readback = await tryRead(connector, op.record_ref);
  }

  await kit.db.transaction(async (tx) => {
    const locked = await loadOperationRow(tx, op.workspace_id, op.id, true);
    const lost = await leaseLost(tx, job);
    if (lost || (locked.state !== "applying" && locked.state !== "unknown")) {
      await recordLateResult(kit, tx, locked, null, attemptId, outcome, readback, locked.state, lost);
      // The write landed after reconciliation had already concluded "not applied": do not leave it failed.
      if (outcome.kind === "written" && locked.state === "failed" && isReopenable(locked.failure_code)) {
        await reopenAfterLateResult(kit, tx, locked, null, attemptId);
      }
      return;
    }
    // A result that arrives while the operation is still UNKNOWN (lease lost, reconciliation not conclusive yet) is definitive and resolves it.
    const wasUnknown = locked.state === "unknown";
    const base = { workspace_id: op.workspace_id, operation_id: op.id, phase: "apply" as const, started_attempt_id: attemptId };
    if (outcome.kind === "written") {
      const newVersion = outcome.newVersion;
      const observedVersion = readback ? readback.version : newVersion;
      const results: { field: string; outcome: ApplyFieldOutcome; observed_after_hash: string | null }[] = [];
      for (const s of snaps) {
        let fieldOutcome: ApplyFieldOutcome = "applied";
        let observed: { value: Scalar } | null = null;
        if (readback) {
          const actual = readback.fields[s.field] ?? null;
          observed = { value: actual };
          if (actual !== s.intended) fieldOutcome = readback.version === newVersion ? "mismatch" : "changed_other";
        }
        await setApplyOutcome(kit, tx, locked, s, fieldOutcome, observed);
        results.push({ field: s.field, outcome: fieldOutcome, observed_after_hash: observed ? valueHash(kit, s.sensitive, op.id, s.field, "observed_after", observed.value) : null });
      }
      const doneId = await recordAttempt(kit, tx, {
        ...base,
        outcome: "succeeded",
        provider_request_id: outcome.requestId,
        observed_version: observedVersion,
        detail: { readback: readback ? "verified" : "unavailable", write_version: newVersion },
      });
      await setOperationState(kit, tx, locked, "applied", { observed_version: observedVersion });
      await emit(kit, tx, locked, "apply.succeeded", { attempt_id: doneId, observed_version: observedVersion, write_version: newVersion, fields: results });
    } else if (outcome.kind === "conflict") {
      for (const s of snaps) await setApplyOutcome(kit, tx, locked, s, "not_applied", null);
      const doneId = await recordAttempt(kit, tx, { ...base, outcome: "conflict", provider_request_id: outcome.requestId, observed_version: outcome.currentVersion, error_code: "VERSION_CONFLICT" });
      await setOperationState(kit, tx, locked, wasUnknown ? "failed" : "conflict", { failure: { code: "VERSION_CONFLICT", message: "the provider rejected the version precondition; nothing was written" } });
      await emit(kit, tx, locked, "apply.conflict", { attempt_id: doneId, expected_version: op.expected_version, current_version: outcome.currentVersion });
    } else if (outcome.kind === "failed") {
      for (const s of snaps) await setApplyOutcome(kit, tx, locked, s, "not_applied", null);
      const doneId = await recordAttempt(kit, tx, { ...base, outcome: "failed", error_code: outcome.code });
      await setOperationState(kit, tx, locked, "failed", { failure: { code: outcome.code, message: outcome.message } });
      await emit(kit, tx, locked, "apply.failed", { attempt_id: doneId, code: outcome.code });
    } else {
      const doneId = await recordAttempt(kit, tx, { ...base, outcome: "unknown", error_code: outcome.code });
      await setOperationState(kit, tx, locked, "unknown", { failure: { code: outcome.code, message: outcome.message } });
      await emit(kit, tx, locked, "apply.unknown", { attempt_id: doneId, code: outcome.code });
    }
  });
  return summary(`apply ${outcome.kind}`);
}

/* =====================================================================================
 * compensate
 * ===================================================================================== */

interface CompensationRecord {
  id: string;
  workspace_id: string;
  operation_id: string;
  state: string;
  plan_hash: string;
  expected_version: string;
  failure_code: string | null;
}

type CompensatePre =
  | { kind: "skip"; note: string }
  | { kind: "dispatch"; op: OperationRow; comp: CompensationRecord; snaps: Snapshot[]; connectorRow: ConnectorDbRow; attemptId: string };

function requireCompensationId(job: JobRecord): string {
  if (!job.compensation_id) throw new AppError("INTERNAL_ERROR", "compensate job has no compensation");
  return job.compensation_id;
}

export async function executeCompensate(kit: UndoKit, job: JobRecord): Promise<ExecutionSummary> {
  const summary = (note: string): ExecutionSummary => ({ job_id: job.id, kind: "compensate", note });
  const compensationId = requireCompensationId(job);

  // Phase A: cheap state check and live read, no lock held across the network call.
  const peek = await kit.db.transaction(async (tx) => {
    const comp = await loadCompensation(tx, compensationId, false);
    if (comp.state === "compensating") {
      const op = await loadOperationRow(tx, job.workspace_id, comp.operation_id, true);
      const lockedComp = await loadCompensation(tx, comp.id, true);
      if (lockedComp.state === "compensating") await markInterrupted(kit, tx, op, lockedComp, "INTERRUPTED", "worker lease expired while the attempt was in flight; the remote write may have happened");
      return { kind: "skip" as const, note: "interrupted compensation recovered as unknown; reconciliation queued" };
    }
    if (comp.state !== "approved") return { kind: "skip" as const, note: `compensation is ${comp.state}; nothing to do` };
    const op = await loadOperationRow(tx, job.workspace_id, comp.operation_id);
    const connectorRow = await findConnector(tx, op.connector_id);
    return { kind: "go" as const, op, connectorRow };
  });
  if (peek.kind === "skip") return summary(peek.note);
  const live = await tryRead(kit.connectors.get(peek.connectorRow), peek.op.record_ref);

  // Phase B: decide under lock whether the restore is still safe, then mark the attempt started.
  const pre = await kit.db.transaction<CompensatePre>(async (tx) => {
    const op = await loadOperationRow(tx, job.workspace_id, job.operation_id, true);
    const comp = await loadCompensation(tx, compensationId, true);
    if (comp.state !== "approved") return { kind: "skip", note: "compensation is no longer approved" };
    const now = kit.clock.now();
    const snaps = await loadSnapshots(kit, tx, op.id);
    const approval = (
      await tx.query<{ id: string; plan_hash: string; expires_at: string }>(
        "SELECT id, plan_hash, expires_at FROM approvals WHERE compensation_id = $1::uuid AND phase = 'compensate' ORDER BY created_at DESC, id DESC LIMIT 1",
        [comp.id],
      )
    ).rows[0];
    const fail = async (code: string, message: string): Promise<CompensatePre> => {
      await setCompensationState(kit, tx, comp, "failed", { failure: { code, message } });
      await emit(kit, tx, op, "compensation.failed", { compensation_id: comp.id, code });
      return { kind: "skip", note: message };
    };
    const invalidate = async (code: string, message: string, type: string): Promise<CompensatePre> => {
      await setCompensationState(kit, tx, comp, "planned", { failure: { code, message } });
      await emit(kit, tx, op, type, { compensation_id: comp.id, code });
      return { kind: "skip", note: message };
    };
    if (!approval) return fail("APPROVAL_MISSING", "no approval is recorded for this compensation; nothing was written");
    if (Date.parse(approval.expires_at) <= now.getTime()) return invalidate("APPROVAL_EXPIRED", "the compensation approval expired; approve again", "approval.expired");
    if (op.state !== "applied" || !op.observed_version) return fail("INVALID_STATE", "the operation is not in an applied state; nothing was written");
    const recomputed = computeCompensationPlanHash(compensationPlanInput(kit, op, comp.expected_version, snaps));
    if (recomputed !== approval.plan_hash || recomputed !== comp.plan_hash) {
      return invalidate("PLAN_HASH_MISMATCH", "the compensation plan changed after approval; approval invalidated, nothing was written", "approval.invalidated");
    }
    const connectorRow = await findConnector(tx, op.connector_id);
    if (connectorRow.disabled_at) return fail("CONNECTOR_UNAVAILABLE", "connector is disabled; nothing was written");
    if (!kit.connectors.get(connectorRow).supportsAtomicConditionalWrite) return fail("CONNECTOR_READ_ONLY", "connector does not support atomic conditional writes; nothing was written");
    if (live === undefined) return fail("CONNECTOR_UNAVAILABLE", "the record could not be read to verify the restore is safe; nothing was written");
    const conflicts = computeConflicts(op.observed_version, snaps, live);
    if (conflicts.length > 0) {
      await tx.query("UPDATE compensations SET conflicts_enc = $2::jsonb WHERE id = $1::uuid", [comp.id, JSON.stringify(kit.keyring.encryptJson("conflicts", conflicts, `compensation:${comp.id}`))]);
      await setCompensationState(kit, tx, comp, "conflict", { failure: { code: "COMPENSATION_BLOCKED", message: "the record changed since the apply; nothing was written" } });
      await emit(kit, tx, op, "compensation.blocked", { compensation_id: comp.id, conflicts: conflicts.map((c) => ({ field: c.field, code: c.code })) });
      return { kind: "skip", note: "compensation blocked by conflicts; nothing was written" };
    }
    const attemptId = await recordAttempt(kit, tx, { workspace_id: op.workspace_id, operation_id: op.id, compensation_id: comp.id, phase: "compensate", outcome: "started", detail: { approval_id: approval.id } });
    await setCompensationState(kit, tx, comp, "compensating");
    await emit(kit, tx, op, "compensation.started", { compensation_id: comp.id, attempt_id: attemptId, approval_id: approval.id, expected_version: comp.expected_version });
    return { kind: "dispatch", op, comp, snaps, connectorRow, attemptId };
  });
  if (pre.kind === "skip") return summary(pre.note);

  const { op, comp, snaps, connectorRow, attemptId } = pre;
  const connector = kit.connectors.get(connectorRow);
  await kit.faults.at("compensate.before_remote", { operation_id: op.id, compensation_id: comp.id });
  let outcome: Outcome;
  try {
    outcome = fromWriteResult(
      await connector.conditionalWrite(op.record_ref, Object.fromEntries(snaps.map((s) => [s.field, s.before])), comp.expected_version, { requestId: attemptId }),
    );
  } catch (err) {
    outcome = classifyWriteError(err);
  }
  let readback: ConnectorRecord | null | undefined;
  if (outcome.kind === "written") {
    await kit.faults.at("compensate.after_remote_success", { operation_id: op.id, compensation_id: comp.id });
    readback = await tryRead(connector, op.record_ref);
  }

  await kit.db.transaction(async (tx) => {
    const lockedOp = await loadOperationRow(tx, op.workspace_id, op.id, true);
    const lockedComp = await loadCompensation(tx, comp.id, true);
    const lost = await leaseLost(tx, job);
    if (lost || (lockedComp.state !== "compensating" && lockedComp.state !== "unknown")) {
      await recordLateResult(kit, tx, lockedOp, comp, attemptId, outcome, readback, lockedComp.state, lost);
      if (outcome.kind === "written" && lockedComp.state === "failed" && isReopenable(lockedComp.failure_code)) {
        await reopenAfterLateResult(kit, tx, lockedOp, lockedComp, attemptId);
      }
      return;
    }
    const wasUnknown = lockedComp.state === "unknown";
    const base = { workspace_id: op.workspace_id, operation_id: op.id, compensation_id: comp.id, phase: "compensate" as const, started_attempt_id: attemptId };
    if (outcome.kind === "written") {
      const newVersion = outcome.newVersion;
      const observedVersion = readback ? readback.version : newVersion;
      const results: { field: string; outcome: CompensationFieldOutcome }[] = [];
      for (const s of snaps) {
        let fieldOutcome: CompensationFieldOutcome = "restored";
        if (readback && (readback.fields[s.field] ?? null) !== s.before) fieldOutcome = readback.version === newVersion ? "mismatch" : "changed_other";
        await setCompensationOutcome(tx, lockedOp, s.field, fieldOutcome);
        results.push({ field: s.field, outcome: fieldOutcome });
      }
      const allRestored = results.every((r) => r.outcome === "restored");
      const doneId = await recordAttempt(kit, tx, {
        ...base,
        outcome: allRestored ? "succeeded" : "unknown",
        provider_request_id: outcome.requestId,
        observed_version: observedVersion,
        error_code: allRestored ? null : "RESTORE_INCOMPLETE",
        detail: { readback: readback ? "verified" : "unavailable", write_version: newVersion },
      });
      if (allRestored) {
        await setCompensationState(kit, tx, lockedComp, "compensated");
        await emit(kit, tx, lockedOp, "compensation.succeeded", { compensation_id: comp.id, attempt_id: doneId, observed_version: observedVersion, fields: results });
      } else {
        await setCompensationState(kit, tx, lockedComp, "unknown", { failure: { code: "RESTORE_INCOMPLETE", message: "the restore was written but the read-back did not match; review required" } });
        await emit(kit, tx, lockedOp, "compensation.unknown", { compensation_id: comp.id, attempt_id: doneId, fields: results });
      }
    } else if (outcome.kind === "conflict") {
      for (const s of snaps) await setCompensationOutcome(tx, lockedOp, s.field, "not_restored");
      const doneId = await recordAttempt(kit, tx, { ...base, outcome: "conflict", provider_request_id: outcome.requestId, observed_version: outcome.currentVersion, error_code: "VERSION_CONFLICT" });
      await setCompensationState(kit, tx, lockedComp, wasUnknown ? "failed" : "conflict", { failure: { code: "VERSION_CONFLICT", message: "the provider rejected the version precondition; nothing was written" } });
      await emit(kit, tx, lockedOp, "compensation.conflict", { compensation_id: comp.id, attempt_id: doneId, expected_version: comp.expected_version, current_version: outcome.currentVersion });
    } else if (outcome.kind === "failed") {
      for (const s of snaps) await setCompensationOutcome(tx, lockedOp, s.field, "not_restored");
      const doneId = await recordAttempt(kit, tx, { ...base, outcome: "failed", error_code: outcome.code });
      await setCompensationState(kit, tx, lockedComp, "failed", { failure: { code: outcome.code, message: outcome.message } });
      await emit(kit, tx, lockedOp, "compensation.failed", { compensation_id: comp.id, attempt_id: doneId, code: outcome.code });
    } else {
      const doneId = await recordAttempt(kit, tx, { ...base, outcome: "unknown", error_code: outcome.code });
      await setCompensationState(kit, tx, lockedComp, "unknown", { failure: { code: outcome.code, message: outcome.message } });
      await emit(kit, tx, lockedOp, "compensation.unknown", { compensation_id: comp.id, attempt_id: doneId, code: outcome.code });
    }
  });
  return summary(`compensate ${outcome.kind}`);
}

/* =====================================================================================
 * reconcile (read-only against the provider)
 * ===================================================================================== */

export async function executeReconcile(kit: UndoKit, job: JobRecord): Promise<ExecutionSummary> {
  const summary = (note: string): ExecutionSummary => ({ job_id: job.id, kind: "reconcile", note });
  const { op, comp, connectorRow } = await kit.db.transaction(async (tx) => {
    const operation = await loadOperationRow(tx, job.workspace_id, job.operation_id);
    const compensation = job.compensation_id ? await loadCompensation(tx, job.compensation_id, false) : null;
    return { op: operation, comp: compensation, connectorRow: await findConnector(tx, operation.connector_id) };
  });
  if (comp ? comp.state !== "unknown" : op.state !== "unknown") return summary("nothing to reconcile; state already resolved");
  const connector = kit.connectors.get(connectorRow);
  const live = await tryRead(connector, op.record_ref);

  return kit.db.transaction(async (tx) => {
    const lockedOp = await loadOperationRow(tx, op.workspace_id, op.id, true);
    const lockedComp = comp ? await loadCompensation(tx, comp.id, true) : null;
    if (lockedComp ? lockedComp.state !== "unknown" : lockedOp.state !== "unknown") return summary("resolved elsewhere; nothing to do");
    const snaps = await loadSnapshots(kit, tx, op.id);
    const lastUnknown = (
      await tx.query<{ id: string }>(
        comp
          ? "SELECT id FROM attempts WHERE compensation_id = $1::uuid AND outcome IN ('unknown','reconciled_indeterminate') ORDER BY created_at DESC, id DESC LIMIT 1"
          : "SELECT id FROM attempts WHERE operation_id = $1::uuid AND compensation_id IS NULL AND outcome IN ('unknown','reconciled_indeterminate') ORDER BY created_at DESC, id DESC LIMIT 1",
        [comp ? comp.id : op.id],
      )
    ).rows[0];
    const base = { workspace_id: op.workspace_id, operation_id: op.id, compensation_id: comp?.id ?? null, phase: "reconcile" as const, started_attempt_id: lastUnknown?.id ?? null };
    const startedAt = (
      await tx.query<{ created_at: string }>(
        comp
          ? "SELECT created_at FROM attempts WHERE compensation_id = $1::uuid AND outcome = 'started' ORDER BY created_at DESC, id DESC LIMIT 1"
          : "SELECT created_at FROM attempts WHERE operation_id = $1::uuid AND compensation_id IS NULL AND phase = 'apply' AND outcome = 'started' ORDER BY created_at DESC, id DESC LIMIT 1",
        [comp ? comp.id : op.id],
      )
    ).rows[0]!;
    const quietUntil = new Date(Date.parse(startedAt.created_at) + quietPeriodMs(kit.config));
    // "Not applied" is only safe once a worker that lost its lease can no longer deliver a late write.
    const deferUntilQuiet = async (): Promise<ExecutionSummary> => {
      const id = await recordAttempt(kit, tx, { ...base, outcome: "reconciled_indeterminate", error_code: "QUIET_PERIOD", detail: { retry_after: quietUntil.toISOString() } });
      await emit(kit, tx, lockedOp, "reconcile.deferred", { attempt_id: id, retry_after: quietUntil.toISOString(), compensation_id: comp?.id ?? null });
      await enqueueJob(kit, tx, {
        workspace_id: op.workspace_id,
        operation_id: op.id,
        compensation_id: comp?.id ?? null,
        kind: "reconcile",
        dedupe_key: `reconcile:${comp?.id ?? op.id}:${id}`,
        available_at: quietUntil,
      });
      return summary("reconciliation deferred: the quiet period after the attempt has not elapsed; state remains unknown");
    };
    const indeterminate = async (code: string, detail: Record<string, unknown>): Promise<ExecutionSummary> => {
      const id = await recordAttempt(kit, tx, { ...base, outcome: "reconciled_indeterminate", error_code: code, detail });
      await emit(kit, tx, lockedOp, "reconcile.indeterminate", { attempt_id: id, code, compensation_id: comp?.id ?? null });
      return summary("reconciliation indeterminate; state remains unknown");
    };
    if (live === undefined) return indeterminate("CONNECTOR_UNAVAILABLE", { reason: "provider unreadable" });
    if (live === null) return indeterminate("RECORD_MISSING", { reason: "record not found" });

    if (!lockedComp) {
      const matches = snaps.every((s) => (live.fields[s.field] ?? null) === s.intended);
      const untouched = live.version === lockedOp.expected_version && snaps.every((s) => (live.fields[s.field] ?? null) === s.before);
      if (matches && live.version !== lockedOp.expected_version) {
        const results: { field: string; outcome: ApplyFieldOutcome }[] = [];
        for (const s of snaps) {
          await setApplyOutcome(kit, tx, lockedOp, s, "applied", { value: live.fields[s.field] ?? null });
          results.push({ field: s.field, outcome: "applied" });
        }
        const id = await recordAttempt(kit, tx, { ...base, outcome: "reconciled_applied", observed_version: live.version, detail: { attribution: "inferred" } });
        await setOperationState(kit, tx, lockedOp, "applied", { observed_version: live.version });
        await emit(kit, tx, lockedOp, "reconcile.applied", { attempt_id: id, observed_version: live.version, attribution: "inferred", fields: results });
        return summary("reconciled as applied (inferred from observed values and version)");
      }
      if (untouched) {
        if (kit.clock.now() < quietUntil) return deferUntilQuiet();
        for (const s of snaps) await setApplyOutcome(kit, tx, lockedOp, s, "not_applied", null);
        const id = await recordAttempt(kit, tx, { ...base, outcome: "reconciled_not_applied", observed_version: live.version });
        await setOperationState(kit, tx, lockedOp, "failed", { failure: { code: "NOT_APPLIED", message: "reconciliation confirmed the write did not happen" } });
        await emit(kit, tx, lockedOp, "reconcile.not_applied", { attempt_id: id, observed_version: live.version });
        return summary("reconciled as not applied");
      }
      return indeterminate("STATE_AMBIGUOUS", { observed_version: live.version });
    }

    // compensation reconcile
    const restored = snaps.every((s) => (live.fields[s.field] ?? null) === s.before);
    const untouched = live.version === lockedComp.expected_version && snaps.every((s) => (live.fields[s.field] ?? null) === expectedValue(s));
    if (restored && live.version !== lockedComp.expected_version) {
      for (const s of snaps) await setCompensationOutcome(tx, lockedOp, s.field, "restored");
      const id = await recordAttempt(kit, tx, { ...base, outcome: "reconciled_applied", observed_version: live.version, detail: { attribution: "inferred" } });
      await setCompensationState(kit, tx, lockedComp, "compensated");
      await emit(kit, tx, lockedOp, "reconcile.compensated", { compensation_id: lockedComp.id, attempt_id: id, observed_version: live.version, attribution: "inferred" });
      return summary("compensation reconciled as restored (inferred)");
    }
    if (untouched) {
      if (kit.clock.now() < quietUntil) return deferUntilQuiet();
      for (const s of snaps) await setCompensationOutcome(tx, lockedOp, s.field, "not_restored");
      const id = await recordAttempt(kit, tx, { ...base, outcome: "reconciled_not_applied", observed_version: live.version });
      await setCompensationState(kit, tx, lockedComp, "failed", { failure: { code: "NOT_APPLIED", message: "reconciliation confirmed the restore did not happen" } });
      await emit(kit, tx, lockedOp, "reconcile.not_compensated", { compensation_id: lockedComp.id, attempt_id: id });
      return summary("compensation reconciled as not restored");
    }
    return indeterminate("STATE_AMBIGUOUS", { observed_version: live.version });
  });
}

function expectedValue(s: Snapshot): Scalar {
  return s.observed_recorded ? s.observed_after : s.intended;
}
