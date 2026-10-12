// Admin resolution of an UNKNOWN operation or compensation that reconciliation cannot settle (POST /api/v1/operations/{id}/resolve,
// review P2-1a). It records an operator-attributed attempt and evidence, moves the target to failed OPERATOR_RESOLVED, releases the
// one-unresolved-change-per-record guard, and NEVER calls the provider. A late WRITTEN result still reopens it (LATE_RESULT).
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compensateOperation, createCompensationPlan, createWorker, buildServer, listCompensations, listOperationEvents, requestReconcile, type ConnectorRecord, type CrmConnector, type Scalar, type SimulatorConnector, type WriteResult } from "../../src/index.js";
import { quietPeriodMs } from "../../src/config.js";
import { login, type Client } from "../helpers/http.js";
import { makeEnv, type Env } from "../helpers/kit.js";

let env: Env;
let app: FastifyInstance;
let admin: Client;
let operator: Client;
let viewer: Client;
let adminB: Client;
const REF = "contact-0002";
const SECRET = "token-FAKEUNDOKIT0123456789abcdef";

async function must(email: string, password: string): Promise<Client> {
  const r = await login(app, email, password);
  if (!r.client) throw new Error(`login failed for ${email}: ${r.reply.status}`);
  return r.client;
}
beforeEach(async () => {
  env = await makeEnv();
  app = await buildServer(env.kit);
  admin = await must(env.emails.admin, env.passwords.admin);
  operator = await must(env.emails.operator, env.passwords.operator);
  viewer = await must(env.emails.viewer, env.passwords.viewer);
  adminB = await must(env.emails.adminB, env.passwords.adminB);
}, 120_000);
afterEach(async () => {
  await app.close();
  await env.close();
});

const resolveUrl = (id: string) => `/api/v1/operations/${id}/resolve`;
const body = (over: Record<string, unknown> = {}) => ({ outcome: "not_applied", reason: "checked the provider by hand: the record is unchanged", ...over });

/** An operation that stays UNKNOWN: the request was lost and the record is untouched. */
async function lostOperation(): Promise<string> {
  env.sim.failNextWrite("ambiguous_before_commit");
  const op = await env.applyOnce({ lifecycle_stage: "customer" }, { record_ref: REF });
  expect((await env.view(op.id)).state).toBe("unknown");
  return op.id;
}
const lastReconcileCode = async (id: string) => (await env.view(id)).attempts.filter((a) => a.phase === "reconcile").at(-1)?.error_code;

/**
 * An UNKNOWN operation that read-only reconciliation really cannot settle: someone else set the record to a third value, so it matches
 * neither the before nor the intended state (STATE_AMBIGUOUS). Only then is resolving by hand allowed.
 */
async function unknownOperation(): Promise<string> {
  const id = await lostOperation();
  env.sim.externalEdit(REF, { lifecycle_stage: "churned" });
  await requestReconcile(env.kit, env.operator, id);
  await env.worker.drain();
  expect(await lastReconcileCode(id)).toBe("STATE_AMBIGUOUS");
  expect((await env.view(id)).state).toBe("unknown");
  return id;
}

describe("POST /operations/{id}/resolve: an admin closes an UNKNOWN operation without touching the provider", () => {
  it("admin 200: the operation is failed OPERATOR_RESOLVED, attributed in an attempt and an evidence event, the provider is not called, and the record is plannable again", async () => {
    const id = await unknownOperation();
    const calls = { ...env.sim.calls };
    const blocked = await operator.post("/api/v1/operations", { connector_id: env.connectorId, record_ref: REF, patch: { lead_score: 3 }, expected_version: env.sim.snapshot(REF)!.version }, { headers: { "idempotency-key": "resolve-blocked" } });
    expect(blocked.status, "the guard blocks the record while it is unresolved").toBe(409);

    const res = await admin.post(resolveUrl(id), body());
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id, target: "operation", compensation_id: null, state: "failed", outcome: "not_applied", failure_code: "OPERATOR_RESOLVED" });
    expect(res.body.resolved_by).toBeTruthy();
    expect(env.sim.calls, "the provider was never consulted or written").toEqual(calls);

    const view = await env.view(id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("OPERATOR_RESOLVED");
    expect(view.fields[0]?.apply_outcome).toBe("not_applied");
    const attempt = view.attempts.at(-1)!;
    expect(attempt).toMatchObject({ phase: "reconcile", outcome: "failed", error_code: "OPERATOR_RESOLVED" });
    expect(attempt.detail).toMatchObject({ operator: true, resolution: "not_applied" });
    const events = await listOperationEvents(env.kit, env.operator, id);
    expect(events.map((e) => e.event_type)).toContain("apply.operator_resolved");

    const planned = await operator.post("/api/v1/operations", { connector_id: env.connectorId, record_ref: REF, patch: { lead_score: 3 }, expected_version: env.sim.snapshot(REF)!.version }, { headers: { "idempotency-key": "resolve-after" } });
    expect(planned.status, "the guard is released").toBe(201);
  }, 60_000);

  it("only an admin may resolve (operator and viewer get 403), another workspace gets 404, and a state with nothing unknown gets 409; none of these change anything", async () => {
    const id = await unknownOperation();
    for (const [name, client] of [["operator", operator], ["viewer", viewer]] as const) {
      expect((await client.post(resolveUrl(id), body())).status, name).toBe(403);
    }
    expect((await adminB.post(resolveUrl(id), body())).status).toBe(404);
    expect((await env.view(id)).state).toBe("unknown");

    const applied = await env.applyOnce({ lead_score: 7 }, { record_ref: "contact-0001" });
    const wrong = await admin.post(resolveUrl(applied.id), body());
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("INVALID_STATE");
    expect((await env.view(applied.id)).state).toBe("applied");
  }, 60_000);

  it("it is refused until a reconcile run has actually failed to settle it: no reconcile, a deferred (quiet period) reconcile and an unreadable provider are all 409 INVALID_STATE", async () => {
    const id = await lostOperation();
    const none = await admin.post(resolveUrl(id), body());
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("INVALID_STATE");
    expect(none.body.error.message).toMatch(/reconcile/i);

    await requestReconcile(env.kit, env.operator, id);
    await env.worker.drain(); // untouched record: inside the quiet period, so it is deferred
    expect(await lastReconcileCode(id)).toBe("QUIET_PERIOD");
    expect((await admin.post(resolveUrl(id), body())).status).toBe(409);

    env.advance(quietPeriodMs(env.kit.config));
    class Unreadable implements CrmConnector {
      kind = "simulator" as const;
      live = false;
      label = "unreadable";
      supportsAtomicConditionalWrite = true;
      async read(): Promise<ConnectorRecord | null> {
        throw new (await import("../../src/index.js")).ConnectorUnavailableError("provider down");
      }
      async ping(): Promise<void> {}
      async conditionalWrite(): Promise<WriteResult> {
        throw new Error("never written");
      }
    }
    env.kit.connectors.register(env.connectorId, new Unreadable());
    await requestReconcile(env.kit, env.operator, id);
    await env.worker.drain();
    expect(await lastReconcileCode(id)).toBe("CONNECTOR_UNAVAILABLE");
    const unreadable = await admin.post(resolveUrl(id), body());
    expect(unreadable.status).toBe(409);
    expect((await env.view(id)).state).toBe("unknown");
  }, 60_000);

  it("a write that really landed (provider committed, response lost) cannot be closed as 'not applied': resolve is refused with the value changed, and reconciliation resolves it to applied", async () => {
    env.sim.failNextWrite("ambiguous_after_commit");
    const op = await env.applyOnce({ lifecycle_stage: "customer" }, { record_ref: REF });
    expect((await env.view(op.id)).state).toBe("unknown");
    expect(env.sim.snapshot(REF)?.fields["lifecycle_stage"], "the provider did commit").toBe("customer");
    const calls = { ...env.sim.calls };
    const early = await admin.post(resolveUrl(op.id), body());
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("INVALID_STATE");
    expect((await env.view(op.id)).state, "still UNKNOWN, nothing claimed").toBe("unknown");
    expect(env.sim.calls).toEqual(calls);

    await requestReconcile(env.kit, env.operator, op.id);
    await env.worker.drain();
    expect((await env.view(op.id)).state).toBe("applied"); // the truth, from reading the provider
    expect((await admin.post(resolveUrl(op.id), body())).status, "nothing left to resolve").toBe(409);
    expect(env.sim.calls.write).toBe(1);
  }, 60_000);

  it("the body is strict: a missing or empty reason, an unknown field and the outcome 'applied' (that is reconcile's job) are refused; an expected_version mismatch is a conflict", async () => {
    const id = await unknownOperation();
    for (const bad of [{ outcome: "not_applied" }, body({ reason: "   " }), body({ extra: true }), body({ outcome: "applied" }), body({ outcome: "reverted" })]) {
      const r = await admin.post(resolveUrl(id), bad);
      expect([400, 422], JSON.stringify(bad)).toContain(r.status);
    }
    const stale = await admin.post(resolveUrl(id), body({ expected_version: "sim-v999" }));
    expect(stale.status).toBe(409);
    expect((await env.view(id)).state).toBe("unknown");
  }, 60_000);

  it("the reason is stored redacted: a planted secret in it never reaches the attempt or the evidence", async () => {
    const id = await unknownOperation();
    const res = await admin.post(resolveUrl(id), body({ reason: `verified with ${SECRET} in the console` }));
    expect(res.status).toBe(200);
    const view = await env.view(id);
    const events = await listOperationEvents(env.kit, env.operator, id);
    expect(JSON.stringify(view)).not.toContain("FAKEUNDOKIT");
    expect(JSON.stringify(events)).not.toContain("FAKEUNDOKIT");
  }, 60_000);

  it("an UNKNOWN compensation is resolved the same way (target 'compensation'); the operation stays applied", async () => {
    const applied = await env.applyOnce({ lifecycle_stage: "customer" }, { record_ref: REF });
    const plan = await createCompensationPlan(env.kit, env.operator, applied.id);
    const approved = await compensateOperation(env.kit, env.operator, applied.id, { plan_hash: plan.plan_hash });
    env.sim.failNextWrite("ambiguous_before_commit");
    await env.worker.runOnce();
    expect((await listCompensations(env.kit, env.operator, applied.id))[0]?.state).toBe("unknown");
    env.sim.externalEdit(REF, { lifecycle_stage: "churned" }); // a third value: reconciliation cannot settle it
    await requestReconcile(env.kit, env.operator, applied.id);
    await env.worker.drain();
    expect((await env.view(applied.id)).attempts.filter((a) => a.phase === "reconcile").at(-1)?.error_code).toBe("STATE_AMBIGUOUS");
    expect((await listCompensations(env.kit, env.operator, applied.id))[0]?.state).toBe("unknown");
    const writes = env.sim.calls.write;
    const res = await admin.post(resolveUrl(applied.id), body());
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ target: "compensation", compensation_id: approved.compensation_id, state: "failed", failure_code: "OPERATOR_RESOLVED" });
    const comp = (await listCompensations(env.kit, env.operator, applied.id))[0]!;
    expect(comp.state).toBe("failed");
    expect(comp.failure?.code).toBe("OPERATOR_RESOLVED");
    expect((await env.view(applied.id)).state).toBe("applied");
    expect(env.sim.calls.write).toBe(writes);
  }, 60_000);
});

/** The simulator behind a gate: the write is held in flight until released. */
class Gated implements CrmConnector {
  kind = "simulator" as const;
  live = false;
  label = "gated simulator wrapper";
  supportsAtomicConditionalWrite = true;
  private release!: () => void;
  private entered!: () => void;
  readonly inFlight = new Promise<void>((r) => (this.entered = r));
  private readonly gate = new Promise<void>((r) => (this.release = r));
  hidden = false; // a record that reads as missing (the provider cannot find it): reconciliation ends RECORD_MISSING
  constructor(readonly sim: SimulatorConnector) {}
  read(ref: string): Promise<ConnectorRecord | null> {
    return this.hidden ? Promise.resolve(null) : this.sim.read(ref);
  }
  async ping(): Promise<void> {}
  async conditionalWrite(ref: string, patch: Readonly<Record<string, Scalar>>, version: string, ctx: { requestId: string }): Promise<WriteResult> {
    this.entered();
    await this.gate;
    return this.sim.conditionalWrite(ref, patch, version, ctx);
  }
  land(): void {
    this.release();
  }
}

describe("an operator resolution is never final against a late write", () => {
  it("a write still in flight when an admin resolves the operation lands later: it reopens to UNKNOWN (LATE_RESULT) and reconciliation makes it APPLIED with one write", async () => {
    const gated = new Gated(env.sim);
    env.kit.connectors.register(env.connectorId, gated);
    const p = await env.planAndApprove({ lifecycle_stage: "customer" }, { record_ref: REF });
    const stalled = createWorker(env.kit, { workerId: "stalled", heartbeatMs: 0 });
    const run = stalled.runOnce();
    await gated.inFlight;
    const other = createWorker(env.kit, { workerId: "other" });
    env.advance(env.kit.config.leaseMs + 1);
    await other.drain(); // reclaimed: UNKNOWN, reconcile deferred
    expect((await env.view(p.id)).state).toBe("unknown");
    gated.hidden = true; // the provider cannot find the record right now
    env.advance(quietPeriodMs(env.kit.config));
    await other.drain();
    expect(await lastReconcileCode(p.id)).toBe("RECORD_MISSING");
    gated.hidden = false;

    const res = await admin.post(resolveUrl(p.id), body({ reason: "the provider shows no change yet" }));
    expect(res.status, res.text).toBe(200);
    expect((await env.view(p.id)).failure?.code).toBe("OPERATOR_RESOLVED");
    expect(env.sim.calls.writeApplied).toBe(0);

    gated.land();
    await run;
    expect(env.sim.calls.writeApplied).toBe(1);
    const reopened = await env.view(p.id);
    expect(reopened.state, "the operator's 'not applied' is not final").toBe("unknown");
    expect(reopened.failure?.code).toBe("LATE_RESULT");

    env.advance(quietPeriodMs(env.kit.config));
    await env.worker.drain();
    await other.drain();
    expect((await env.view(p.id)).state).toBe("applied");
    expect(env.sim.calls.write, "exactly one write, ever").toBe(1);
  }, 60_000);
});
