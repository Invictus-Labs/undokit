// Regression (QA-owned): a job that fails BEFORE dispatch (its first transaction throws an ordinary error, so no attempt
// is started and nothing is sent) must not strand the approval. Before the fix the operation / compensation stayed
// `approved` with a failed job forever: nothing re-queued it, approve required `planned`, and a new compensation plan was
// refused as "already in progress", so one transient error made the change permanently impossible to undo.
import { afterEach, describe, expect, it } from "vitest";
import { approveOperation, compensateOperation, createCompensationPlan } from "../../src/index.js";
import { makeEnv, type Env } from "../helpers/kit.js";

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** Make the next `db.transaction` call (the executor's first transaction) throw a transient error once. */
function failNextTransaction(e: Env): () => void {
  const db = e.kit.db;
  const original = db.transaction.bind(db);
  let calls = 0;
  db.transaction = (async (fn: Parameters<typeof original>[0]) => {
    calls += 1;
    if (calls === 1) throw new Error("transient database error");
    return original(fn);
  }) as typeof db.transaction;
  return () => {
    db.transaction = original as typeof db.transaction;
  };
}

describe("a job that fails before dispatch releases its approval instead of stranding it", () => {
  it("compensation: the failed compensate job returns the compensation to planned (DISPATCH_FAILED); it can be approved again and the undo completes with one restore write", async () => {
    env = await makeEnv();
    const e = env;
    const before = e.sim.snapshot("contact-0001")!.fields["lifecycle_stage"];
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    expect((await e.view(op.id)).state).toBe("applied");
    const writesAfterApply = e.sim.calls.write;

    const plan = await createCompensationPlan(e.kit, e.operator, op.id);
    expect(plan.state).toBe("planned");
    await compensateOperation(e.kit, e.operator, op.id, { plan_hash: plan.plan_hash });

    const restore = failNextTransaction(e);
    const r = await e.worker.runOnce();
    restore();
    expect(r?.job_state).toBe("failed");
    expect(e.sim.calls.write).toBe(writesAfterApply); // nothing was sent
    const comp = (await e.view(op.id)).compensations.find((c) => c.id === plan.id)!;
    expect(comp.state).toBe("planned");
    expect(comp.failure?.code).toBe("DISPATCH_FAILED");

    // The same plan can be approved again, and the undo runs to completion.
    await compensateOperation(e.kit, e.operator, op.id, { plan_hash: plan.plan_hash });
    await e.worker.runOnce();
    const done = (await e.view(op.id)).compensations.find((c) => c.id === plan.id)!;
    expect(done.state).toBe("compensated");
    expect(done.failure).toBeNull();
    expect(e.sim.snapshot("contact-0001")!.fields["lifecycle_stage"]).toBe(before);
    expect(e.sim.calls.write).toBe(writesAfterApply + 1);
  });

  it("apply: the failed apply job returns the operation to planned (DISPATCH_FAILED); approving again applies it exactly once", async () => {
    env = await makeEnv();
    const e = env;
    const p = await e.planAndApprove({ lifecycle_stage: "customer" });

    const restore = failNextTransaction(e);
    const r = await e.worker.runOnce();
    restore();
    expect(r?.job_state).toBe("failed");
    expect(e.sim.calls.write).toBe(0);
    const view = await e.view(p.id);
    expect(view.state).toBe("planned");
    expect(view.failure?.code).toBe("DISPATCH_FAILED");

    await approveOperation(e.kit, e.operator, p.id, { plan_hash: p.plan_hash, expected_version: view.expected_version });
    await e.worker.runOnce();
    expect((await e.view(p.id)).state).toBe("applied");
    expect(e.sim.calls.write).toBe(1);
  });
});
