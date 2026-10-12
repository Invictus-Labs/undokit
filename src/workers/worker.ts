import type { UndoKit } from "../context.js";
import { InjectedCrash } from "../domain/errors.js";
import { redactText } from "../domain/redact.js";
import { executeApply, executeCompensate, executeReconcile, recoverInFlight, type ExecutionSummary, type JobRecord } from "../services/execution.js";

export interface WorkerOptions {
  workerId?: string;
  /** Lease duration; defaults to the service config. An expired lease is reclaimable by any worker. */
  leaseMs?: number;
  /**
   * How often a running job renews its lease (default lease/3). 0 disables the heartbeat, which tests use to
   * simulate a worker that stopped renewing while its connector call is still in flight.
   */
  heartbeatMs?: number;
}

export interface WorkerResult extends ExecutionSummary {
  /** Final state of the job row after this run ("leased": recovery itself failed, the lease will expire and reclaim it). */
  job_state: "done" | "failed" | "leased" | "lost";
}

export interface Worker {
  /** Claim and run exactly one job; null when nothing is runnable. Never swallows InjectedCrash. */
  runOnce(): Promise<WorkerResult | null>;
  /** Run jobs until none are runnable (bounded). Returns the results in order. */
  drain(max?: number): Promise<WorkerResult[]>;
  /** Poll in the background; returns a stop function. */
  start(intervalMs: number, onError?: (err: unknown) => void): () => void;
}

const CLAIM_SQL = `
UPDATE jobs SET state = 'leased', lease_owner = $1, lease_expires_at = $2::timestamptz,
       attempts_count = attempts_count + 1, updated_at = $3::timestamptz
 WHERE id = (
   SELECT id FROM jobs
    WHERE (state = 'queued' AND available_at <= $3::timestamptz)
       OR (state = 'leased' AND lease_expires_at <= $3::timestamptz)
    ORDER BY available_at, created_at, id
    LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING id, workspace_id, operation_id, compensation_id, kind, lease_owner`;

/**
 * DB-lease worker. A job is claimed by an atomic UPDATE; if the process dies the lease expires and
 * the next worker reclaims it. Handlers never re-send a write that may already have happened: an
 * interrupted attempt becomes UNKNOWN and is resolved by read-only reconciliation (AC-13).
 */
export function createWorker(kit: UndoKit, opts: WorkerOptions = {}): Worker {
  const workerId = opts.workerId ?? `worker-${kit.ids.next().slice(0, 8)}`;
  const leaseMs = opts.leaseMs ?? kit.config.leaseMs;
  const heartbeatMs = opts.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3));

  /** Renew the lease while a handler runs, so a slow connector call is not reclaimed by another worker. */
  function startHeartbeat(jobId: string): () => void {
    if (heartbeatMs <= 0) return () => undefined;
    const timer = setInterval(() => {
      const now = kit.clock.now();
      void kit.db
        .query("UPDATE jobs SET lease_expires_at = $3::timestamptz, updated_at = $4::timestamptz WHERE id = $1::uuid AND state = 'leased' AND lease_owner = $2", [
          jobId,
          workerId,
          new Date(now.getTime() + leaseMs).toISOString(),
          now.toISOString(),
        ])
        .catch(() => undefined);
    }, heartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async function runOnce(): Promise<WorkerResult | null> {
    if (!kit.readiness.ok) return null;
    const now = kit.clock.now();
    const claimed = await kit.db.query<JobRecord>(CLAIM_SQL, [workerId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString()]);
    const job = claimed.rows[0];
    if (!job) return null;
    const stopHeartbeat = startHeartbeat(job.id);
    try {
      const summary =
        job.kind === "apply" ? await executeApply(kit, job) : job.kind === "compensate" ? await executeCompensate(kit, job) : await executeReconcile(kit, job);
      // Fenced by lease owner: a worker whose lease was reclaimed must not mark the job done.
      const marked = await kit.db.query("UPDATE jobs SET state = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = $3::timestamptz WHERE id = $1::uuid AND lease_owner = $2 AND state = 'leased'", [
        job.id,
        workerId,
        kit.clock.now().toISOString(),
      ]);
      return { ...summary, job_state: marked.rowCount > 0 ? "done" : "lost" };
    } catch (err) {
      if (err instanceof InjectedCrash) throw err; // simulated process death: the lease stays held
      const message = redactText(err instanceof Error ? err.message : "error", kit.secrets).split("\n")[0]?.slice(0, 300) ?? "error";
      // An ordinary error after the remote write may have been sent must not strand the operation: convert the
      // in-flight attempt to UNKNOWN with a queued read-only reconcile. If even that fails, leave the job leased
      // so lease expiry reclaims it (the reclaim path performs the same conversion).
      let recovered: boolean;
      try {
        recovered = await recoverInFlight(kit, job, "FINALIZE_FAILED");
      } catch {
        return { job_id: job.id, kind: job.kind, note: message, job_state: "leased" };
      }
      const state = recovered ? "done" : "failed";
      const marked = await kit.db.query(
        "UPDATE jobs SET state = $4, lease_owner = NULL, lease_expires_at = NULL, last_error = $2, updated_at = $3::timestamptz WHERE id = $1::uuid AND lease_owner = $5 AND state = 'leased'",
        [job.id, message, kit.clock.now().toISOString(), state, workerId],
      );
      return { job_id: job.id, kind: job.kind, note: message, job_state: marked.rowCount > 0 ? state : "lost" };
    } finally {
      stopHeartbeat();
    }
  }

  async function drain(max = 100): Promise<WorkerResult[]> {
    const out: WorkerResult[] = [];
    for (let i = 0; i < max; i += 1) {
      const r = await runOnce();
      if (!r) break;
      out.push(r);
    }
    return out;
  }

  function start(intervalMs: number, onError?: (err: unknown) => void): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        await drain(20);
      } catch (err) {
        onError?.(err);
      }
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };
    timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return { runOnce, drain, start };
}
