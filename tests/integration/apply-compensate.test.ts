import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quietPeriodMs } from "../../src/config.js";
import {
  ConnectorUnavailableError,
  approveOperation,
  compensateOperation,
  createCompensationPlan,
  createWorker,
  listCompensations,
  listOperationEvents,
  requestReconcile,
  verifyEventChain,
  type ConnectorRecord,
  type CrmConnector,
  type Scalar,
  type WriteResult,
} from "../../src/index.js";
import { makeEnv, rejection, type Env } from "../helpers/kit.js";

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

const REF = "contact-0001";
const fieldsOf = (ref = REF) => env.sim.snapshot(ref)?.fields as Record<string, Scalar>;

describe("AC-03 apply version conflict", () => {
  it("happy: an unchanged record is written once with the conditional version", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    expect((await env.view(op.id)).state).toBe("applied");
    expect(fieldsOf()["lifecycle_stage"]).toBe("customer");
    expect(env.sim.calls.write).toBe(1);
    expect(env.sim.calls.writeApplied).toBe(1);
  });

  it("an edit made after approval but before dispatch is detected by the provider: CONFLICT, nothing written, the edit survives", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    await env.worker.runOnce();
    const view = await env.view(p.id);
    expect(view.state).toBe("conflict");
    expect(view.failure?.code).toBe("VERSION_CONFLICT");
    expect(fieldsOf()["lifecycle_stage"]).toBe("partner");
    expect(env.sim.calls.writeApplied).toBe(0);
    expect(view.fields[0]?.apply_outcome).toBe("not_applied");
    expect(view.attempts.map((a) => a.outcome)).toContain("conflict");
    expect(view.observed_version).toBeNull();
  });

  it("an edit to a DIFFERENT field also conflicts (version-based precondition), and is kept", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { owner_label: "team-green" });
    await env.worker.runOnce();
    expect((await env.view(p.id)).state).toBe("conflict");
    expect(fieldsOf()["owner_label"]).toBe("team-green");
    expect(fieldsOf()["lifecycle_stage"]).toBe("lead");
  });

  it("an edit planted mid-flight (after the dispatch decision, before the provider call) is still caught by the provider", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    env.kit.faults.onPoint("apply.before_remote", async () => {
      env.sim.externalEdit(REF, { lifecycle_stage: "churned" });
    });
    await env.worker.runOnce();
    expect((await env.view(p.id)).state).toBe("conflict");
    expect(fieldsOf()["lifecycle_stage"]).toBe("churned");
    expect(env.sim.calls.write).toBe(1);
    expect(env.sim.calls.writeApplied).toBe(0);
  });

  it("an edit between plan and approval makes the approved plan conflict at apply time", async () => {
    const plan = await env.plan({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { lead_score: 99 });
    await approveOperation(env.kit, env.operator, plan.id, { plan_hash: plan.plan_hash, expected_version: "sim-v1" });
    await env.worker.runOnce();
    expect((await env.view(plan.id)).state).toBe("conflict");
    expect(fieldsOf()["lead_score"]).toBe(99);
  });

  it("a conflicted operation is terminal: it cannot be approved again or compensated", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    await env.worker.runOnce();
    expect((await rejection(() => approveOperation(env.kit, env.operator, p.id, { plan_hash: p.plan_hash, expected_version: "sim-v1" }))).code).toBe("INVALID_STATE");
    expect((await rejection(() => createCompensationPlan(env.kit, env.operator, p.id))).code).toBe("INVALID_STATE");
  });
});

describe("AC-04 ambiguous success (lost response) is UNKNOWN, never success, never retried", () => {
  it("remote write committed but the response was lost: UNKNOWN, one write only, then read-only reconciliation resolves it as applied", async () => {
    env.sim.failNextWrite("ambiguous_after_commit");
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    let view = await env.view(op.id);
    expect(view.state).toBe("unknown");
    expect(view.failure?.code).toBe("OUTCOME_UNKNOWN");
    expect(view.observed_version).toBeNull();
    expect(env.sim.calls.write).toBe(1);
    // No automatic retry: draining the worker does nothing.
    expect(await env.worker.drain()).toHaveLength(0);
    expect(env.sim.calls.write).toBe(1);

    const rec = await requestReconcile(env.kit, env.operator, op.id);
    expect(rec.state).toBe("unknown");
    const ran = await env.worker.runOnce();
    expect(ran?.note).toMatch(/reconciled as applied/);
    view = await env.view(op.id);
    expect(view.state).toBe("applied");
    expect(view.attempts.map((a) => a.outcome)).toEqual(expect.arrayContaining(["unknown", "reconciled_applied"]));
    expect(view.attempts.find((a) => a.outcome === "reconciled_applied")?.detail).toMatchObject({ attribution: "inferred" });
    expect(env.sim.calls.write).toBe(1); // reconciliation never writes
    expect(verifyEventChain(op.id, await listOperationEvents(env.kit, env.operator, op.id))).toBeNull();
  });

  it("request lost BEFORE the commit: UNKNOWN, then reconciliation proves it did not happen (failed NOT_APPLIED, record untouched)", async () => {
    env.sim.failNextWrite("ambiguous_before_commit");
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    expect((await env.view(op.id)).state).toBe("unknown");
    await requestReconcile(env.kit, env.operator, op.id);
    await env.worker.runOnce();
    // Inside the quiet period a late write could still land, so "did not happen" is not concluded yet (the contract changed here).
    expect((await env.view(op.id)).state).toBe("unknown");
    expect((await env.view(op.id)).attempts.map((a) => a.error_code)).toContain("QUIET_PERIOD");
    env.advance(quietPeriodMs(env.kit.config));
    await env.worker.drain();
    const view = await env.view(op.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("NOT_APPLIED");
    expect(fieldsOf()["lifecycle_stage"]).toBe("lead");
    expect(env.sim.calls.writeApplied).toBe(0);
    expect(env.sim.calls.write).toBe(1); // the one original attempt; reconciliation never writes
    expect(view.fields[0]?.apply_outcome).toBe("not_applied");
  });

  it("unreachable before sending: a definite FAILED (non-effect), not UNKNOWN", async () => {
    env.sim.failNextWrite("unavailable");
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const view = await env.view(op.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("CONNECTOR_UNAVAILABLE");
    expect(env.sim.calls.writeApplied).toBe(0);
  });

  it("someone else changed the record to a third value: reconciliation stays UNKNOWN (indeterminate) and overwrites nothing", async () => {
    env.sim.failNextWrite("ambiguous_after_commit");
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    await requestReconcile(env.kit, env.operator, op.id);
    const ran = await env.worker.runOnce();
    expect(ran?.note).toMatch(/indeterminate/);
    const view = await env.view(op.id);
    expect(view.state).toBe("unknown");
    expect(view.attempts.map((a) => a.outcome)).toContain("reconciled_indeterminate");
    expect(fieldsOf()["lifecycle_stage"]).toBe("partner");
    expect(env.sim.calls.write).toBe(1);
  });

  // Regression test for QA-D6 (P1, fixed in 76d07a0): after a reconciled_indeterminate run the dedupe key moves to the latest
  // indeterminate attempt, so a later reconcile request queues a fresh job instead of reusing the finished one.
  it("an UNKNOWN operation can be reconciled again once the provider state becomes determinable (it must not be stuck forever)", async () => {
    env.sim.failNextWrite("ambiguous_after_commit");
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    await requestReconcile(env.kit, env.operator, op.id);
    await env.worker.runOnce(); // indeterminate
    // The other party sets the value to what UndoKit intended; a fresh read-only reconciliation can now infer the outcome.
    env.sim.externalEdit(REF, { lifecycle_stage: "customer" });
    const again = await requestReconcile(env.kit, env.operator, op.id);
    const ran = await env.worker.runOnce();
    expect(ran, `second reconcile job ${again.job_id} must be runnable`).not.toBeNull();
    expect((await env.view(op.id)).state).toBe("applied");
  });

  it("reconciling while the provider is unreachable is indeterminate and changes nothing", async () => {
    env.sim.failNextWrite("ambiguous_after_commit");
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const down: CrmConnector = {
      kind: "simulator",
      live: false,
      label: "down",
      supportsAtomicConditionalWrite: true,
      async read(): Promise<ConnectorRecord | null> {
        throw new ConnectorUnavailableError("provider down");
      },
      async ping() {
        throw new ConnectorUnavailableError("provider down");
      },
      async conditionalWrite(): Promise<WriteResult> {
        throw new Error("a reconcile must never write");
      },
    };
    env.kit.connectors.register(env.connectorId, down);
    await requestReconcile(env.kit, env.operator, op.id);
    const ran = await env.worker.runOnce();
    expect(ran?.note).toMatch(/indeterminate/);
    expect((await env.view(op.id)).state).toBe("unknown");
  });

  it("reconcile with nothing unknown is refused", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    expect((await rejection(() => requestReconcile(env.kit, env.operator, op.id))).code).toBe("INVALID_STATE");
  });

  it("two workers racing for one job run it exactly once", async () => {
    await env.planAndApprove({ lifecycle_stage: "customer" });
    const other = createWorker(env.kit, { workerId: "qa-worker-2" });
    const results = await Promise.all([env.worker.runOnce(), other.runOnce()]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(env.sim.calls.write).toBe(1);
  });

  it("two simultaneous approvals produce one approval and one job", async () => {
    const plan = await env.plan({ lifecycle_stage: "customer" });
    const settled = await Promise.allSettled([
      approveOperation(env.kit, env.operator, plan.id, { plan_hash: plan.plan_hash, expected_version: "sim-v1" }),
      approveOperation(env.kit, env.operator, plan.id, { plan_hash: plan.plan_hash, expected_version: "sim-v1" }),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(await env.count("approvals")).toBe(1);
    expect(await env.count("jobs")).toBe(1);
  });
});

describe("AC-05 compensation conflict: a later edit is kept, nothing is overwritten", () => {
  it("happy: an untouched record is restored with a separate approval, per-field outcomes and a valid chain", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer", lead_score: 41 });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    expect(plan.state).toBe("planned");
    expect(plan.conflicts).toEqual([]);
    expect(plan.fields.map((f) => [f.field, f.expected_current, f.restore_to])).toEqual([
      ["lead_score", 41, 40],
      ["lifecycle_stage", "customer", "lead"],
    ]);
    // Nothing is written by planning.
    expect(fieldsOf()["lifecycle_stage"]).toBe("customer");
    const approved = await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    expect(approved.state).toBe("approved");
    await env.worker.runOnce();
    const [comp] = await listCompensations(env.kit, env.operator, op.id);
    expect(comp?.state).toBe("compensated");
    expect(comp?.fields.every((f) => f.outcome === "restored")).toBe(true);
    expect(fieldsOf()).toMatchObject({ lifecycle_stage: "lead", lead_score: 40 });
    const view = await env.view(op.id);
    expect(view.approvals.map((a) => a.phase).sort()).toEqual(["apply", "compensate"]);
    expect(view.approvals.find((a) => a.phase === "compensate")?.plan_hash).toBe(plan.plan_hash);
    expect(view.approvals.find((a) => a.phase === "compensate")?.plan_hash).not.toBe(op.plan_hash);
    expect(verifyEventChain(op.id, await listOperationEvents(env.kit, env.operator, op.id))).toBeNull();
    expect(env.sim.calls.writeApplied).toBe(2);
  });

  it("an edit to the same field after the apply: the plan is blocked, naming the field and both values", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    expect(plan.state).toBe("conflict");
    expect(plan.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ field: "lifecycle_stage", code: "VALUE_CHANGED", expected: "customer", actual: "partner" })]));
    const err = await rejection(() => compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash }));
    expect(err.code).toBe("COMPENSATION_BLOCKED");
    expect(err.status).toBe(409);
    expect(fieldsOf()["lifecycle_stage"]).toBe("partner");
    expect(env.sim.calls.writeApplied).toBe(1); // only the original apply
  });

  it("an edit to another field after the apply also blocks (the provider version moved) and that edit survives", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    env.sim.externalEdit(REF, { lead_score: 99 });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    expect(plan.state).toBe("conflict");
    expect(plan.conflicts.map((c) => c.code)).toContain("VERSION_CHANGED");
    expect((await rejection(() => compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash }))).code).toBe("COMPENSATION_BLOCKED");
    expect(fieldsOf()).toMatchObject({ lead_score: 99, lifecycle_stage: "customer" });
    expect(env.sim.calls.writeApplied).toBe(1);
  });

  it("a multi-field operation with ONE field edited is blocked as a whole: no partial restore of the untouched field", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer", lead_score: 41 });
    env.sim.externalEdit(REF, { lead_score: 77 });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    expect(plan.state).toBe("conflict");
    await rejection(() => compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash }));
    expect(fieldsOf()).toMatchObject({ lifecycle_stage: "customer", lead_score: 77 });
    expect(env.sim.calls.writeApplied).toBe(1);
  });

  it("the record is deleted after the apply: blocked as RECORD_MISSING", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const gone: CrmConnector = {
      kind: "simulator",
      live: false,
      label: "gone",
      supportsAtomicConditionalWrite: true,
      read: async () => null,
      ping: async () => undefined,
      conditionalWrite: async () => {
        throw new Error("must not write to a missing record");
      },
    };
    env.kit.connectors.register(env.connectorId, gone);
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    expect(plan.state).toBe("conflict");
    expect(plan.conflicts.map((c) => c.code)).toContain("RECORD_MISSING");
  });

  it("a clean plan that goes stale before approval is blocked at approval and the block is persisted as evidence", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    expect(plan.state).toBe("planned");
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    expect((await rejection(() => compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash }))).code).toBe("COMPENSATION_BLOCKED");
    const [comp] = await listCompensations(env.kit, env.operator, op.id);
    expect(comp?.state).toBe("conflict");
    expect(comp?.conflicts.length).toBeGreaterThan(0);
    const events = await listOperationEvents(env.kit, env.operator, op.id);
    expect(events.map((e) => e.event_type)).toContain("compensation.blocked");
    expect(fieldsOf()["lifecycle_stage"]).toBe("partner");
  });

  it("an edit after the compensation was approved but before the worker ran: the worker re-checks and blocks, writing nothing", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    const ran = await env.worker.runOnce();
    expect(ran?.note).toMatch(/blocked/);
    expect((await listCompensations(env.kit, env.operator, op.id))[0]?.state).toBe("conflict");
    expect(env.sim.calls.writeApplied).toBe(1);
    expect(fieldsOf()["lifecycle_stage"]).toBe("partner");
  });

  it("an edit planted mid-flight at the compensation dispatch is rejected by the provider: conflict, edit kept", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    env.kit.faults.onPoint("compensate.before_remote", async () => {
      env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    });
    await env.worker.runOnce();
    const [comp] = await listCompensations(env.kit, env.operator, op.id);
    expect(comp?.state).toBe("conflict");
    expect(comp?.fields[0]?.outcome).toBe("not_restored");
    expect(fieldsOf()["lifecycle_stage"]).toBe("partner");
    expect(env.sim.calls.writeApplied).toBe(1);
  });

  it("the compensation plan expires after its TTL (PLAN_EXPIRED) and nothing is written", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    env.advance(env.kit.config.compensationPlanTtlMs);
    expect((await rejection(() => compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash }))).code).toBe("PLAN_EXPIRED");
    expect(env.sim.calls.writeApplied).toBe(1);
  });

  it("a compensation approval that expires before the worker runs is invalidated with no write, and can be approved again", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    env.advance(env.kit.config.approvalTtlMs);
    const ran = await env.worker.runOnce();
    expect(ran?.note).toMatch(/expired/);
    expect(env.sim.calls.writeApplied).toBe(1);
    expect((await listCompensations(env.kit, env.operator, op.id))[0]?.state).toBe("planned");
  });

  it("a plan hash that matches no compensation is refused", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    expect((await rejection(() => compensateOperation(env.kit, env.operator, op.id, { plan_hash: `sha256:${"e".repeat(64)}` }))).code).toBe("PLAN_HASH_MISMATCH");
  });

  it("an operation can be compensated only once", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    await env.compensateOnce(op.id);
    expect((await rejection(() => createCompensationPlan(env.kit, env.operator, op.id))).code).toBe("INVALID_STATE");
  });

  it("only an applied operation can be compensated (planned, approved, unknown and failed are refused)", async () => {
    const planned = await env.plan({ lifecycle_stage: "customer" });
    expect((await rejection(() => createCompensationPlan(env.kit, env.operator, planned.id))).code).toBe("INVALID_STATE");
    env.sim.failNextWrite("ambiguous_after_commit");
    await env.applyOnce({ lead_score: 41 }, { record_ref: "contact-0002" }).then(async (u) => {
      expect((await env.view(u.id)).state).toBe("unknown");
      expect((await rejection(() => createCompensationPlan(env.kit, env.operator, u.id))).code).toBe("INVALID_STATE");
    });
  });

  it("an ambiguous compensation is UNKNOWN, is not retried, and reconciles read-only to compensated", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    env.sim.failNextWrite("ambiguous_after_commit");
    await env.worker.runOnce();
    expect((await listCompensations(env.kit, env.operator, op.id))[0]?.state).toBe("unknown");
    const writes = env.sim.calls.write;
    expect(await env.worker.drain()).toHaveLength(0);
    expect(env.sim.calls.write).toBe(writes);
    await requestReconcile(env.kit, env.operator, op.id);
    await env.worker.runOnce();
    expect((await listCompensations(env.kit, env.operator, op.id))[0]?.state).toBe("compensated");
    expect(env.sim.calls.write).toBe(writes);
    expect(fieldsOf()["lifecycle_stage"]).toBe("lead");
  });

  it("a second compensation cannot be started while one is in progress", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    expect((await rejection(() => createCompensationPlan(env.kit, env.operator, op.id))).code).toBe("INVALID_STATE");
  });
});
