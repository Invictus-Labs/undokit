import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FixedClock,
  InjectedCrash,
  KeyRing,
  SequentialIds,
  backupDatabase,
  buildServer,
  checkSchema,
  contentHash,
  createCompensationPlan,
  compensateOperation,
  createUndoKit,
  createWorker,
  defaultMigrationsDir,
  listCompensations,
  listOperationEvents,
  openDatabase,
  requestReconcile,
  restoreDatabase,
  runMigrations,
  verifyEventChain,
  getOperation,
  type Scalar,
  type UndoKit,
} from "../../src/index.js";
import { quietPeriodMs } from "../../src/config.js";
import { FIXED_NOW_ISO } from "../helpers/fixtures.js";
import { makeEnv, rejection, type Env } from "../helpers/kit.js";

let env: Env;
const scratch: string[] = [];
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REF = "contact-0001";
const fieldsOf = () => env.sim.snapshot(REF)?.fields as Record<string, Scalar>;
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "undokit-qa-"));
  scratch.push(d);
  return d;
};
const jobStates = async () => (await env.kit.db.query<{ kind: string; state: string }>("SELECT kind, state FROM jobs ORDER BY created_at, id")).rows.map((r) => `${r.kind}:${r.state}`);

describe("AC-13 worker restart reclaims leased jobs without discarding uncertain outcomes", () => {
  it("crash AFTER the remote write: the lease is not reclaimable early, then recovers as UNKNOWN and reconciles to applied with exactly one write", async () => {
    env.kit.faults.crashAt("apply.after_remote_success");
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    await expect(env.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    expect((await env.view(p.id)).state).toBe("applying");
    expect(fieldsOf()["lifecycle_stage"]).toBe("customer"); // the remote write really happened

    env.advance(env.kit.config.leaseMs - 1);
    expect(await env.worker.runOnce()).toBeNull(); // lease still held
    env.advance(1);
    const recovered = await createWorker(env.kit, { workerId: "restarted-worker" }).runOnce();
    expect(recovered?.note).toMatch(/recovered as unknown/);
    const mid = await env.view(p.id);
    expect(mid.state).toBe("unknown");
    expect(mid.failure?.code).toBe("INTERRUPTED");
    expect(env.sim.calls.write).toBe(1); // recovery did not write again

    const reconciled = await env.worker.runOnce();
    expect(reconciled?.note).toMatch(/reconciled as applied/);
    expect((await env.view(p.id)).state).toBe("applied");
    expect(env.sim.calls.write).toBe(1);
    expect(await env.worker.runOnce()).toBeNull();
    expect(await jobStates()).toEqual(["apply:done", "reconcile:done"]);
    expect(verifyEventChain(p.id, await listOperationEvents(env.kit, env.operator, p.id))).toBeNull();
  });

  it("crash BEFORE the remote write: recovery is UNKNOWN (never assumed), reconciliation proves it did not happen, zero writes", async () => {
    env.kit.faults.crashAt("apply.before_remote");
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    await expect(env.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    env.advance(env.kit.config.leaseMs);
    await env.worker.runOnce();
    expect((await env.view(p.id)).state).toBe("unknown");
    await env.worker.runOnce(); // reconcile inside the quiet period: a late write could still land, so it must not conclude
    expect((await env.view(p.id)).state).toBe("unknown");
    expect(await env.worker.runOnce(), "the deferred reconcile is not due yet").toBeNull();
    env.advance(quietPeriodMs(env.kit.config));
    await env.worker.drain();
    const view = await env.view(p.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("NOT_APPLIED");
    expect(env.sim.calls.write).toBe(0);
    expect(fieldsOf()["lifecycle_stage"]).toBe("lead");
  });

  it("an UNKNOWN outcome found at reclaim stays UNKNOWN when the provider state cannot confirm it: not retried, not discarded", async () => {
    env.kit.faults.crashAt("apply.after_remote_success");
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    await expect(env.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    env.sim.externalEdit(REF, { lifecycle_stage: "partner" });
    env.advance(env.kit.config.leaseMs);
    await env.worker.runOnce(); // recover as unknown
    await env.worker.runOnce(); // reconcile: indeterminate
    const view = await env.view(p.id);
    expect(view.state).toBe("unknown");
    expect(view.attempts.map((a) => a.outcome)).toEqual(expect.arrayContaining(["started", "unknown", "reconciled_indeterminate"]));
    expect(env.sim.calls.write).toBe(1);
    expect(fieldsOf()["lifecycle_stage"]).toBe("partner");
    expect(await env.worker.drain()).toHaveLength(0);
  });

  it("a crashed compensation after the remote restore recovers as UNKNOWN then reconciles to compensated, with no second restore write", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    env.kit.faults.crashAt("compensate.after_remote_success");
    await expect(env.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    expect(fieldsOf()["lifecycle_stage"]).toBe("lead");
    env.advance(env.kit.config.leaseMs);
    await env.worker.runOnce();
    expect((await listCompensations(env.kit, env.operator, op.id))[0]?.state).toBe("unknown");
    await env.worker.runOnce();
    expect((await listCompensations(env.kit, env.operator, op.id))[0]?.state).toBe("compensated");
    expect(env.sim.calls.writeApplied).toBe(2);
    expect(env.sim.calls.write).toBe(2);
  });

  it("a crashed compensation BEFORE the remote restore reconciles to not restored (failed NOT_APPLIED) and the record is untouched", async () => {
    const op = await env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(env.kit, env.operator, op.id);
    await compensateOperation(env.kit, env.operator, op.id, { plan_hash: plan.plan_hash });
    env.kit.faults.crashAt("compensate.before_remote");
    await expect(env.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    env.advance(env.kit.config.leaseMs);
    await env.worker.runOnce();
    await env.worker.runOnce(); // inside the quiet period: deferred, still unknown
    expect((await listCompensations(env.kit, env.operator, op.id))[0]?.state).toBe("unknown");
    env.advance(quietPeriodMs(env.kit.config));
    await env.worker.drain();
    const [comp] = await listCompensations(env.kit, env.operator, op.id);
    expect(comp?.state).toBe("failed");
    expect(comp?.failure?.code).toBe("NOT_APPLIED");
    expect(fieldsOf()["lifecycle_stage"]).toBe("customer");
    expect(env.sim.calls.write).toBe(1);
  });

  it("an operator-requested reconcile after recovery does not create a duplicate job for the same unknown attempt", async () => {
    env.kit.faults.crashAt("apply.after_remote_success");
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    await expect(env.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    env.advance(env.kit.config.leaseMs);
    await env.worker.runOnce();
    const before = await env.count("jobs");
    const r = await requestReconcile(env.kit, env.operator, p.id);
    expect(r.state).toBe("unknown");
    expect(await env.count("jobs")).toBe(before); // the auto-queued reconcile job is reused
  });

  it("a job that fails with an ordinary error is marked failed with a redacted message, not left leased, and the operation is untouched", async () => {
    const p = await env.planAndApprove({ lifecycle_stage: "customer" });
    const secret = "hunter2-ordinary-error-secret";
    const db = env.kit.db;
    const original = db.transaction.bind(db);
    let thrown = 0;
    db.transaction = (async (fn: Parameters<typeof original>[0]) => {
      thrown += 1;
      if (thrown === 1) throw new Error(`database exploded password=${secret}`);
      return original(fn);
    }) as typeof db.transaction;
    const ran = await env.worker.runOnce();
    db.transaction = original as typeof db.transaction;
    expect(thrown, "the injected failure really hit the executor").toBeGreaterThanOrEqual(1);
    expect(ran?.job_state).toBe("failed");
    expect(ran?.note).not.toContain(secret);
    const job = (await env.kit.db.query<{ state: string; last_error: string | null }>("SELECT state, last_error FROM jobs WHERE operation_id = $1::uuid AND kind = 'apply'", [p.id])).rows[0];
    expect(job?.state).toBe("failed");
    expect(job?.last_error ?? "").not.toContain(secret);
    expect(job?.last_error ?? "").toMatch(/REDACTED/);
    expect((await jobStates()).every((s) => !s.endsWith(":leased"))).toBe(true);
    expect((await env.view(p.id)).state).toBe("approved"); // nothing was written or half-recorded
    expect(env.sim.calls.write).toBe(0);
  });
});

describe("AC-13 a real process restart on a file-backed database", () => {
  it("state survives close and reopen; the interrupted attempt recovers as UNKNOWN and reconciles, without a second write", async () => {
    const dir = tmp();
    const dbDir = join(dir, "db");
    mkdirSync(dbDir);
    const keyText = KeyRing.generateKeyText();
    const clock1 = new FixedClock(FIXED_NOW_ISO);
    const first = await makeEnvOnFile(dbDir, keyText, clock1);
    first.kit.faults.crashAt("apply.after_remote_success");
    const p = await first.planAndApprove({ lifecycle_stage: "customer" });
    await expect(first.worker.runOnce()).rejects.toBeInstanceOf(InjectedCrash);
    const sim = first.sim;
    const opActor = first.operator;
    const connectorId = first.connectorId;
    await first.kit.close(); // process death

    const clock2 = new FixedClock(FIXED_NOW_ISO);
    clock2.advance(60 * 60 * 1000);
    const second: UndoKit = await createUndoKit({ databaseUrl: `pglite://${dbDir}`, keyring: KeyRing.fromBase64(keyText), clock: clock2, ids: new SequentialIds("bbbbbbbb") });
    try {
      expect(second.readiness.ok).toBe(true);
      second.connectors.register(connectorId, sim); // the external provider outlives the process
      const view = await getOperation(second, opActor, p.id);
      expect(view.state).toBe("applying");
      const worker = createWorker(second, { workerId: "after-restart" });
      await worker.runOnce();
      expect((await getOperation(second, opActor, p.id)).state).toBe("unknown");
      await worker.runOnce();
      expect((await getOperation(second, opActor, p.id)).state).toBe("applied");
      expect(sim.calls.write).toBe(1);
    } finally {
      await second.close();
    }
  });
});

async function makeEnvOnFile(dbDir: string, keyText: string, clock: FixedClock) {
  const { createWorkspaceWithAdmin, createMember, createConnector, planOperation, approveOperation } = await import("../../src/index.js");
  const { loadDemo } = await import("../helpers/fixtures.js");
  const { demoPolicy } = await import("../helpers/policy.js");
  const { newPassword } = await import("../helpers/kit.js");
  const kit = await createUndoKit({ databaseUrl: `pglite://${dbDir}`, keyring: KeyRing.fromBase64(keyText), clock, ids: new SequentialIds("aaaaaaaa") });
  const ws = await createWorkspaceWithAdmin(kit, { email: "admin-f@example.test", password: newPassword(), workspace_name: "Synthetic File" });
  const admin = { user_id: ws.user_id, workspace_id: ws.workspace_id, role: "admin" as const };
  const m = await createMember(kit, admin, { email: "operator-f@example.test", password: newPassword(), role: "operator" });
  const operator = { user_id: m.user_id, workspace_id: ws.workspace_id, role: "operator" as const };
  const demo = loadDemo();
  const connector = await createConnector(kit, admin, { kind: "simulator", name: "file-sim", policy: demoPolicy(), config: { seed_records: demo.records.map((r) => ({ record_ref: r.record_ref, fields: r.fields })) } });
  const sim = kit.connectors.simulator(connector.id);
  const worker = createWorker(kit, { workerId: "file-worker" });
  return {
    kit,
    sim,
    worker,
    operator,
    connectorId: connector.id,
    async planAndApprove(patch: Record<string, unknown>) {
      const plan = await planOperation(kit, operator, { connector_id: connector.id, record_ref: REF, patch, expected_version: sim.snapshot(REF)!.version }, "file-key-1");
      await approveOperation(kit, operator, plan.body.id, { plan_hash: plan.body.plan_hash, expected_version: sim.snapshot(REF)!.version });
      return { id: plan.body.id };
    },
  };
}

async function bareKit(keyText: string, clock = new FixedClock(FIXED_NOW_ISO)): Promise<UndoKit> {
  return createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(keyText), clock, ids: new SequentialIds("cccccccc") });
}

describe("AC-13 a restored backup preserves references", () => {
  async function populate() {
    const applied = await env.applyOnce({ lifecycle_stage: "customer" });
    await env.compensateOnce(applied.id);
    env.sim.failNextWrite("ambiguous_after_commit");
    const unknown = await env.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    // A record with an UNKNOWN operation accepts no new plan (review P2-3), so the extra operation uses the record that was compensated and is resolved.
    const blocked = await env.applyOnce({ owner_label: "team-green" }, { record_ref: "contact-0001" });
    return { applied, unknown, blocked };
  }

  it("happy: ids, foreign keys, hashes and per-operation views survive; evidence chains are re-verified; work continues after restore", async () => {
    const { applied, unknown } = await populate();
    const writesBeforeRestore = env.sim.calls.write;
    const backup = await backupDatabase(env.kit.db, env.kit.clock.now());
    expect(backup.format).toBe("undokit-backup");
    expect(backup.tables_hash).toBe(contentHash(backup.tables));
    expect(Object.keys(backup.tables)).not.toContain("sessions");
    expect(JSON.stringify(backup)).not.toContain(env.keyText);

    const target = await bareKit(env.keyText);
    try {
      const report = await restoreDatabase(target.db, JSON.parse(JSON.stringify(backup)));
      const opCount = (await env.kit.db.query("SELECT id FROM operations")).rows.length;
      expect(opCount).toBeGreaterThanOrEqual(3);
      expect(report.chains_verified).toBe(opCount);
      for (const [table, n] of Object.entries(report.tables)) expect(n, table).toBe(backup.tables[table]?.length ?? 0);
      for (const id of [applied.id, unknown.id]) {
        expect(await getOperation(target, env.operator, id)).toEqual(await getOperation(env.kit, env.operator, id));
        expect(verifyEventChain(id, await listOperationEvents(target, env.operator, id))).toBeNull();
      }
      // Foreign keys are enforced after the restore.
      await expect(target.db.query("DELETE FROM operations WHERE id = $1::uuid", [applied.id])).rejects.toThrow();
      // The restored system keeps working: the external provider outlived the backup, so reconcile resolves the unknown.
      target.connectors.register(env.connectorId, env.sim);
      await requestReconcile(target, env.operator, unknown.id);
      await createWorker(target, { workerId: "restored" }).runOnce();
      expect((await getOperation(target, env.operator, unknown.id)).state).toBe("applied");
      expect(env.sim.calls.write).toBe(writesBeforeRestore); // reconciling after a restore never writes
    } finally {
      await target.close();
    }
  });

  it("a writer racing the backup cannot produce an inconsistent dump: every child row has its parent and the restore passes foreign-key validation", async () => {
    await populate();
    const db = env.kit.db;
    const isBackupRead = (text: string) => text.includes("to_jsonb(t)") && /FROM operations t/.test(text);
    let writer: Promise<unknown> | undefined;
    const race = async () => {
      if (writer) return;
      // A new operation (with its snapshots and events) is created by another request right after the backup read `operations`.
      writer = env.plan({ lead_score: 31 }, { record_ref: "contact-0001" });
      await new Promise((r) => setTimeout(r, 60)); // let it run between per-table reads if the dump is not one snapshot
    };
    const originalQuery = db.query.bind(db);
    const originalTransaction = db.transaction.bind(db);
    db.query = (async (text: string, params?: unknown[]) => {
      const res = await originalQuery(text, params as never);
      if (isBackupRead(text)) await race();
      return res;
    }) as typeof db.query;
    db.transaction = (async (fn: Parameters<typeof originalTransaction>[0]) =>
      originalTransaction(async (tx) => {
        const txQuery = tx.query.bind(tx);
        return fn({
          ...tx,
          query: (async (text: string, params?: unknown[]) => {
            const res = await txQuery(text, params as never);
            if (isBackupRead(text)) await race();
            return res;
          }) as typeof tx.query,
        } as typeof tx);
      })) as typeof db.transaction;
    let backup: Awaited<ReturnType<typeof backupDatabase>>;
    try {
      backup = await backupDatabase(db, env.kit.clock.now());
    } finally {
      db.query = originalQuery as typeof db.query;
      db.transaction = originalTransaction as typeof db.transaction;
    }
    expect(writer, "the racing writer really started during the backup").toBeDefined();
    await writer;
    const ops = new Set(backup.tables["operations"]!.map((r) => String(r["id"])));
    for (const table of ["field_snapshots", "evidence_events", "attempts", "approvals"]) {
      for (const row of backup.tables[table] ?? []) expect(ops.has(String(row["operation_id"])), `${table} row without its operation`).toBe(true);
    }
    const target = await bareKit(env.keyText);
    try {
      const report = await restoreDatabase(target.db, JSON.parse(JSON.stringify(backup)));
      expect(report.chains_verified).toBe(ops.size);
    } finally {
      await target.close();
    }
  });

  it("restore needs the same operator-managed key: with another key the restored data is unreadable, never silently wrong", async () => {
    const { applied } = await populate();
    const backup = await backupDatabase(env.kit.db, env.kit.clock.now());
    const target = await bareKit(KeyRing.generateKeyText());
    try {
      await restoreDatabase(target.db, backup);
      const err = await rejection(() => getOperation(target, env.operator, applied.id));
      expect(err.code).toBe("INTERNAL_ERROR");
      expect(err.message).toMatch(/could not be decrypted/);
    } finally {
      await target.close();
    }
  });

  describe("sad: damaged or unsafe backups are rejected and leave the target empty", () => {
    async function expectRejectedAndEmpty(doc: unknown, code: string) {
      const target = await bareKit(env.keyText);
      try {
        const err = await rejection(() => restoreDatabase(target.db, doc));
        expect(err.code).toBe(code);
        for (const table of ["workspaces", "users", "operations", "field_snapshots", "evidence_events", "jobs"]) {
          expect((await target.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n, table).toBe(0);
        }
      } finally {
        await target.close();
      }
    }
    const rehash = (b: Awaited<ReturnType<typeof backupDatabase>>) => ({ ...b, tables_hash: contentHash(b.tables) });

    it("content altered after the backup was taken (hash mismatch)", async () => {
      await populate();
      const b = JSON.parse(JSON.stringify(await backupDatabase(env.kit.db)));
      b.tables.operations[0].record_ref = "contact-9999";
      await expectRejectedAndEmpty(b, "BUNDLE_INTEGRITY_FAILED");
    });

    async function danglingBackup() {
      await populate();
      const b = JSON.parse(JSON.stringify(await backupDatabase(env.kit.db)));
      b.tables.operations = b.tables.operations.slice(1); // snapshots, approvals, attempts now point at nothing
      return rehash(b);
    }

    it("a dangling reference, even with a recomputed hash: the foreign key rejects it and the whole restore rolls back", async () => {
      const doc = await danglingBackup();
      const target = await bareKit(env.keyText);
      try {
        const err = await rejection(() => restoreDatabase(target.db, doc));
        expect(err.code).toBe("BUNDLE_INTEGRITY_FAILED");
        expect(err.message).not.toMatch(/foreign key|violates|constraint|relation|table /i); // no driver internals
        for (const table of ["workspaces", "users", "operations", "field_snapshots", "evidence_events", "jobs"]) {
          expect((await target.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n, table).toBe(0);
        }
      } finally {
        await target.close();
      }
    });

    // Regression test for QA-D7 (fixed in 3d15b45): the foreign-key failure surfaces as a typed BUNDLE_INTEGRITY_FAILED, not a raw driver error.
    it("a dangling reference is reported as a typed BUNDLE_INTEGRITY_FAILED, not a raw database error", async () => {
      await expectRejectedAndEmpty(await danglingBackup(), "BUNDLE_INTEGRITY_FAILED");
    });

    it("an evidence event altered with a recomputed backup hash: the chain re-verification breaks the restore and rolls everything back", async () => {
      await populate();
      const b = JSON.parse(JSON.stringify(await backupDatabase(env.kit.db)));
      b.tables.evidence_events[1].payload = { forged: true };
      await expectRejectedAndEmpty(rehash(b), "BUNDLE_INTEGRITY_FAILED");
    });

    it("unsupported format, non-object and missing tables", async () => {
      const b = JSON.parse(JSON.stringify(await backupDatabase(env.kit.db)));
      await expectRejectedAndEmpty({ ...b, format_version: 2 }, "BUNDLE_UNSUPPORTED");
      await expectRejectedAndEmpty({ ...b, format: "other" }, "BUNDLE_UNSUPPORTED");
      await expectRejectedAndEmpty("not json object", "MALFORMED_REQUEST");
      await expectRejectedAndEmpty(null, "MALFORMED_REQUEST");
      await expectRejectedAndEmpty({ format: "undokit-backup", format_version: 1 }, "BUNDLE_INTEGRITY_FAILED");
    });

    it("restoring over a database that already has data is refused", async () => {
      await populate();
      const backup = await backupDatabase(env.kit.db);
      const err = await rejection(() => restoreDatabase(env.kit.db, backup));
      expect(err.code).toBe("INVALID_STATE");
    });
  });
});

describe("AC-13 a failed migration stops readiness and rolls back atomically", () => {
  function brokenDir(sql: string, name = "001_initial.sql"): string {
    const dir = tmp();
    writeFileSync(join(dir, name), sql);
    return dir;
  }

  it("readiness is false, /ready is 503, /health stays 200, every other route is 503, no worker runs, and the migration left nothing behind", async () => {
    const dir = brokenDir("CREATE TABLE qa_probe (id int); SELECT 1/0;");
    const kit = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()), migrationsDir: dir });
    try {
      expect(kit.readiness.ok).toBe(false);
      expect(kit.readiness.error).toMatch(/migration 1 .*failed/);
      expect((await kit.db.query<{ t: string | null }>("SELECT to_regclass('qa_probe')::text AS t")).rows[0]?.t).toBeNull();
      expect((await kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM schema_version")).rows[0]?.n).toBe(0);
      const app = await buildServer(kit);
      try {
        const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
        expect(ready.statusCode).toBe(503);
        expect(ready.json().error.code).toBe("NOT_READY");
        expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
        for (const url of ["/api/v1/operations", "/api/v1/status", "/api/v1/connectors", "/api/v1/auth/me"]) {
          const r = await app.inject({ method: "GET", url });
          expect(r.statusCode, url).toBe(503);
          expect(r.json().error.code).toBe("NOT_READY");
        }
        const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "a@example.test", password: "x".repeat(12) } });
        expect(login.statusCode).toBe(503);
      } finally {
        await app.close();
      }
      expect(await createWorker(kit).runOnce()).toBeNull();
    } finally {
      await kit.close();
    }
  });

  it("a failed second migration keeps the first one applied and is retried successfully after the cause is fixed", async () => {
    const real = defaultMigrationsDir();
    const dir = tmp();
    const { readFileSync } = await import("node:fs");
    writeFileSync(join(dir, "001_initial.sql"), readFileSync(join(real, "001_initial.sql"), "utf8"));
    writeFileSync(join(dir, "002_extra.sql"), "CREATE TABLE qa_extra (id int); SELECT 1/0;");
    const db = await openDatabase("memory://");
    try {
      const failed = await runMigrations(db, { dir });
      expect(failed.ok).toBe(false);
      expect(failed.applied).toEqual([1]);
      expect(failed.pending).toEqual([2]);
      expect((await db.query<{ t: string | null }>("SELECT to_regclass('qa_extra')::text AS t")).rows[0]?.t).toBeNull();
      expect((await checkSchema(db, { dir })).ok).toBe(false);
      writeFileSync(join(dir, "002_extra.sql"), "CREATE TABLE qa_extra (id int);");
      const fixed = await runMigrations(db, { dir });
      expect(fixed.ok).toBe(true);
      expect(fixed.applied).toEqual([1, 2]);
    } finally {
      await db.close();
    }
  });

  it("a migration edited after it was applied is treated as tampering and stops readiness", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "001_initial.sql"), "CREATE TABLE qa_t (id int);");
    const db = await openDatabase("memory://");
    try {
      expect((await runMigrations(db, { dir })).ok).toBe(true);
      writeFileSync(join(dir, "001_initial.sql"), "CREATE TABLE qa_t (id int, extra int);");
      const status = await checkSchema(db, { dir });
      expect(status.ok).toBe(false);
      expect(status.error).toMatch(/modified after being applied/);
      expect((await runMigrations(db, { dir })).ok).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("an unreadable or empty migrations directory is reported as not ready, not as ready-by-default", async () => {
    const kit = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()), migrationsDir: join(tmp(), "does-not-exist") });
    try {
      expect(kit.readiness.ok).toBe(false);
      expect(kit.readiness.error).toMatch(/cannot load migrations/);
    } finally {
      await kit.close();
    }
  });

  it("with pending migrations and migrations skipped, readiness is false (the service never serves a stale schema)", async () => {
    const db = await openDatabase("memory://");
    try {
      const kit = await createUndoKit({ db, keyring: KeyRing.fromBase64(KeyRing.generateKeyText()), skipMigrations: true });
      expect(kit.readiness.ok).toBe(false);
      expect(kit.readiness.error).toMatch(/not initialised|pending migrations/);
    } finally {
      await db.close();
    }
  });
});
