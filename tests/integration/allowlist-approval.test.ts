import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InjectedCrash, approveOperation, verifyEventChain, listOperationEvents, type ErrorCode } from "../../src/index.js";
import { loadDemo, loadSecrets } from "../helpers/fixtures.js";
import { makeEnv, rejection, type Env } from "../helpers/kit.js";

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

const expectedCode: Record<string, ErrorCode> = {
  "unknown field": "FIELD_NOT_ALLOWED",
  "deletion via null": "FIELD_VALUE_INVALID",
  "send-style field": "FORBIDDEN_ACTION",
  "nested object": "NON_SCALAR_VALUE",
  "array value": "NON_SCALAR_VALUE",
  "outside connector scope": "RECORD_OUT_OF_SCOPE",
  "empty patch": "VALIDATION_FAILED",
};

describe("AC-01 mutation allowlist (integration, real database and worker)", () => {
  it("an allowlisted patch is planned with a plan hash and a before snapshot, and nothing is written to the provider", async () => {
    const before = env.sim.snapshot("contact-0001");
    const plan = await env.plan({ lifecycle_stage: "customer" });
    expect(plan.plan_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const view = await env.view(plan.id);
    expect(view.state).toBe("planned");
    expect(view.fields).toHaveLength(1);
    expect(view.fields[0]).toMatchObject({ field: "lifecycle_stage", before: "lead", intended: "customer", apply_outcome: "pending" });
    expect(env.sim.calls.write).toBe(0);
    expect(env.sim.snapshot("contact-0001")).toEqual(before);
    expect(await env.count("jobs")).toBe(0);
  });

  it.each(loadDemo().rejected_patches.map((r) => [r.name, r] as const))(
    "rejected before any provider call and any stored state: %s",
    async (name, entry) => {
      const err = await rejection(() => env.plan(entry.patch, { record_ref: entry.record_ref, expected_version: "sim-v1" }));
      expect(err.code).toBe(expectedCode[name]);
      expect(err.status).toBe(422);
      expect(env.sim.calls.read).toBe(0);
      expect(env.sim.calls.write).toBe(0);
      expect(await env.count("operations")).toBe(0);
      expect(await env.count("field_snapshots")).toBe(0);
      expect(await env.count("jobs")).toBe(0);
      expect(await env.count("idempotency_keys")).toBe(0);
    },
  );

  it("a forbidden top-level request key (send or delete) is rejected with its precise code", async () => {
    const body = { connector_id: env.connectorId, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" };
    const { planOperation } = await import("../../src/index.js");
    for (const [extra, code] of [
      [{ delete_record: true }, "DELETION_FORBIDDEN"],
      [{ send_email: "welcome" }, "FORBIDDEN_ACTION"],
      [{ whatever: 1 }, "VALIDATION_FAILED"],
    ] as const) {
      const err = await rejection(() => planOperation(env.kit, env.operator, { ...body, ...extra }, `k-${code}`));
      expect(err.code).toBe(code);
    }
    expect(env.sim.calls.read).toBe(0);
    expect(await env.count("operations")).toBe(0);
  });

  it("a record that does not exist is a clean 422 and creates nothing", async () => {
    const err = await rejection(() => env.plan({ lifecycle_stage: "customer" }, { record_ref: "contact-9999", expected_version: "sim-v1" }));
    expect(err.code).toBe("RECORD_NOT_FOUND");
    expect(await env.count("operations")).toBe(0);
  });

  it("a stale expected_version is a conflict at plan time and creates nothing", async () => {
    env.sim.externalEdit("contact-0001", { owner_label: "someone-else" });
    const err = await rejection(() => env.plan({ lifecycle_stage: "customer" }, { expected_version: "sim-v1" }));
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.status).toBe(409);
    expect(await env.count("operations")).toBe(0);
  });

  it("a patch that changes nothing is rejected rather than stored", async () => {
    const err = await rejection(() => env.plan({ lifecycle_stage: "lead" }));
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(await env.count("operations")).toBe(0);
  });

  it("planted secrets sent as values never appear in the error text", async () => {
    const secret = loadSecrets().needles[0] as string;
    const err = await rejection(() => env.plan({ lifecycle_stage: secret, favorite_color: secret }));
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(secret);
  });

  it("a connector without atomic conditional writes is read-only: planning is refused", async () => {
    const e2 = await makeEnv();
    try {
      const { createConnector, planOperation } = await import("../../src/index.js");
      const ro = await createConnector(e2.kit, e2.admin, {
        kind: "simulator",
        name: "read-only-sim",
        policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
        config: { seed_records: [{ record_ref: "contact-0001", fields: { lifecycle_stage: "lead" } }], supports_atomic_conditional_write: false },
      } as never);
      expect(ro.read_only).toBe(true);
      const err = await rejection(() => planOperation(e2.kit, e2.operator, { connector_id: ro.id, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" }, "k-ro"));
      expect(err.code).toBe("CONNECTOR_READ_ONLY");
      expect(e2.kit.connectors.simulator(ro.id).calls.write).toBe(0);
    } finally {
      await e2.close();
    }
  });
});

describe("AC-02 approval binding (integration)", () => {
  it("before snapshot, approval row and attempt record exist before the first provider write", async () => {
    const seen: Record<string, unknown> = {};
    env.kit.faults.onPoint("apply.before_remote", async (ctx) => {
      const q = env.kit.db;
      seen.state = (await q.query<{ state: string }>("SELECT state FROM operations WHERE id = $1::uuid", [ctx.operation_id])).rows[0]?.state;
      seen.snapshots = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM field_snapshots WHERE operation_id = $1::uuid", [ctx.operation_id])).rows[0]?.n;
      seen.approvals = (await q.query<{ plan_hash: string }>("SELECT plan_hash FROM approvals WHERE operation_id = $1::uuid AND phase = 'apply'", [ctx.operation_id])).rows.map((r) => r.plan_hash);
      seen.started = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM attempts WHERE operation_id = $1::uuid AND outcome = 'started'", [ctx.operation_id])).rows[0]?.n;
      seen.writesSoFar = env.sim.calls.write;
    });
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    expect(seen).toMatchObject({ state: "applying", snapshots: 1, started: 1, writesSoFar: 0 });
    expect(seen.approvals).toEqual([op.plan_hash]);
  });

  it("approving with a different plan hash or version is refused and leaves the operation planned", async () => {
    const plan = await env.plan({ lifecycle_stage: "customer" });
    const other = `sha256:${"0".repeat(64)}`;
    expect((await rejection(() => approveOperation(env.kit, env.operator, plan.id, { plan_hash: other, expected_version: "sim-v1" }))).code).toBe("PLAN_HASH_MISMATCH");
    expect((await rejection(() => approveOperation(env.kit, env.operator, plan.id, { plan_hash: plan.plan_hash, expected_version: "sim-v9" }))).code).toBe("VERSION_CONFLICT");
    expect((await env.view(plan.id)).state).toBe("planned");
    expect(await env.count("approvals")).toBe(0);
    expect(await env.count("jobs")).toBe(0);
  });

  it("approving twice is refused: a plan can only be approved once", async () => {
    const plan = await env.plan({ lifecycle_stage: "customer" });
    await approveOperation(env.kit, env.operator, plan.id, { plan_hash: plan.plan_hash, expected_version: "sim-v1" });
    const err = await rejection(() => approveOperation(env.kit, env.operator, plan.id, { plan_hash: plan.plan_hash, expected_version: "sim-v1" }));
    expect(err.code).toBe("INVALID_STATE");
    expect(await env.count("approvals")).toBe(1);
    expect(await env.count("jobs")).toBe(1);
  });

  it("an approval that expires exactly at the TTL boundary is invalidated with zero writes", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    env.advance(env.kit.config.approvalTtlMs); // now == expires_at, which is already expired
    const ran = await env.worker.runOnce();
    expect(ran?.note).toMatch(/expired/i);
    const view = await env.view(p.id);
    expect(view.state).toBe("planned");
    expect(view.failure?.code).toBe("APPROVAL_EXPIRED");
    expect(env.sim.calls.write).toBe(0);
    expect(env.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("lead");
  });

  it("an approval one millisecond before expiry still applies", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    env.advance(env.kit.config.approvalTtlMs - 1);
    await env.worker.runOnce();
    expect((await env.view(p.id)).state).toBe("applied");
    expect(env.sim.calls.writeApplied).toBe(1);
  });

  it("after an expiry the operation can be approved again with a fresh approval and then applies", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    env.advance(env.kit.config.approvalTtlMs);
    await env.worker.runOnce();
    await approveOperation(env.kit, env.operator, p.id, { plan_hash: p.plan_hash, expected_version: "sim-v1" });
    await env.worker.runOnce();
    expect((await env.view(p.id)).state).toBe("applied");
    expect(await env.count("approvals")).toBe(2);
  });

  it("a plan tampered with after approval invalidates the approval and writes nothing", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    await env.kit.db.query("UPDATE operations SET plan_hash = $2 WHERE id = $1::uuid", [p.id, `sha256:${"a".repeat(64)}`]);
    const ran = await env.worker.runOnce();
    expect(ran?.note).toMatch(/plan changed after approval/i);
    expect(env.sim.calls.write).toBe(0);
    const view = await env.view(p.id);
    expect(view.state).toBe("planned");
    expect(view.failure?.code).toBe("PLAN_HASH_MISMATCH");
    const events = await listOperationEvents(env.kit, env.operator, p.id);
    expect(events.map((e) => e.event_type)).toContain("approval.invalidated");
  });

  it("a tampered stored plan is refused at approval time", async () => {
    const plan = await env.plan({ lifecycle_stage: "customer" });
    await env.kit.db.query("UPDATE operations SET plan_hash = $2 WHERE id = $1::uuid", [plan.id, `sha256:${"b".repeat(64)}`]);
    const err = await rejection(() => approveOperation(env.kit, env.operator, plan.id, { plan_hash: `sha256:${"b".repeat(64)}`, expected_version: "sim-v1" }));
    expect(err.code).toBe("PLAN_HASH_MISMATCH");
    expect(await env.count("jobs")).toBe(0);
  });

  it("approvals, attempts and evidence events are append-only at the database level (no update, no delete)", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    for (const table of ["approvals", "attempts", "evidence_events"]) {
      await expect(env.kit.db.query(`DELETE FROM ${table} WHERE operation_id = $1::uuid`, [op.id]), `DELETE ${table}`).rejects.toThrow(/append-only/);
    }
    await expect(env.kit.db.query("UPDATE approvals SET plan_hash = $2 WHERE operation_id = $1::uuid", [op.id, `sha256:${"d".repeat(64)}`])).rejects.toThrow(/append-only/);
    await expect(env.kit.db.query("UPDATE evidence_events SET payload = '{}'::jsonb WHERE operation_id = $1::uuid", [op.id])).rejects.toThrow(/append-only/);
    await expect(env.kit.db.query("UPDATE attempts SET outcome = 'failed' WHERE operation_id = $1::uuid", [op.id])).rejects.toThrow(/append-only/);
    expect((await env.view(op.id)).approvals).toHaveLength(1);
  });

  it("a successful apply stores before, intended and observed values, a verified read-back and a valid evidence chain", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer", lead_score: 41 });
    const view = await env.view(op.id);
    expect(view.state).toBe("applied");
    expect(view.observed_version).toBe(env.sim.snapshot("contact-0001")?.version);
    expect(view.fields.map((f) => [f.field, f.before, f.intended, f.observed_after, f.apply_outcome])).toEqual([
      ["lead_score", 40, 41, 41, "applied"],
      ["lifecycle_stage", "lead", "customer", "customer", "applied"],
    ]);
    expect(view.attempts.map((a) => a.outcome).sort()).toEqual(["started", "succeeded"]);
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]?.plan_hash).toBe(op.plan_hash);
    const events = await listOperationEvents(env.kit, env.operator, op.id);
    expect(verifyEventChain(op.id, events)).toBeNull();
    expect(events.map((e) => e.event_type)).toEqual(["operation.planned", "operation.approved", "apply.started", "apply.succeeded"]);
    expect(await env.worker.runOnce()).toBeNull();
    expect(env.sim.calls.write).toBe(1);
  });

  it("the evidence chain detects an altered event and a removed event", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const events = await listOperationEvents(env.kit, env.operator, op.id);
    const altered = structuredClone(events);
    altered[1]!.payload = { ...altered[1]!.payload, plan_hash: `sha256:${"c".repeat(64)}` };
    expect(verifyEventChain(op.id, altered)).not.toBeNull();
    expect(verifyEventChain(op.id, [events[0]!, ...events.slice(2)])).not.toBeNull();
    expect(verifyEventChain(op.id, events.slice(0, -1))).toBeNull(); // a prefix is still a valid chain
  });

  it("a crash before the remote call leaves no write; approval is not silently reused", async () => {
    env.kit.faults.crashAt("apply.before_remote");
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    await expect(env.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    expect(env.sim.calls.write).toBe(0);
    expect((await env.view(p.id)).state).toBe("applying");
  });
});
