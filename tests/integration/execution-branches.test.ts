// Defensive and edge branches of the apply, compensate and reconcile executors (QA-owned). Each case makes the executor face a
// state it must refuse or classify correctly: provider rejection, a disabled or read-only connector, a tightened policy, a missing
// approval, a tampered plan, a read-back that fails or disagrees, state changed under its feet, records that vanished. The provider is
// the simulator behind a small scripted wrapper; corrupt-state cases use direct SQL on a scratch database.
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectorRejectedError,
  ConnectorUnavailableError,
  compensateOperation,
  createCompensationPlan,
  listCompensations,
  listOperationEvents,
  requestReconcile,
  type ConnectorRecord,
  type CrmConnector,
  type Scalar,
  type SimulatorConnector,
  type WriteResult,
} from "../../src/index.js";
import { makeEnv, type Env } from "../helpers/kit.js";

class Scripted implements CrmConnector {
  kind = "simulator" as const;
  live = false;
  label = "scripted simulator wrapper";
  supportsAtomicConditionalWrite = true;
  readMode: "pass" | "throw" | "null" | "empty" | "wrong-value" = "pass";
  rejectWrite = false;
  onRead: (() => Promise<void>) | undefined;
  constructor(readonly sim: SimulatorConnector) {}
  async read(ref: string): Promise<ConnectorRecord | null> {
    await this.onRead?.();
    if (this.readMode === "throw") throw new ConnectorUnavailableError("scripted read failure");
    if (this.readMode === "null") return null;
    const rec = await this.sim.read(ref);
    if (!rec) return rec;
    if (this.readMode === "empty") return { ...rec, fields: {} };
    if (this.readMode === "wrong-value") return { ...rec, fields: Object.fromEntries(Object.keys(rec.fields).map((k) => [k, typeof rec.fields[k] === "number" ? 12345 : "tampered"])) as Record<string, Scalar> };
    return rec;
  }
  async ping(): Promise<void> {}
  async conditionalWrite(ref: string, patch: Readonly<Record<string, Scalar>>, version: string, ctx: { requestId: string }): Promise<WriteResult> {
    if (this.rejectWrite) throw new ConnectorRejectedError("scripted rejection", 400);
    return this.sim.conditionalWrite(ref, patch, version, ctx);
  }
}

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function setup(): Promise<{ e: Env; sc: Scripted }> {
  env = await makeEnv();
  const sc = new Scripted(env.sim);
  env.kit.connectors.register(env.connectorId, sc);
  return { e: env, sc };
}

async function insertJob(e: Env, kind: "apply" | "compensate" | "reconcile", operationId: string, compensationId: string | null = null): Promise<void> {
  await e.kit.db.query(
    `INSERT INTO jobs (id, workspace_id, operation_id, compensation_id, kind, state, available_at, dedupe_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6::timestamptz, $7, $6::timestamptz, $6::timestamptz)`,
    [e.kit.ids.next(), e.admin.workspace_id, operationId, compensationId, kind, e.clock.now().toISOString(), `qa-${e.kit.ids.next()}`],
  );
}

const sql = (e: Env, text: string, params: unknown[] = []) => e.kit.db.query(text, params);
const jobStates = async (e: Env) => (await sql(e, "SELECT kind, state, last_error FROM jobs ORDER BY created_at, id")).rows as { kind: string; state: string; last_error: string | null }[];

async function appliedThenApprovedCompensation(e: Env) {
  const op = await e.applyOnce({ lifecycle_stage: "customer" });
  const plan = await createCompensationPlan(e.kit, e.operator, op.id);
  const approved = await compensateOperation(e.kit, e.operator, op.id, { plan_hash: plan.plan_hash });
  return { op, plan, approved };
}

describe("apply executor: refusals and classification", () => {
  it("a provider that definitively rejects the write: FAILED CONNECTOR_REJECTED, nothing written", async () => {
    const { e, sc } = await setup();
    sc.rejectWrite = true;
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    const view = await e.view(op.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("CONNECTOR_REJECTED");
    expect(e.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("lead");
  });

  it("a stray apply job for an operation that is not approved is skipped without touching the provider", async () => {
    const { e } = await setup();
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    await insertJob(e, "apply", op.id);
    const ran = await e.worker.runOnce();
    expect(ran?.note).toMatch(/operation is applied; nothing to do/);
    expect(e.sim.calls.write).toBe(1);
  });

  it("an operation marked approved with no approval row on record is refused (APPROVAL_MISSING), nothing written", async () => {
    const { e } = await setup();
    const plan = await e.plan({ lifecycle_stage: "customer" });
    await sql(e, "UPDATE operations SET state = 'approved' WHERE id = $1::uuid", [plan.id]);
    await insertJob(e, "apply", plan.id);
    await e.worker.runOnce();
    const view = await e.view(plan.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("APPROVAL_MISSING");
    expect(e.sim.calls.write).toBe(0);
  });

  it("a connector disabled after approval: refused with CONNECTOR_UNAVAILABLE", async () => {
    const { e } = await setup();
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    await sql(e, "UPDATE connectors SET disabled_at = $2::timestamptz WHERE id = $1::uuid", [e.connectorId, "2026-01-15T12:00:00.000Z"]);
    await e.worker.runOnce();
    const view = await e.view(p.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("CONNECTOR_UNAVAILABLE");
    expect(e.sim.calls.write).toBe(0);
  });

  it("a connector that lost atomic conditional writes after approval: refused with CONNECTOR_READ_ONLY", async () => {
    const { e, sc } = await setup();
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    sc.supportsAtomicConditionalWrite = false;
    await e.worker.runOnce();
    expect((await e.view(p.id)).failure?.code).toBe("CONNECTOR_READ_ONLY");
    expect(e.sim.calls.write).toBe(0);
  });

  it("a policy tightened after approval: the write is refused with the policy's own code and nothing is written", async () => {
    const { e } = await setup();
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    const tightened = { allowed_fields: [{ name: "lead_score", type: "number", max_length: 8, nullable: false, sensitive: false }], record_prefixes: ["contact-"] };
    await sql(e, "UPDATE connectors SET policy = $2::jsonb WHERE id = $1::uuid", [e.connectorId, JSON.stringify(tightened)]);
    await e.worker.runOnce();
    const view = await e.view(p.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("FIELD_NOT_ALLOWED");
    expect(e.sim.calls.write).toBe(0);
  });

  it("an operation resolved elsewhere while the write was in flight keeps its first resolution; the late result is recorded as evidence, never lost and never written over it", async () => {
    const { e } = await setup();
    e.kit.faults.onPoint("apply.before_remote", async (ctx) => {
      await sql(e, "UPDATE operations SET state = 'failed' WHERE id = $1::uuid", [ctx.operation_id]);
    });
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    const ran = await e.worker.runOnce();
    expect(ran?.note).toBe("apply written");
    const view = await e.view(p.id);
    expect(view.state).toBe("failed"); // not overwritten by the late "applied"
    // Contract change (review P1): the late result is no longer dropped silently. It is an attempt flagged late plus an evidence event.
    expect(view.attempts.map((a) => a.outcome)).toEqual(["started", "succeeded"]);
    expect(view.attempts[1]?.detail).toMatchObject({ late: true, state_at_finalize: "failed" });
    expect((await listOperationEvents(e.kit, e.operator, p.id)).map((ev) => ev.event_type)).toContain("apply.late_result");
    expect(e.sim.calls.writeApplied).toBe(1);
  });

  it("the write succeeded but the read-back failed: applied with the write's own version and no observed value, flagged as unavailable", async () => {
    const { e, sc } = await setup();
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    sc.readMode = "throw";
    await e.worker.runOnce();
    const view = await e.view(p.id);
    expect(view.state).toBe("applied");
    expect(view.observed_version).toBe(e.sim.snapshot("contact-0001")?.version);
    expect(view.fields[0]).toMatchObject({ apply_outcome: "applied", observed_after: null });
    expect(view.attempts.find((a) => a.outcome === "succeeded")?.detail).toMatchObject({ readback: "unavailable" });
  });

  it("the read-back disagrees at the same version: that field is a MISMATCH, never silently applied", async () => {
    const { e, sc } = await setup();
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    sc.readMode = "wrong-value";
    await e.worker.runOnce();
    const view = await e.view(p.id);
    expect(view.fields[0]?.apply_outcome).toBe("mismatch");
    expect(view.fields[0]?.observed_after).toBe("tampered");
  });

  it("a compensation planned after a partial outcome treats the changed field as a conflict (VALUE_CHANGED) from the recorded outcome", async () => {
    const { e } = await setup();
    e.kit.faults.onPoint("apply.after_remote_success", async () => {
      e.sim.externalEdit("contact-0001", { lead_score: 999 });
    });
    const op = await e.applyOnce({ lifecycle_stage: "churned", lead_score: 41 });
    const view = await e.view(op.id);
    expect(view.fields.map((f) => f.apply_outcome).sort()).toEqual(["applied", "changed_other"]);
    const plan = await createCompensationPlan(e.kit, e.operator, op.id);
    expect(plan.state).toBe("conflict");
    expect(plan.conflicts.map((c) => c.code)).toContain("VALUE_CHANGED");
  });

  it("a compensation plan after an apply whose read-back was unavailable compares against the intended values", async () => {
    const { e, sc } = await setup();
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });
    sc.readMode = "throw";
    await e.worker.runOnce();
    sc.readMode = "pass";
    const plan = await createCompensationPlan(e.kit, e.operator, p.id);
    expect(plan.state).toBe("planned");
    expect(plan.fields[0]).toMatchObject({ field: "lifecycle_stage", expected_current: "customer", restore_to: "lead" });
  });
});

describe("compensate executor: refusals and classification", () => {
  it("a compensate job with no compensation id fails the job with a recorded reason, nothing is written", async () => {
    const { e } = await setup();
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    await insertJob(e, "compensate", op.id, null);
    const ran = await e.worker.runOnce();
    expect(ran?.job_state).toBe("failed");
    expect((await jobStates(e)).at(-1)?.last_error).toMatch(/no compensation/);
    expect(e.sim.calls.write).toBe(1);
  });

  it("a compensate job for a compensation that is only planned is skipped", async () => {
    const { e } = await setup();
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(e.kit, e.operator, op.id);
    await insertJob(e, "compensate", op.id, plan.id);
    const ran = await e.worker.runOnce();
    expect(ran?.note).toMatch(/compensation is planned; nothing to do/);
    expect(e.sim.calls.write).toBe(1);
  });

  it("a compensation marked approved with no approval on record fails (APPROVAL_MISSING)", async () => {
    const { e } = await setup();
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(e.kit, e.operator, op.id);
    await sql(e, "UPDATE compensations SET state = 'approved' WHERE id = $1::uuid", [plan.id]);
    await insertJob(e, "compensate", op.id, plan.id);
    await e.worker.runOnce();
    const [comp] = await listCompensations(e.kit, e.operator, op.id);
    expect(comp?.state).toBe("failed");
    expect(comp?.failure?.code).toBe("APPROVAL_MISSING");
    expect(e.sim.calls.write).toBe(1);
  });

  it("the operation stopped being applied after the compensation was approved: the compensation fails INVALID_STATE", async () => {
    const { e } = await setup();
    const { op } = await appliedThenApprovedCompensation(e);
    await sql(e, "UPDATE operations SET state = 'failed' WHERE id = $1::uuid", [op.id]);
    await e.worker.runOnce();
    const [comp] = await listCompensations(e.kit, e.operator, op.id);
    expect(comp?.failure?.code).toBe("INVALID_STATE");
    expect(e.sim.calls.write).toBe(1);
  });

  it("a compensation plan tampered with after approval invalidates the approval (back to planned), nothing written", async () => {
    const { e } = await setup();
    const { op, plan } = await appliedThenApprovedCompensation(e);
    await sql(e, "UPDATE compensations SET plan_hash = $2 WHERE id = $1::uuid", [plan.id, `sha256:${"a".repeat(64)}`]);
    await e.worker.runOnce();
    const [comp] = await listCompensations(e.kit, e.operator, op.id);
    expect(comp?.state).toBe("planned");
    expect(comp?.failure?.code).toBe("PLAN_HASH_MISMATCH");
    expect(e.sim.calls.write).toBe(1);
  });

  it("a connector disabled, read-only or unreadable at compensation time fails the compensation with the matching code and writes nothing", async () => {
    for (const [scenario, expected] of [["disabled", "CONNECTOR_UNAVAILABLE"], ["read-only", "CONNECTOR_READ_ONLY"], ["unreadable", "CONNECTOR_UNAVAILABLE"]] as const) {
      await env?.close();
      const { e, sc } = await setup();
      const { op } = await appliedThenApprovedCompensation(e);
      if (scenario === "disabled") await sql(e, "UPDATE connectors SET disabled_at = $2::timestamptz WHERE id = $1::uuid", [e.connectorId, "2026-01-15T12:00:00.000Z"]);
      if (scenario === "read-only") sc.supportsAtomicConditionalWrite = false;
      if (scenario === "unreadable") sc.readMode = "throw";
      await e.worker.runOnce();
      const [comp] = await listCompensations(e.kit, e.operator, op.id);
      expect(comp?.failure?.code, scenario).toBe(expected);
      expect(e.sim.calls.write, scenario).toBe(1);
    }
  });

  it("a compensation that stops being approved between the live read and the decision is skipped", async () => {
    const { e, sc } = await setup();
    const { op, plan } = await appliedThenApprovedCompensation(e);
    sc.onRead = async () => {
      sc.onRead = undefined;
      await sql(e, "UPDATE compensations SET state = 'planned' WHERE id = $1::uuid", [plan.id]);
    };
    const ran = await e.worker.runOnce();
    expect(ran?.note).toMatch(/no longer approved/);
    expect((await listCompensations(e.kit, e.operator, op.id))[0]?.state).toBe("planned");
    expect(e.sim.calls.write).toBe(1);
  });

  it("a compensation resolved elsewhere while the restore was in flight keeps its first resolution", async () => {
    const { e } = await setup();
    const { op, plan } = await appliedThenApprovedCompensation(e);
    e.kit.faults.onPoint("compensate.before_remote", async () => {
      await sql(e, "UPDATE compensations SET state = 'failed' WHERE id = $1::uuid", [plan.id]);
    });
    await e.worker.runOnce();
    expect((await listCompensations(e.kit, e.operator, op.id))[0]?.state).toBe("failed"); // the first resolution is kept
    const attempts = (await e.view(op.id)).attempts.filter((a) => a.phase === "compensate");
    expect(attempts.map((a) => a.outcome)).toEqual(["started", "succeeded"]); // contract change (review P1): the late result is recorded
    expect(attempts[1]?.detail).toMatchObject({ late: true, state_at_finalize: "failed" });
    expect((await listOperationEvents(e.kit, e.operator, op.id)).map((ev) => ev.event_type)).toContain("compensate.late_result");
  });

  it("the restore was written but the read-back failed: compensated, flagged as unavailable", async () => {
    const { e, sc } = await setup();
    const { op } = await appliedThenApprovedCompensation(e);
    e.kit.faults.onPoint("compensate.after_remote_success", async () => {
      sc.readMode = "throw";
    });
    await e.worker.runOnce();
    const [comp] = await listCompensations(e.kit, e.operator, op.id);
    expect(comp?.state).toBe("compensated");
    expect((await e.view(op.id)).attempts.find((a) => a.phase === "compensate" && a.outcome === "succeeded")?.detail).toMatchObject({ readback: "unavailable" });
  });

  it("the restore's read-back disagrees (same version, wrong value) or shows a later edit: the compensation is UNKNOWN (RESTORE_INCOMPLETE), never compensated", async () => {
    for (const scenario of ["mismatch", "changed_other"] as const) {
      await env?.close();
      const { e, sc } = await setup();
      const { op } = await appliedThenApprovedCompensation(e);
      e.kit.faults.onPoint("compensate.after_remote_success", async () => {
        if (scenario === "mismatch") sc.readMode = "wrong-value";
        else e.sim.externalEdit("contact-0001", { lifecycle_stage: "partner" }); // a later edit to the very field that was restored
      });
      await e.worker.runOnce();
      const [comp] = await listCompensations(e.kit, e.operator, op.id);
      expect(comp?.state, scenario).toBe("unknown");
      expect(comp?.failure?.code, scenario).toBe("RESTORE_INCOMPLETE");
      expect(comp?.fields[0]?.outcome, scenario).toBe(scenario === "mismatch" ? "mismatch" : "changed_other");
    }
  });

  it("the provider is unreachable when the restore is sent: FAILED CONNECTOR_UNAVAILABLE, a definite non-effect", async () => {
    const { e } = await setup();
    const { op } = await appliedThenApprovedCompensation(e);
    e.sim.failNextWrite("unavailable");
    await e.worker.runOnce();
    const [comp] = await listCompensations(e.kit, e.operator, op.id);
    expect(comp?.state).toBe("failed");
    expect(comp?.failure?.code).toBe("CONNECTOR_UNAVAILABLE");
    expect(e.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("customer");
  });
});

describe("reconcile executor: edge cases", () => {
  async function unknownOp(e: Env) {
    e.sim.failNextWrite("ambiguous_after_commit");
    return e.applyOnce({ lifecycle_stage: "customer" });
  }

  it("a reconcile job for an operation that is not unknown is a no-op with an explicit note", async () => {
    const { e } = await setup();
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    await insertJob(e, "reconcile", op.id);
    expect((await e.worker.runOnce())?.note).toMatch(/nothing to reconcile; state already resolved/);
  });

  it("an operation resolved by someone else between the provider read and the decision is left as resolved", async () => {
    const { e, sc } = await setup();
    const op = await unknownOp(e);
    await requestReconcile(e.kit, e.operator, op.id);
    sc.onRead = async () => {
      sc.onRead = undefined;
      await sql(e, "UPDATE operations SET state = 'applied' WHERE id = $1::uuid", [op.id]);
    };
    expect((await e.worker.runOnce())?.note).toMatch(/resolved elsewhere/);
    expect((await e.view(op.id)).state).toBe("applied");
  });

  it("the record vanished at the provider: reconciliation is indeterminate (RECORD_MISSING) for operations and compensations", async () => {
    const { e, sc } = await setup();
    const op = await unknownOp(e);
    await requestReconcile(e.kit, e.operator, op.id);
    sc.readMode = "null";
    expect((await e.worker.runOnce())?.note).toMatch(/indeterminate/);
    expect((await e.view(op.id)).state).toBe("unknown");
    expect((await e.view(op.id)).attempts.find((a) => a.outcome === "reconciled_indeterminate")?.error_code).toBe("RECORD_MISSING");
  });

  it("an UNKNOWN state with no recorded unknown attempt and a live record missing the fields stays indeterminate (STATE_AMBIGUOUS)", async () => {
    const { e, sc } = await setup();
    const plan = await e.planAndApprove({ lifecycle_stage: "customer" });
    await e.worker.runOnce();
    await sql(e, "UPDATE operations SET state = 'unknown', observed_version = NULL WHERE id = $1::uuid", [plan.id]);
    await requestReconcile(e.kit, e.operator, plan.id);
    sc.readMode = "empty";
    await e.worker.runOnce();
    const view = await e.view(plan.id);
    expect(view.state).toBe("unknown");
    expect(view.attempts.find((a) => a.outcome === "reconciled_indeterminate")?.error_code).toBe("STATE_AMBIGUOUS");
  });

  it("an UNKNOWN compensation against a record with no such fields stays indeterminate, and a vanished record is RECORD_MISSING", async () => {
    const { e, sc } = await setup();
    const { op } = await appliedThenApprovedCompensation(e);
    e.sim.failNextWrite("ambiguous_after_commit");
    await e.worker.runOnce();
    expect((await listCompensations(e.kit, e.operator, op.id))[0]?.state).toBe("unknown");
    await requestReconcile(e.kit, e.operator, op.id);
    sc.readMode = "empty";
    await e.worker.runOnce();
    expect((await listCompensations(e.kit, e.operator, op.id))[0]?.state).toBe("unknown");
    await requestReconcile(e.kit, e.operator, op.id);
    sc.readMode = "null";
    await e.worker.runOnce();
    const codes = (await e.view(op.id)).attempts.filter((a) => a.outcome === "reconciled_indeterminate").map((a) => a.error_code);
    expect(codes).toEqual(expect.arrayContaining(["STATE_AMBIGUOUS", "RECORD_MISSING"]));
  });
});
