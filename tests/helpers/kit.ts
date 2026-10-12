// Integration harness (QA-owned): real PGlite database, real services, real worker, simulator connector.
// Time and ids are deterministic. Passwords are generated per run, never committed.
import { randomBytes } from "node:crypto";
import {
  AppError,
  FixedClock,
  KeyRing,
  SequentialIds,
  approveOperation,
  createCompensationPlan,
  compensateOperation,
  createConnector,
  createMember,
  createUndoKit,
  createWorker,
  createWorkspaceWithAdmin,
  getOperation,
  planOperation,
  requestReconcile,
  type Actor,
  type OperationView,
  type SimulatorConnector,
  type UndoKit,
  type UndoKitOptions,
  type Worker,
} from "../../src/index.js";
import { FIXED_NOW_ISO, loadDemo } from "./fixtures.js";
import { demoPolicy, type TestPolicy } from "./policy.js";

export const newPassword = (): string => randomBytes(15).toString("base64url");

export interface EnvOptions {
  config?: UndoKitOptions["config"];
  /** Field names to mark sensitive in the connector policy. */
  sensitiveFields?: string[];
  /** Override the policy entirely. */
  policy?: TestPolicy;
  keyText?: string;
}

export interface Env {
  kit: UndoKit;
  clock: FixedClock;
  worker: Worker;
  sim: SimulatorConnector;
  connectorId: string;
  admin: Actor;
  operator: Actor;
  viewer: Actor;
  adminB: Actor;
  operatorB: Actor;
  passwords: Record<"admin" | "operator" | "viewer" | "adminB" | "operatorB", string>;
  emails: Record<"admin" | "operator" | "viewer" | "adminB" | "operatorB", string>;
  keyText: string;
  /** Plan a patch against the record's current provider version. */
  plan(patch: Record<string, unknown>, opts?: { record_ref?: string; key?: string; actor?: Actor; expected_version?: string }): Promise<{ id: string; plan_hash: string }>;
  /** Plan then approve; returns ids. Does not run the worker. */
  planAndApprove(patch: Record<string, unknown>, opts?: { record_ref?: string; key?: string }): Promise<{ id: string; plan_hash: string; job_id: string }>;
  /** Plan, approve and run exactly one worker job. */
  applyOnce(patch: Record<string, unknown>, opts?: { record_ref?: string }): Promise<{ id: string; plan_hash: string }>;
  /** Plan a compensation, approve it, run exactly one worker job. */
  compensateOnce(opId: string): Promise<{ compensation_id: string }>;
  view(opId: string, actor?: Actor): Promise<OperationView>;
  count(table: string): Promise<number>;
  advance(ms: number): void;
  close(): Promise<void>;
}

let keySeq = 0;

export async function makeEnv(opts: EnvOptions = {}): Promise<Env> {
  const demo = loadDemo();
  const clock = new FixedClock(FIXED_NOW_ISO);
  const keyText = opts.keyText ?? KeyRing.generateKeyText();
  keySeq += 1;
  const kit = await createUndoKit({
    databaseUrl: "memory://",
    keyring: KeyRing.fromBase64(keyText),
    clock,
    ids: new SequentialIds("aaaaaaaa"),
    ...(opts.config ? { config: opts.config } : {}),
  });
  if (!kit.readiness.ok) throw new Error(`test kit not ready: ${kit.readiness.error ?? "unknown"} (#${keySeq})`);

  const passwords = { admin: newPassword(), operator: newPassword(), viewer: newPassword(), adminB: newPassword(), operatorB: newPassword() };
  const emails = {
    admin: "admin-a@example.test",
    operator: "operator-a@example.test",
    viewer: "viewer-a@example.test",
    adminB: "admin-b@example.test",
    operatorB: "operator-b@example.test",
  };
  const [wsA, wsB] = demo.workspaces;
  const a = await createWorkspaceWithAdmin(kit, { email: emails.admin, password: passwords.admin, workspace_name: wsA!.name });
  const b = await createWorkspaceWithAdmin(kit, { email: emails.adminB, password: passwords.adminB, workspace_name: wsB!.name });
  const admin: Actor = { user_id: a.user_id, workspace_id: a.workspace_id, role: "admin" };
  const adminB: Actor = { user_id: b.user_id, workspace_id: b.workspace_id, role: "admin" };
  const op = await createMember(kit, admin, { email: emails.operator, password: passwords.operator, role: "operator" });
  const vw = await createMember(kit, admin, { email: emails.viewer, password: passwords.viewer, role: "viewer" });
  const opB = await createMember(kit, adminB, { email: emails.operatorB, password: passwords.operatorB, role: "operator" });
  const operator: Actor = { user_id: op.user_id, workspace_id: a.workspace_id, role: "operator" };
  const viewer: Actor = { user_id: vw.user_id, workspace_id: a.workspace_id, role: "viewer" };
  const operatorB: Actor = { user_id: opB.user_id, workspace_id: b.workspace_id, role: "operator" };

  const basePolicy = opts.policy ?? demoPolicy();
  const policy: TestPolicy = {
    ...basePolicy,
    allowed_fields: basePolicy.allowed_fields.map((f) => ({ ...f, sensitive: opts.sensitiveFields?.includes(f.name) ?? f.sensitive })),
  };
  const connector = await createConnector(kit, admin, {
    kind: "simulator",
    name: demo.connector.name,
    policy,
    config: { seed_records: demo.records.map((r) => ({ record_ref: r.record_ref, fields: r.fields })) },
  });
  const sim = kit.connectors.simulator(connector.id);
  const worker = createWorker(kit, { workerId: "qa-worker" });

  const versionOf = (ref: string): string => {
    const snap = sim.snapshot(ref);
    if (!snap) throw new Error(`no such record in simulator: ${ref}`);
    return snap.version;
  };

  const env: Env = {
    kit,
    clock,
    worker,
    sim,
    connectorId: connector.id,
    admin,
    operator,
    viewer,
    adminB,
    operatorB,
    passwords,
    emails,
    keyText,
    async plan(patch, o = {}) {
      const ref = o.record_ref ?? "contact-0001";
      const res = await planOperation(
        kit,
        o.actor ?? operator,
        { connector_id: connector.id, record_ref: ref, patch, expected_version: o.expected_version ?? versionOf(ref) },
        o.key ?? `key-${kit.ids.next()}`,
      );
      return { id: res.body.id, plan_hash: res.body.plan_hash };
    },
    async planAndApprove(patch, o = {}) {
      const ref = o.record_ref ?? "contact-0001";
      const planned = await env.plan(patch, { record_ref: ref, ...(o.key ? { key: o.key } : {}) });
      const approved = await approveOperation(kit, operator, planned.id, { plan_hash: planned.plan_hash, expected_version: versionOf(ref) });
      return { ...planned, job_id: approved.job_id };
    },
    async applyOnce(patch, o = {}) {
      const p = await env.planAndApprove(patch, o);
      const ran = await worker.runOnce();
      if (!ran) throw new Error("worker found no job");
      return { id: p.id, plan_hash: p.plan_hash };
    },
    async compensateOnce(opId) {
      const plan = await createCompensationPlan(kit, operator, opId);
      if (plan.state !== "planned") throw new AppError("COMPENSATION_BLOCKED", `compensation plan is ${plan.state}`);
      const approved = await compensateOperation(kit, operator, opId, { plan_hash: plan.plan_hash });
      await worker.runOnce();
      return { compensation_id: approved.compensation_id };
    },
    view: (opId, actor = operator) => getOperation(kit, actor, opId),
    async count(table) {
      const res = await kit.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      return res.rows[0]?.n ?? 0;
    },
    advance: (ms) => clock.advance(ms),
    close: () => kit.close(),
  };
  return env;
}

export { requestReconcile };

/** Run `fn` and return the AppError it throws (fails the test if it does not throw one). */
export async function rejection(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError but the call succeeded");
}

export const ONE_MINUTE = 60_000;
