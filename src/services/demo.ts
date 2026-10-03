import { randomBytes } from "node:crypto";
import { createUndoKit } from "../context.js";
import { FixedClock, SequentialIds } from "../domain/clock.js";
import { AppError } from "../domain/errors.js";
import { exportBundle, verifyBundleText } from "../evidence/bundle.js";
import { KeyRing } from "../evidence/crypto.js";
import { createWorkspaceWithAdmin } from "./auth.js";
import { createConnector } from "./connectors.js";
import type { Actor } from "./common.js";
import { approveOperation, compensateOperation, createCompensationPlan, getOperation, planOperation, requestReconcile } from "./operations.js";
import { createWorker } from "../workers/worker.js";
import type { EvidenceBundle, OperationView } from "../domain/types.js";
import { SIMULATOR_LABEL } from "../connectors/simulator.js";

export interface DemoStep {
  step: string;
  outcome: string;
  detail: string;
}

export interface DemoScenario {
  id: string;
  title: string;
  steps: DemoStep[];
  operation_id: string | null;
}

export interface DemoCheck {
  name: string;
  pass: boolean;
}

export interface DemoReport {
  schema_version: 1;
  kind: "undokit-demo";
  /** The demo only ever runs against the in-process simulator; nothing here is a live provider. */
  mode: "synthetic-simulator";
  live: false;
  label: string;
  started_at: string;
  scenarios: DemoScenario[];
  checks: DemoCheck[];
  /** Operations after the run, as an operator would see them (synthetic data only). */
  operations: OperationView[];
  bundle: { bundle_id: string; bundle_hash: string; file_count: number; verified: boolean };
  /** The evidence bundle itself, so the caller can write evidence.json and re-verify offline. */
  evidence: EvidenceBundle;
  all_passed: boolean;
}

export interface DemoOptions {
  /** Fixed start time keeps the report byte-identical across runs. */
  startedAt?: string;
}


const POLICY = {
  allowed_fields: [
    { name: "lifecycle_stage", type: "string" as const, max_length: 32, nullable: false, sensitive: false, enum: ["lead", "customer", "churned", "partner"] },
    { name: "lead_score", type: "number" as const, max_length: 1024, nullable: false, sensitive: false },
    { name: "owner_label", type: "string" as const, max_length: 64, nullable: true, sensitive: false },
  ],
  record_prefixes: ["contact-"],
};

/**
 * Deterministic, offline demo on synthetic data: a reversible change, an intervening edit that blocks
 * compensation, rejected unsafe intents, and a lost provider response resolved by read-only
 * reconciliation. Same inputs always produce the same report and evidence bundle.
 */
export async function runDemo(opts: DemoOptions = {}): Promise<DemoReport> {
  const startedAt = opts.startedAt ?? "2026-01-15T12:00:00.000Z";
  const clock = new FixedClock(startedAt);
  const kit = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()), clock, ids: new SequentialIds("d3000000") });
  try {
    if (!kit.readiness.ok) throw new Error(`demo database not ready: ${kit.readiness.error ?? "unknown"}`);
    const { workspace_id, user_id } = await createWorkspaceWithAdmin(kit, { email: "demo-admin@example.test", password: randomBytes(18).toString("base64url"), workspace_name: "Synthetic Agency" });
    const admin: Actor = { user_id, workspace_id, role: "admin" };
    const connector = await createConnector(kit, admin, {
      kind: "simulator",
      name: "synthetic-crm",
      policy: POLICY,
      config: {
        seed_records: [
          { record_ref: "contact-0001", fields: { lifecycle_stage: "lead", lead_score: 40, owner_label: "team-red" } },
          { record_ref: "contact-0002", fields: { lifecycle_stage: "lead", lead_score: 55, owner_label: "team-blue" } },
          { record_ref: "contact-0003", fields: { lifecycle_stage: "lead", lead_score: 70, owner_label: "team-red" } },
        ],
      },
    });
    const sim = kit.connectors.simulator(connector.id);
    const worker = createWorker(kit, { workerId: "demo-worker" });
    const tick = (): void => clock.advance(1000);
    const scenarios: DemoScenario[] = [];
    const checks: DemoCheck[] = [];
    const check = (name: string, pass: boolean): void => {
      checks.push({ name, pass });
    };
    const version = (ref: string): string => sim.snapshot(ref)?.version ?? "";
    const fieldsOf = (ref: string): Record<string, unknown> => sim.snapshot(ref)?.fields ?? {};

    const plan = async (ref: string, patch: Record<string, unknown>, key: string) => {
      tick();
      return planOperation(kit, admin, { connector_id: connector.id, record_ref: ref, patch, expected_version: version(ref) }, key);
    };
    const approve = async (id: string, planHash: string, expected: string) => {
      tick();
      return approveOperation(kit, admin, id, { plan_hash: planHash, expected_version: expected });
    };

    /* ---- 1. reversible change ---- */
    {
      const steps: DemoStep[] = [];
      const ref = "contact-0001";
      const before = version(ref);
      const p = await plan(ref, { lifecycle_stage: "customer" }, "demo-1-plan");
      steps.push({ step: "plan", outcome: "planned", detail: `lifecycle_stage lead -> customer on ${ref}; plan_hash ${p.body.plan_hash.slice(0, 19)}...` });
      await approve(p.body.id, p.body.plan_hash, before);
      await worker.drain();
      let view = await getOperation(kit, admin, p.body.id);
      steps.push({ step: "approve + apply", outcome: view.state, detail: `provider version ${before} -> ${view.observed_version ?? "?"}; field outcome ${view.fields[0]?.apply_outcome ?? "?"}` });
      check("apply recorded exactly one provider write", sim.calls.writeApplied === 1 && view.state === "applied");
      tick();
      const cp = await createCompensationPlan(kit, admin, p.body.id);
      steps.push({ step: "compensation plan", outcome: cp.state, detail: `${cp.conflicts.length} conflicts; restore lifecycle_stage to lead` });
      tick();
      await compensateOperation(kit, admin, p.body.id, { plan_hash: cp.plan_hash });
      await worker.drain();
      view = await getOperation(kit, admin, p.body.id);
      steps.push({ step: "compensate", outcome: view.compensations[0]?.state ?? "?", detail: `record lifecycle_stage is now ${String(fieldsOf(ref)["lifecycle_stage"])}` });
      check("compensation restored the original value", fieldsOf(ref)["lifecycle_stage"] === "lead" && view.compensations[0]?.state === "compensated");
      scenarios.push({ id: "reversible-change", title: "A wrong change is applied and then reversed with approval", steps, operation_id: p.body.id });
    }

    /* ---- 2. intervening edit blocks compensation ---- */
    {
      const steps: DemoStep[] = [];
      const ref = "contact-0002";
      const before = version(ref);
      const p = await plan(ref, { lifecycle_stage: "customer" }, "demo-2-plan");
      await approve(p.body.id, p.body.plan_hash, before);
      await worker.drain();
      steps.push({ step: "apply", outcome: "applied", detail: `lifecycle_stage lead -> customer on ${ref}` });
      sim.externalEdit(ref, { lead_score: 99 });
      steps.push({ step: "intervening edit", outcome: "recorded", detail: "someone else sets lead_score to 99 after the apply" });
      tick();
      const cp = await createCompensationPlan(kit, admin, p.body.id);
      steps.push({ step: "compensation plan", outcome: cp.state, detail: `blocked: ${cp.conflicts.map((c) => c.code).join(", ")}` });
      let blocked = "";
      try {
        tick();
        await compensateOperation(kit, admin, p.body.id, { plan_hash: cp.plan_hash });
      } catch (err) {
        blocked = err instanceof AppError ? err.code : "ERROR";
      }
      steps.push({ step: "compensate", outcome: blocked, detail: "nothing was written; the later edit is preserved" });
      check("compensation blocked and the intervening edit survived", blocked === "COMPENSATION_BLOCKED" && fieldsOf(ref)["lead_score"] === 99 && fieldsOf(ref)["lifecycle_stage"] === "customer");
      scenarios.push({ id: "intervening-edit", title: "A later edit blocks the undo instead of being overwritten", steps, operation_id: p.body.id });
    }

    /* ---- 3. rejected intents ---- */
    {
      const steps: DemoStep[] = [];
      const writesBefore = sim.calls.write;
      const cases: [string, string, Record<string, unknown>, string][] = [
        ["unknown field", "contact-0003", { favorite_color: "blue" }, "FIELD_NOT_ALLOWED"],
        ["send-style action", "contact-0003", { send_email: "welcome" }, "FORBIDDEN_ACTION"],
        ["deletion", "contact-0003", { deleted: true }, "DELETION_FORBIDDEN"],
        ["nested value", "contact-0003", { lifecycle_stage: { value: "customer" } }, "NON_SCALAR_VALUE"],
        ["record outside scope", "outside-0001", { lifecycle_stage: "customer" }, "RECORD_OUT_OF_SCOPE"],
      ];
      let allRejected = true;
      let index = 0;
      for (const [label, ref, patch, expected] of cases) {
        index += 1;
        let code = "ACCEPTED";
        try {
          tick();
          await planOperation(kit, admin, { connector_id: connector.id, record_ref: ref, patch, expected_version: "v1" }, `demo-3-${index}`);
        } catch (err) {
          code = err instanceof AppError ? err.code : "ERROR";
        }
        if (code !== expected) allRejected = false;
        steps.push({ step: label, outcome: code, detail: `rejected before any provider write (expected ${expected})` });
      }
      check("every unsafe intent was rejected without a provider write", allRejected && sim.calls.write === writesBefore);
      scenarios.push({ id: "rejected-intents", title: "Unsafe or out-of-scope intents are rejected before any write", steps, operation_id: null });
    }

    /* ---- 4. lost response, reconciled read-only ---- */
    {
      const steps: DemoStep[] = [];
      const ref = "contact-0003";
      const before = version(ref);
      const writesBefore = sim.calls.writeApplied;
      sim.failNextWrite("ambiguous_after_commit");
      const p = await plan(ref, { lifecycle_stage: "partner" }, "demo-4-plan");
      await approve(p.body.id, p.body.plan_hash, before);
      await worker.drain();
      let view = await getOperation(kit, admin, p.body.id);
      steps.push({ step: "apply (response lost)", outcome: view.state, detail: "the provider committed but the response never arrived; the outcome is unknown" });
      check("lost response left the operation UNKNOWN, with no retry", view.state === "unknown" && sim.calls.writeApplied === writesBefore + 1);
      tick();
      await requestReconcile(kit, admin, p.body.id);
      await worker.drain();
      view = await getOperation(kit, admin, p.body.id);
      steps.push({ step: "reconcile (read-only)", outcome: view.state, detail: "observed values and version show the write landed; no second write was sent" });
      check("reconciliation resolved to applied with exactly one provider write", view.state === "applied" && sim.calls.writeApplied === writesBefore + 1);
      scenarios.push({ id: "lost-response", title: "A lost response is reconciled by reading, never by re-sending", steps, operation_id: p.body.id });
    }

    /* ---- evidence ---- */
    tick();
    const evidence = await exportBundle(kit, admin, {});
    let verified = false;
    try {
      verifyBundleText(JSON.stringify(evidence));
      verified = true;
    } catch {
      verified = false;
    }
    check("exported evidence bundle verifies", verified);
    const operations: OperationView[] = [];
    for (const s of scenarios) if (s.operation_id) operations.push(await getOperation(kit, admin, s.operation_id));
    return {
      schema_version: 1,
      kind: "undokit-demo",
      mode: "synthetic-simulator",
      live: false,
      label: SIMULATOR_LABEL,
      started_at: startedAt,
      scenarios,
      checks,
      operations,
      bundle: { bundle_id: evidence.bundle_id, bundle_hash: evidence.bundle_hash, file_count: evidence.manifest.file_count, verified },
      evidence,
      all_passed: checks.every((c) => c.pass),
    };
  } finally {
    await kit.close();
  }
}
