// P1 regressions found by the independent review (QA-owned).
//
// P1-1: the remote write succeeded but the transaction that records the result failed. The operation (or compensation) must not be left
//       in 'applying'/'compensating' behind a job marked failed: it becomes UNKNOWN with an interrupted/finalize-failed attempt and a
//       reconcile job, and read-only reconciliation resolves it WITHOUT a second write. If even the mark-unknown step fails, the job
//       stays leased so that lease reclaim recovers it.
// P1-2: a write that is still in flight at the provider when its lease expires must not be reconciled as NOT_APPLIED while the late write
//       can still land. During the quiet period the operation stays UNKNOWN; once the write lands it reconciles to APPLIED and stays
//       compensable. A connector whose worst-case time exceeds the lease is rejected at creation with an actionable error.
//
// Failures are injected at the database seam (kit.db.transaction) right after the remote write returns, so no production code is
// replaced. Each test names what it pins; each was run against the pre-fix source and failed there (revert controls).
import { afterEach, describe, expect, it } from "vitest";
import {
  AppError,
  createCompensationPlan,
  createConnector,
  compensateOperation,
  listCompensations,
  listOperationEvents,
  type ConnectorRecord,
  type CrmConnector,
  type Scalar,
  type SimulatorConnector,
  type WriteResult,
} from "../../src/index.js";
import { createWorker } from "../../src/index.js";
import { connectorDeadlineMs, quietPeriodMs } from "../../src/config.js";
import { makeEnv, rejection, type Env } from "../helpers/kit.js";

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const REF = "contact-0001";
const stage = (e: Env): unknown => e.sim.snapshot(REF)?.fields["lifecycle_stage"];

/** Make the next `n` calls to kit.db.transaction throw. Returns a restore function. */
function failTransactions(e: Env, n: number, message = "simulated transaction failure"): { restore: () => void; failed: () => number } {
  const db = e.kit.db;
  const original = db.transaction.bind(db);
  let left = n;
  let failed = 0;
  db.transaction = (async (fn: Parameters<typeof original>[0]) => {
    if (left > 0) {
      left -= 1;
      failed += 1;
      throw new Error(message);
    }
    return original(fn);
  }) as typeof db.transaction;
  return {
    restore: () => {
      db.transaction = original as typeof db.transaction;
    },
    failed: () => failed,
  };
}

const jobs = async (e: Env) => (await e.kit.db.query<{ kind: string; state: string }>("SELECT kind, state FROM jobs ORDER BY created_at, id")).rows;
const attemptCodes = async (e: Env, column: "operation_id" | "compensation_id", id: string) =>
  (await e.kit.db.query<{ outcome: string; error_code: string | null }>(`SELECT outcome, error_code FROM attempts WHERE ${column} = $1::uuid ORDER BY created_at, id`, [id])).rows;

describe("P1-1 apply: the write landed but recording it failed", () => {
  it("one failed finalize transaction: UNKNOWN with an interrupted attempt and a reconcile job; reconciliation makes it APPLIED with exactly one write", async () => {
    env = await makeEnv();
    const e = env;
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    let inj: ReturnType<typeof failTransactions> | undefined;
    e.kit.faults.onPoint("apply.after_remote_success", () => {
      inj = failTransactions(e, 1);
    });
    const ran = await e.worker.runOnce();
    inj?.restore();
    expect(inj?.failed(), "the finalize transaction really was failed").toBe(1);
    expect(ran?.job_state, "recovery converted the attempt, so the job is finished").toBe("done");
    expect(stage(e)).toBe("customer"); // the provider has the write
    const view = await e.view(p.id);
    expect(view.state).toBe("unknown");
    const codes = await attemptCodes(e, "operation_id", p.id);
    expect(codes.some((a) => a.outcome === "unknown" && ["INTERRUPTED", "FINALIZE_FAILED"].includes(a.error_code ?? ""))).toBe(true);
    expect((await jobs(e)).some((j) => j.kind === "reconcile" && j.state === "queued")).toBe(true);

    e.advance(60 * 60 * 1000);
    await e.worker.drain();
    expect((await e.view(p.id)).state).toBe("applied");
    expect(e.sim.calls.write).toBe(1); // reconciliation never writes
    expect(e.sim.calls.writeApplied).toBe(1);
  });

  it("finalize AND mark-unknown both fail: the job stays leased, the operation is not left failed, and lease reclaim recovers it to APPLIED (one write)", async () => {
    env = await makeEnv();
    const e = env;
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    let inj: ReturnType<typeof failTransactions> | undefined;
    e.kit.faults.onPoint("apply.after_remote_success", () => {
      inj = failTransactions(e, 2);
    });
    const ran = await e.worker.runOnce();
    inj?.restore();
    expect(inj?.failed()).toBe(2);
    expect(ran?.job_state, "recovery itself failed: the job is left leased for lease expiry to reclaim").toBe("leased");
    const stuck = await jobs(e);
    expect(stuck.filter((j) => j.kind === "apply").map((j) => j.state)).toEqual(["leased"]); // not marked failed, not done
    expect(["applying", "unknown"]).toContain((await e.view(p.id)).state);

    expect(await e.worker.runOnce()).toBeNull(); // the lease is still held: nothing is runnable yet
    e.advance(e.kit.config.leaseMs);
    await e.worker.drain(); // reclaim: interrupted -> UNKNOWN -> reconcile
    e.advance(60 * 60 * 1000);
    await e.worker.drain();
    expect((await e.view(p.id)).state).toBe("applied");
    expect(e.sim.calls.writeApplied).toBe(1);
    expect(e.sim.calls.write).toBe(1);
  });
});

describe("P1-1 compensate: the restore landed but recording it failed", () => {
  async function applied(e: Env): Promise<string> {
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    expect((await e.view(op.id)).state).toBe("applied");
    return op.id;
  }

  it("one failed finalize transaction: the compensation is UNKNOWN with an interrupted attempt and a reconcile job; reconciliation makes it COMPENSATED with one extra write", async () => {
    env = await makeEnv();
    const e = env;
    const opId = await applied(e);
    const plan = await createCompensationPlan(e.kit, e.operator, opId);
    const approved = await compensateOperation(e.kit, e.operator, opId, { plan_hash: plan.plan_hash });
    let inj: ReturnType<typeof failTransactions> | undefined;
    e.kit.faults.onPoint("compensate.after_remote_success", () => {
      inj = failTransactions(e, 1);
    });
    const ran = await e.worker.runOnce();
    inj?.restore();
    expect(inj?.failed()).toBe(1);
    expect(ran?.job_state).toBe("done");
    expect(stage(e)).toBe("lead"); // the provider has the restore
    const comp = (await e.kit.db.query<{ state: string }>("SELECT state FROM compensations WHERE id = $1::uuid", [approved.compensation_id])).rows[0];
    expect(comp?.state).toBe("unknown");
    const codes = await attemptCodes(e, "compensation_id", approved.compensation_id);
    expect(codes.some((a) => a.outcome === "unknown" && ["INTERRUPTED", "FINALIZE_FAILED"].includes(a.error_code ?? ""))).toBe(true);
    expect((await jobs(e)).some((j) => j.kind === "reconcile" && j.state === "queued")).toBe(true);

    e.advance(60 * 60 * 1000);
    await e.worker.drain();
    const after = (await e.kit.db.query<{ state: string }>("SELECT state FROM compensations WHERE id = $1::uuid", [approved.compensation_id])).rows[0];
    expect(after?.state).toBe("compensated");
    expect(e.sim.calls.writeApplied).toBe(2); // the apply and the one restore, never a repeat
  });

  it("finalize AND mark-unknown both fail: the job stays leased and lease reclaim recovers it to COMPENSATED (no repeated write)", async () => {
    env = await makeEnv();
    const e = env;
    const opId = await applied(e);
    const plan = await createCompensationPlan(e.kit, e.operator, opId);
    const approved = await compensateOperation(e.kit, e.operator, opId, { plan_hash: plan.plan_hash });
    let inj: ReturnType<typeof failTransactions> | undefined;
    e.kit.faults.onPoint("compensate.after_remote_success", () => {
      inj = failTransactions(e, 2);
    });
    const ran = await e.worker.runOnce();
    inj?.restore();
    expect(inj?.failed()).toBe(2);
    expect(ran?.job_state).toBe("leased");
    expect((await jobs(e)).filter((j) => j.kind === "compensate").map((j) => j.state)).toEqual(["leased"]);
    expect(await e.worker.runOnce()).toBeNull();
    e.advance(e.kit.config.leaseMs);
    await e.worker.drain();
    e.advance(60 * 60 * 1000);
    await e.worker.drain();
    const after = (await e.kit.db.query<{ state: string }>("SELECT state FROM compensations WHERE id = $1::uuid", [approved.compensation_id])).rows[0];
    expect(after?.state).toBe("compensated");
    expect(e.sim.calls.writeApplied).toBe(2);
  });
});

/** The simulator behind a gate: the write is held in flight until the test releases it. */
class Gated implements CrmConnector {
  kind = "simulator" as const;
  live = false;
  label = "gated simulator wrapper";
  supportsAtomicConditionalWrite = true;
  private release!: () => void;
  private entered!: () => void;
  readonly inFlight = new Promise<void>((r) => (this.entered = r));
  private readonly gate = new Promise<void>((r) => (this.release = r));
  constructor(readonly sim: SimulatorConnector) {}
  read(ref: string): Promise<ConnectorRecord | null> {
    return this.sim.read(ref);
  }
  async ping(): Promise<void> {}
  async conditionalWrite(ref: string, patch: Readonly<Record<string, Scalar>>, version: string, ctx: { requestId: string }): Promise<WriteResult> {
    this.entered();
    await this.gate; // the request is "on the wire"; the provider has not committed yet
    return this.sim.conditionalWrite(ref, patch, version, ctx);
  }
  land(): void {
    this.release();
  }
}

describe("P1-2 a write in flight past the lease is never reconciled as NOT_APPLIED while it can still land", () => {
  it("quiet period: a second worker reclaims the expired lease but the operation stays UNKNOWN; after the late write lands it reconciles to APPLIED and is compensable", async () => {
    env = await makeEnv();
    const e = env;
    const gated = new Gated(e.sim);
    e.kit.connectors.register(e.connectorId, gated);
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });

    const workerA = createWorker(e.kit, { workerId: "worker-a", heartbeatMs: 0 }); // a worker that stopped renewing its lease
    const runA = workerA.runOnce(); // holds the lease while the write is in flight
    await gated.inFlight;
    expect((await e.view(p.id)).state).toBe("applying");

    e.advance(e.kit.config.leaseMs + 1); // the lease expires with the write still in flight
    const workerB = createWorker(e.kit, { workerId: "worker-b" });
    await workerB.drain(); // reclaims the apply job, then tries the reconcile job
    const mid = await e.view(p.id);
    expect(mid.state, "must not be concluded while the write may still land").toBe("unknown");
    expect(mid.failure?.code).not.toBe("NOT_APPLIED");
    expect(e.sim.calls.writeApplied).toBe(0);

    gated.land(); // the late write now commits at the provider
    const lateRun = await runA;
    expect(lateRun?.job_state, "fenced: a worker that lost its lease does not mark the job done").toBe("lost");
    expect(e.sim.calls.writeApplied).toBe(1);
    // The late result is never dropped: it is recorded as evidence, flagged as late and as a lost lease.
    const events = await listOperationEvents(e.kit, e.operator, p.id);
    expect(events.map((x) => x.event_type)).toContain("apply.late_result");
    expect(await attemptCodes(e, "operation_id", p.id)).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "succeeded" })]));
    e.advance(60 * 60 * 1000); // quiet period over
    await workerB.drain();
    await e.worker.drain();
    const done = await e.view(p.id);
    expect(done.state).toBe("applied");
    expect(stage(e)).toBe("customer");
    expect(e.sim.calls.write).toBe(1); // never a second write
    const plan = await createCompensationPlan(e.kit, e.operator, p.id);
    expect(plan.state, "an operation reconciled to applied stays compensable").toBe("planned");
  });

  it("a connector whose worst-case time exceeds the lease is rejected at creation with an actionable error; a safe timeout is accepted", async () => {
    env = await makeEnv({ config: { allowedHosts: ["127.0.0.1"] } });
    const e = env;
    const body = (timeout_ms: number) => ({
      kind: "couchdb",
      name: `couch-${timeout_ms}`,
      policy: { allowed_fields: [{ name: "stage", type: "string", max_length: 16, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
      config: { base_url: "http://127.0.0.1:5984", database: "crm", timeout_ms },
      credentials: { username: "u-placeholder", password: "p-placeholder-123" },
    });
    expect(45_000, "valid for the schema (max 60000) but above the 30 s lease").toBeGreaterThan(e.kit.config.leaseMs);
    const err = await rejection(() => createConnector(e.kit, e.admin, body(45_000)));
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/lease/i);
    expect(err.message).toMatch(/timeout/i);
    expect(err.details?.[0]?.code).toBe("CONNECTOR_TIMEOUT_TOO_LONG");
    const limit = connectorDeadlineMs(e.kit.config); // the bound the service derives from the lease (two calls plus a margin must fit)
    expect(limit).toBeLessThan(e.kit.config.leaseMs / 2 + 1);
    expect(err.message).toContain(String(limit));
    await expect(createConnector(e.kit, e.admin, body(limit))).resolves.toMatchObject({ kind: "couchdb" });
    await expect(createConnector(e.kit, e.admin, { ...body(limit + 1), name: "one-over" })).rejects.toBeInstanceOf(AppError);
  });
});

describe("P1-2 lease heartbeat and fencing", () => {
  it("a running job renews its lease: a second worker cannot reclaim it after the original expiry time has passed", async () => {
    env = await makeEnv();
    const e = env;
    const gated = new Gated(e.sim);
    e.kit.connectors.register(e.connectorId, gated);
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    const workerA = createWorker(e.kit, { workerId: "worker-a", heartbeatMs: 5 });
    const runA = workerA.runOnce();
    await gated.inFlight;
    e.advance(e.kit.config.leaseMs - 1000); // close to the original expiry
    await new Promise((r) => setTimeout(r, 80)); // real time: the heartbeat ticks and renews from the advanced clock
    e.advance(2000); // now past the ORIGINAL expiry
    expect(await createWorker(e.kit, { workerId: "worker-b" }).runOnce(), "the lease was renewed, so nothing is reclaimable").toBeNull();
    expect((await e.view(p.id)).state).toBe("applying");
    gated.land();
    expect((await runA)?.job_state).toBe("done");
    expect((await e.view(p.id)).state).toBe("applied");
    expect(e.sim.calls.write).toBe(1);
  });

  it("without a heartbeat the same situation IS reclaimable (the hook the quiet-period test relies on)", async () => {
    env = await makeEnv();
    const e = env;
    const gated = new Gated(e.sim);
    e.kit.connectors.register(e.connectorId, gated);
    await e.planAndApprove({ lifecycle_stage: "customer" });
    const runA = createWorker(e.kit, { workerId: "worker-a", heartbeatMs: 0 }).runOnce();
    await gated.inFlight;
    e.advance(e.kit.config.leaseMs + 1);
    expect(await createWorker(e.kit, { workerId: "worker-b" }).runOnce(), "reclaimed").not.toBeNull();
    gated.land();
    await runA;
  });
});

describe("P1-2 residual: a stalled write that lands AFTER the quiet period is never left as FAILED NOT_APPLIED", () => {
  it("apply: dead heartbeat, write held past the quiet period, then released -> reopened to UNKNOWN (LATE_RESULT), reconciled to APPLIED, exactly one write, compensable", async () => {
    env = await makeEnv();
    const e = env;
    const gated = new Gated(e.sim);
    e.kit.connectors.register(e.connectorId, gated);
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    const stalled = createWorker(e.kit, { workerId: "stalled", heartbeatMs: 0 }); // the heartbeat is dead: its lease is not renewed
    const runStalled = stalled.runOnce();
    await gated.inFlight;

    const other = createWorker(e.kit, { workerId: "other" });
    e.advance(e.kit.config.leaseMs + 1);
    await other.drain(); // reclaims the job: UNKNOWN, reconcile deferred
    expect((await e.view(p.id)).state).toBe("unknown");
    e.advance(quietPeriodMs(e.kit.config)); // the quiet period passes with the write STILL held
    await other.drain();
    const concluded = await e.view(p.id);
    expect(concluded.state, "the record really was untouched when reconciliation looked").toBe("failed");
    expect(concluded.failure?.code).toBe("NOT_APPLIED");
    expect(e.sim.calls.writeApplied).toBe(0);

    gated.land(); // the stalled write finally commits at the provider
    await runStalled;
    expect(e.sim.calls.writeApplied).toBe(1);
    const reopened = await e.view(p.id);
    expect(reopened.state, "never left failed while the remote value changed").toBe("unknown");
    expect(reopened.failure?.code).toBe("LATE_RESULT");
    expect((await listOperationEvents(e.kit, e.operator, p.id)).map((x) => x.event_type)).toEqual(expect.arrayContaining(["apply.late_result", "apply.reopened"]));

    await e.worker.drain(); // the queued read-only reconcile
    const done = await e.view(p.id);
    expect(done.state).toBe("applied");
    expect(stage(e)).toBe("customer");
    expect(e.sim.calls.write, "no second write, ever").toBe(1);
    expect(done.fields[0]?.apply_outcome).toBe("applied");
    expect((await createCompensationPlan(e.kit, e.operator, p.id)).state, "compensable").toBe("planned");
  }, 60_000);

  it("compensate: the same stall on the restore ends COMPENSATED with exactly one restore write, never FAILED NOT_APPLIED over a changed record", async () => {
    env = await makeEnv();
    const e = env;
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(e.kit, e.operator, op.id);
    const approved = await compensateOperation(e.kit, e.operator, op.id, { plan_hash: plan.plan_hash });
    const gated = new Gated(e.sim);
    e.kit.connectors.register(e.connectorId, gated);
    const stalled = createWorker(e.kit, { workerId: "stalled", heartbeatMs: 0 });
    const runStalled = stalled.runOnce();
    await gated.inFlight;
    const compState = async () => (await listCompensations(e.kit, e.operator, op.id)).find((c) => c.id === approved.compensation_id)!;

    const other = createWorker(e.kit, { workerId: "other" });
    e.advance(e.kit.config.leaseMs + 1);
    await other.drain();
    expect((await compState()).state).toBe("unknown");
    e.advance(quietPeriodMs(e.kit.config));
    await other.drain();
    expect((await compState()).state).toBe("failed");
    expect((await compState()).failure?.code).toBe("NOT_APPLIED");
    expect(stage(e)).toBe("customer"); // the restore had not landed yet

    gated.land();
    await runStalled;
    expect(stage(e)).toBe("lead"); // it landed late
    const reopened = await compState();
    expect(reopened.state).toBe("unknown");
    expect(reopened.failure?.code).toBe("LATE_RESULT");
    expect((await listOperationEvents(e.kit, e.operator, op.id)).map((x) => x.event_type)).toEqual(expect.arrayContaining(["compensate.late_result", "compensation.reopened"]));

    await e.worker.drain();
    expect((await compState()).state).toBe("compensated");
    expect((await e.view(op.id)).state).toBe("applied");
    expect(e.sim.calls.writeApplied, "the original apply and the one restore, nothing else").toBe(2);
  }, 60_000);
});
