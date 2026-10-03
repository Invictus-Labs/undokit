import type { UndoKit } from "../context.js";
import { SCHEMA_VERSION, type StatusView } from "../domain/types.js";
import type { Actor } from "./common.js";

const ATTENTION_LIMIT = 50;

export async function getStatus(kit: UndoKit, actor: Actor): Promise<StatusView> {
  const ws = actor.workspace_id;
  const jobs = await kit.db.query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM jobs WHERE workspace_id = $1::uuid GROUP BY state", [ws]);
  const ops = await kit.db.query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM operations WHERE workspace_id = $1::uuid GROUP BY state", [ws]);
  const compUnknown = await kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM compensations WHERE workspace_id = $1::uuid AND state = 'unknown'", [ws]);
  const jobCount = (state: string): number => jobs.rows.find((r) => r.state === state)?.n ?? 0;
  const opCount = (state: string): number => ops.rows.find((r) => r.state === state)?.n ?? 0;

  const attention: StatusView["attention"] = [];
  const unknownOps = await kit.db.query<{ id: string; failure_message: string | null }>(
    "SELECT id, failure_message FROM operations WHERE workspace_id = $1::uuid AND state = 'unknown' ORDER BY updated_at DESC, id LIMIT $2",
    [ws, ATTENTION_LIMIT],
  );
  for (const r of unknownOps.rows) {
    attention.push({
      operation_id: r.id,
      state: "unknown",
      reason: r.failure_message ?? "the outcome of the remote write is unknown",
      next_step: "Request reconciliation (read-only); do not re-apply until it resolves.",
    });
  }
  const unknownComps = await kit.db.query<{ operation_id: string; failure_message: string | null }>(
    "SELECT operation_id, failure_message FROM compensations WHERE workspace_id = $1::uuid AND state = 'unknown' ORDER BY updated_at DESC, id LIMIT $2",
    [ws, ATTENTION_LIMIT],
  );
  for (const r of unknownComps.rows) {
    attention.push({
      operation_id: r.operation_id,
      state: "compensation_unknown",
      reason: r.failure_message ?? "the outcome of the compensation write is unknown",
      next_step: "Request reconciliation (read-only) before planning another compensation.",
    });
  }
  const failed = await kit.db.query<{ id: string; state: string; failure_code: string | null; failure_message: string | null }>(
    "SELECT id, state, failure_code, failure_message FROM operations WHERE workspace_id = $1::uuid AND state IN ('failed','conflict') ORDER BY updated_at DESC, id LIMIT $2",
    [ws, ATTENTION_LIMIT],
  );
  for (const r of failed.rows) {
    attention.push({
      operation_id: r.id,
      state: r.state,
      reason: r.failure_message ?? r.failure_code ?? "the operation did not complete",
      next_step: r.state === "conflict" ? "Nothing was written. Re-read the record and plan again against its current version." : "Nothing was changed by this operation. Review the failure and plan again if still needed.",
    });
  }
  const failedJobs = await kit.db.query<{ operation_id: string; last_error: string | null }>(
    "SELECT operation_id, last_error FROM jobs WHERE workspace_id = $1::uuid AND state = 'failed' ORDER BY updated_at DESC, id LIMIT $2",
    [ws, ATTENTION_LIMIT],
  );
  for (const r of failedJobs.rows) {
    attention.push({ operation_id: r.operation_id, state: "job_failed", reason: r.last_error ?? "a background job failed", next_step: "Check the operation events; the job did not complete." });
  }
  const stale = await kit.db.query<{ id: string }>(
    `SELECT o.id FROM operations o
      WHERE o.workspace_id = $1::uuid AND o.state = 'approved'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.operation_id = o.id AND j.kind = 'apply' AND j.state IN ('queued','leased'))
      ORDER BY o.updated_at DESC, o.id LIMIT $2`,
    [ws, ATTENTION_LIMIT],
  );
  for (const r of stale.rows) {
    attention.push({ operation_id: r.id, state: "approved", reason: "approved but no apply job is queued", next_step: "Check worker health; approve again if the approval expired." });
  }

  return {
    schema_version: SCHEMA_VERSION,
    jobs: { queued: jobCount("queued"), running: jobCount("leased"), failed: jobCount("failed") },
    operations: {
      planned: opCount("planned"),
      approved: opCount("approved"),
      applying: opCount("applying"),
      applied: opCount("applied"),
      failed: opCount("failed"),
      unknown: opCount("unknown"),
      conflict: opCount("conflict"),
    },
    compensations_unknown: compUnknown.rows[0]?.n ?? 0,
    attention: attention.slice(0, ATTENTION_LIMIT),
  };
}
