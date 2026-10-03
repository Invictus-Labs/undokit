import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMember, planOperation, type Actor } from "../../src/index.js";
import { loadDemo } from "../helpers/fixtures.js";
import { makeEnv, newPassword, rejection, type Env } from "../helpers/kit.js";

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

const body = (patch: Record<string, unknown> = { lifecycle_stage: "customer" }, ref = "contact-0001") => ({
  connector_id: env.connectorId,
  record_ref: ref,
  patch,
  expected_version: "sim-v1",
});

describe("AC-06 idempotency", () => {
  it("happy: the same key and the same body return the same operation, flagged as a replay, and create nothing new", async () => {
    const first = await planOperation(env.kit, env.operator, body(), "key-0001");
    const readsAfterFirst = env.sim.calls.read;
    const again = await planOperation(env.kit, env.operator, body(), "key-0001");
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    expect(await env.count("operations")).toBe(1);
    expect(await env.count("field_snapshots")).toBe(1);
    expect(await env.count("idempotency_keys")).toBe(1);
    expect(env.sim.calls.read).toBe(readsAfterFirst); // a replay never touches the provider
  });

  it("the replay returns the ORIGINAL plan response even after the operation moved on (approved, applied)", async () => {
    const first = await planOperation(env.kit, env.operator, body(), "key-0002");
    const { approveOperation } = await import("../../src/index.js");
    await approveOperation(env.kit, env.operator, first.body.id, { plan_hash: first.body.plan_hash, expected_version: "sim-v1" });
    await env.worker.runOnce();
    const again = await planOperation(env.kit, env.operator, body(), "key-0002");
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    expect(await env.count("operations")).toBe(1);
    expect(env.sim.calls.writeApplied).toBe(1);
  });

  it("sad: the same key with a different patch is IDEMPOTENCY_CONFLICT (409) and creates nothing", async () => {
    const f = loadDemo().scenarios;
    await planOperation(env.kit, env.operator, { ...body(f["wrong_field_update"]!.patch), record_ref: f["wrong_field_update"]!.record_ref }, "key-0003");
    const err = await rejection(() => planOperation(env.kit, env.operator, { ...body(f["changed_intent_same_key"]!.patch), record_ref: f["changed_intent_same_key"]!.record_ref }, "key-0003"));
    expect(err.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(err.status).toBe(409);
    expect(await env.count("operations")).toBe(1);
  });

  it("sad: the same key with a different record, connector or expected_version is also a conflict", async () => {
    await planOperation(env.kit, env.operator, body(), "key-0004");
    for (const variant of [body(undefined, "contact-0002"), { ...body(), expected_version: "sim-v7" }]) {
      const err = await rejection(() => planOperation(env.kit, env.operator, variant, "key-0004"));
      expect(err.code).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(await env.count("operations")).toBe(1);
  });

  it("key order inside the patch does not matter: it is the same request", async () => {
    const a = await planOperation(env.kit, env.operator, body({ lifecycle_stage: "customer", lead_score: 41 }), "key-0005");
    const b = await planOperation(env.kit, env.operator, body({ lead_score: 41, lifecycle_stage: "customer" }), "key-0005");
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
  });

  it("a missing or malformed Idempotency-Key is refused with 400 before anything is read or stored", async () => {
    for (const bad of [undefined, "", "x".repeat(256), "has space", "tab\there", "non-ascii-é"]) {
      const err = await rejection(() => planOperation(env.kit, env.operator, body(), bad));
      expect(err.code, JSON.stringify(bad)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect(err.status).toBe(400);
    }
    expect(env.sim.calls.read).toBe(0);
    expect(await env.count("operations")).toBe(0);
    const longest = await planOperation(env.kit, env.operator, body(), "k".repeat(255));
    expect(longest.replayed).toBe(false);
  });

  it("a request that failed validation does not burn its key: the corrected request with the same key succeeds", async () => {
    await rejection(() => planOperation(env.kit, env.operator, body({ favorite_color: "blue" }), "key-0006"));
    expect(await env.count("idempotency_keys")).toBe(0);
    const ok = await planOperation(env.kit, env.operator, body(), "key-0006");
    expect(ok.replayed).toBe(false);
  });

  it("keys are scoped per actor: another operator using the same key gets an independent operation", async () => {
    const second = await createMember(env.kit, env.admin, { email: "operator-2@example.test", password: newPassword(), role: "operator" });
    const operator2: Actor = { user_id: second.user_id, workspace_id: env.admin.workspace_id, role: "operator" };
    const a = await planOperation(env.kit, env.operator, body(), "shared-key");
    const b = await planOperation(env.kit, operator2, body({ lifecycle_stage: "churned" }), "shared-key");
    expect(b.replayed).toBe(false);
    expect(b.body.id).not.toBe(a.body.id);
    expect(await env.count("operations")).toBe(2);
  });

  it("two simultaneous identical requests produce exactly one operation, and both callers get the same id", async () => {
    const [a, b] = await Promise.all([planOperation(env.kit, env.operator, body(), "key-race"), planOperation(env.kit, env.operator, body(), "key-race")]);
    expect(a.body.id).toBe(b.body.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await env.count("operations")).toBe(1);
  });

  it("two simultaneous requests with the same key but different bodies: one wins, the other is a conflict", async () => {
    const settled = await Promise.allSettled([
      planOperation(env.kit, env.operator, body({ lifecycle_stage: "customer" }), "key-race2"),
      planOperation(env.kit, env.operator, body({ lifecycle_stage: "churned" }), "key-race2"),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await env.count("operations")).toBe(1);
  });

  it("retention: a key is honoured for at least seven days, then it may be reused for a new operation", async () => {
    const first = await planOperation(env.kit, env.operator, body(), "key-retain");
    env.advance(7 * 24 * 60 * 60 * 1000 - 1);
    expect((await planOperation(env.kit, env.operator, body(), "key-retain")).replayed).toBe(true);
    env.advance(1);
    const later = await planOperation(env.kit, env.operator, body(), "key-retain");
    expect(later.replayed).toBe(false);
    expect(later.body.id).not.toBe(first.body.id);
  });

  it("a plan-time failure after the key check (record changed) leaves the key unused", async () => {
    env.sim.externalEdit("contact-0001", { owner_label: "x" });
    await rejection(() => planOperation(env.kit, env.operator, body(), "key-stale"));
    expect(await env.count("idempotency_keys")).toBe(0);
  });
});
