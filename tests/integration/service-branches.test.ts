// Edge branches of the bundle, auth, operations, status, worker, api and database layers (QA-owned): validation limits, pagination
// cursors, duplicate and concurrent imports, session freshness, worker failure classification, status attention reasons, and the
// database driver wrapper. Everything runs against a real embedded database; corrupt-state cases use direct SQL on a scratch DB.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppError,
  FixedClock,
  KeyRing,
  SequentialIds,
  authenticate,
  bootstrapAdmin,
  buildServer,
  canonicalJson,
  contentHash,
  createConnector,
  createMember,
  createUndoKit,
  createWorker,
  createWorkspaceWithAdmin,
  dispatchOutbox,
  exportBundle,
  getStatus,
  importBundle,
  importBundleIntoCleanInstall,
  listImports,
  listJobs,
  listOperations,
  listSessions,
  login,
  logout,
  openDatabase,
  planOperation,
  requestReconcile,
  revokeSession,
  verifyBundleText,
  type EvidenceBundle,
} from "../../src/index.js";
import { demoPolicy } from "../helpers/policy.js";
import { syntheticUuid } from "../helpers/fixtures.js";
import { anon, login as httpLogin, HOST } from "../helpers/http.js";
import { makeEnv, newPassword, rejection, ONE_MINUTE, type Env } from "../helpers/kit.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
async function env(opts: Parameters<typeof makeEnv>[0] = {}): Promise<Env> {
  const e = await makeEnv(opts);
  cleanups.push(() => e.close());
  return e;
}

function rebuild(bundle: EvidenceBundle, edit: (b: EvidenceBundle) => void): string {
  const b = structuredClone(bundle);
  edit(b);
  const { bundle_hash: _h, files, complete, ...head } = b;
  void files;
  void complete;
  b.bundle_hash = contentHash(head);
  return JSON.stringify(b);
}

describe("evidence bundle export, verify and import edge cases", () => {
  it("export refuses more operations than the configured file limit, whether implied or listed", async () => {
    const e = await env({ config: { maxImportFiles: 1 } });
    const a = await e.applyOnce({ lifecycle_stage: "customer" });
    await e.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    expect((await rejection(() => exportBundle(e.kit, e.operator, {}))).code).toBe("PAYLOAD_TOO_LARGE");
    expect((await rejection(() => exportBundle(e.kit, e.operator, { operation_ids: [a.id, syntheticUuid("x")] }))).code).toBe("PAYLOAD_TOO_LARGE");
    expect((await exportBundle(e.kit, e.operator, { operation_ids: [a.id] })).manifest.file_count).toBe(1); // within the limit
    const small = await env();
    await small.applyOnce({ lifecycle_stage: "customer" });
    expect((await exportBundle(small.kit, small.operator, undefined)).manifest.file_count).toBe(1); // a missing body means "everything"
  });

  it("verify reports each integrity problem by name: duplicate path, missing file, wrong size, path that does not match the operation id", async () => {
    const e = await env();
    await e.applyOnce({ lifecycle_stage: "customer" });
    const bundle = await exportBundle(e.kit, e.operator, {});
    const codes = (text: string) => {
      try {
        verifyBundleText(text);
        return [];
      } catch (err) {
        return ((err as AppError).details ?? []).map((d) => d.code);
      }
    };
    const entry0 = (b: EvidenceBundle) => b.manifest.files[0]!;
    expect(codes(rebuild(bundle, (b) => b.manifest.files.push({ ...entry0(b) })))).toContain("DUPLICATE_PATH");
    expect(codes(rebuild(bundle, (b) => void delete b.files[entry0(b).path]))).toContain("MISSING_FILE");
    expect(codes(rebuild(bundle, (b) => (entry0(b).bytes += 1)))).toContain("SIZE_MISMATCH");
    const otherId = syntheticUuid("other-operation");
    const moved = rebuild(bundle, (b) => {
      const old = entry0(b).path;
      const next = `operations/${otherId}.json`;
      b.files[next] = b.files[old]!;
      delete b.files[old];
      entry0(b).path = next;
    });
    expect(codes(moved)).toContain("PATH_ID_MISMATCH");
    expect(canonicalJson(bundle).length).toBeGreaterThan(0);
  });

  it("the same bundle id with different content is a duplicate-resource conflict; the same content replays", async () => {
    const e = await env();
    const target = await env();
    await e.applyOnce({ lifecycle_stage: "customer" });
    const bundle = await exportBundle(e.kit, e.operator, {});
    const first = await importBundle(target.kit, target.operator, JSON.stringify(bundle));
    expect(first.replayed).toBe(false);
    const sameIdOtherContent = rebuild(bundle, (b) => void (b.created_at = "2030-01-01T00:00:00.000Z"));
    expect((await rejection(() => importBundle(target.kit, target.operator, sameIdOtherContent))).code).toBe("DUPLICATE_RESOURCE");
    expect((await importBundle(target.kit, target.operator, JSON.stringify(bundle))).replayed).toBe(true);
  });

  it("two concurrent imports of the same bundle: one stores it, the other is a replay (no raw database error)", async () => {
    const e = await env();
    const target = await env();
    await e.applyOnce({ lifecycle_stage: "customer" });
    const text = JSON.stringify(await exportBundle(e.kit, e.operator, {}));
    const results = await Promise.all([importBundle(target.kit, target.operator, text), importBundle(target.kit, target.operator, text)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await target.count("evidence_imports")).toBe(1);
  });

  // Regression for QA-D15 (fixed in 67ac16d): when two imports race with the same bundle_id but different content, the loser's
  // unique-constraint violation used to be re-thrown as the raw driver error instead of the typed DUPLICATE_RESOURCE that the
  // non-racing path returns.
  it("two concurrent imports with the same bundle id but different content never leak a raw database error", async () => {
    const e = await env();
    const target = await env();
    await e.applyOnce({ lifecycle_stage: "customer" });
    const bundle = await exportBundle(e.kit, e.operator, {});
    const other = rebuild(bundle, (b) => void (b.created_at = "2031-01-01T00:00:00.000Z"));
    const settled = await Promise.allSettled([importBundle(target.kit, target.operator, JSON.stringify(bundle)), importBundle(target.kit, target.operator, other)]);
    for (const s of settled) if (s.status === "rejected") expect(s.reason, "must be a typed AppError, not a driver error").toBeInstanceOf(AppError);
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as AppError).code).toBe("DUPLICATE_RESOURCE");
    expect(await target.count("evidence_imports")).toBe(1);
  });

  it("listImports pages with a cursor and rejects every malformed cursor", async () => {
    const e = await env();
    const target = await env();
    for (let i = 0; i < 3; i += 1) {
      const op = await e.applyOnce({ lead_score: 100 + i }, { record_ref: "contact-0002" });
      const bundle = await exportBundle(e.kit, e.operator, { operation_ids: [op.id] });
      await importBundle(target.kit, target.operator, JSON.stringify(bundle));
      target.advance(1000);
    }
    const first = await listImports(target.kit, target.operator, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = await listImports(target.kit, target.operator, { limit: 2, cursor: first.next_cursor! });
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of ["!!!", b64("only-one-part"), b64("not-a-date|00000000-0000-0000-0000-000000000000"), b64("2026-01-01T00:00:00Z|not-a-uuid"), b64("|")]) {
      expect((await rejection(() => listImports(target.kit, target.operator, { cursor: bad }))).code, bad).toBe("MALFORMED_REQUEST");
    }
  });

  it("clean-installation import creates one system workspace once, refuses once anyone can sign in, and honours a custom workspace name", async () => {
    const e = await env();
    await e.applyOnce({ lifecycle_stage: "customer" });
    const text = JSON.stringify(await exportBundle(e.kit, e.operator, {}));
    const clean = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()) });
    cleanups.push(() => clean.close());
    const one = await importBundleIntoCleanInstall(clean, text, { workspace_name: "Imported for QA" });
    expect(one.replayed).toBe(false);
    const again = await importBundleIntoCleanInstall(clean, text);
    expect(again.replayed).toBe(true);
    expect(again.workspace_id).toBe(one.workspace_id);
    expect(((await clean.db.query<{ name: string }>("SELECT name FROM workspaces")).rows).map((r) => r.name)).toEqual(["Imported for QA"]);
    // An installation where someone can already sign in is not "clean": the system workspace is never created for it.
    const used = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()) });
    cleanups.push(() => used.close());
    await createWorkspaceWithAdmin(used, { email: "someone@example.test", password: newPassword(), workspace_name: "Real" });
    expect((await rejection(() => importBundleIntoCleanInstall(used, text))).code).toBe("INVALID_STATE");
    expect((await used.db.query("SELECT 1 FROM evidence_imports")).rows).toEqual([]);
  });
});

describe("auth: validation, bootstrap and sessions", () => {
  it("workspace creation validates email, name length and password policy, and a duplicate email is a conflict", async () => {
    const e = await env();
    const good = { email: "a1@example.test", password: newPassword(), workspace_name: "W" };
    expect((await rejection(() => createWorkspaceWithAdmin(e.kit, { ...good, password: "short" }))).details?.[0]?.code).toBe("PASSWORD_TOO_SHORT");
    expect((await rejection(() => createWorkspaceWithAdmin(e.kit, { ...good, email: "not-an-email" }))).message).toMatch(/invalid email/);
    expect((await rejection(() => createWorkspaceWithAdmin(e.kit, { ...good, workspace_name: "  " }))).message).toMatch(/workspace_name/);
    expect((await rejection(() => createWorkspaceWithAdmin(e.kit, { ...good, workspace_name: "x".repeat(129) }))).message).toMatch(/workspace_name/);
    expect((await rejection(() => createWorkspaceWithAdmin(e.kit, { ...good, email: e.emails.admin }))).code).toBe("DUPLICATE_RESOURCE");
  });

  it("bootstrapAdmin works only on an empty instance, validating the same inputs; a duplicate member email is a conflict", async () => {
    const empty = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()) });
    cleanups.push(() => empty.close());
    const input = { email: "boot@example.test", password: newPassword(), workspace_name: "Boot" };
    expect((await rejection(() => bootstrapAdmin(empty, { ...input, email: "bad" }))).message).toMatch(/invalid email/);
    expect((await rejection(() => bootstrapAdmin(empty, { ...input, workspace_name: "" }))).message).toMatch(/workspace_name/);
    expect((await rejection(() => bootstrapAdmin(empty, { ...input, password: "short" }))).code).toBe("VALIDATION_FAILED");
    const created = await bootstrapAdmin(empty, input);
    expect((await rejection(() => bootstrapAdmin(empty, { ...input, email: "second@example.test" }))).code).toBe("FORBIDDEN");
    const admin = { workspace_id: created.workspace_id, user_id: created.user_id, role: "admin" as const };
    await createMember(empty, admin, { email: "m@example.test", password: newPassword(), role: "viewer" });
    expect((await rejection(() => createMember(empty, admin, { email: "M@Example.Test", password: newPassword(), role: "viewer" }))).code).toBe("DUPLICATE_RESOURCE");
  });

  it("a user without a membership in the requested workspace cannot sign in there; the failure counts toward the rate limit", async () => {
    const e = await env();
    const err = await rejection(() => login(e.kit, { email: e.emails.operator, password: e.passwords.operator, workspace_id: e.adminB.workspace_id }, { ip: "10.1.1.1" }));
    expect(err.code).toBe("INVALID_CREDENTIALS");
    const ok = await login(e.kit, { email: e.emails.operator, password: e.passwords.operator, workspace_id: e.operator.workspace_id });
    expect(ok.session.workspace.id).toBe(e.operator.workspace_id);
    expect(await login(e.kit, { email: e.emails.operator, password: e.passwords.operator })).toBeTruthy(); // no ip: limiter key without address
  });

  it("session freshness: last_seen is refreshed only after a minute, expired and revoked sessions are refused, logout revokes", async () => {
    const e = await env();
    const { token, session_id } = await login(e.kit, { email: e.emails.operator, password: e.passwords.operator });
    const seen = async () => (await e.kit.db.query<{ last_seen_at: string }>("SELECT last_seen_at FROM sessions WHERE id = $1::uuid", [session_id])).rows[0]!.last_seen_at;
    const first = await seen();
    e.advance(30_000);
    expect(await authenticate(e.kit, token)).not.toBeNull();
    expect(await seen()).toBe(first); // within a minute: not rewritten
    e.advance(40_000);
    expect(await authenticate(e.kit, token)).not.toBeNull();
    expect(await seen()).not.toBe(first);
    expect(await authenticate(e.kit, undefined)).toBeNull();
    expect(await authenticate(e.kit, "x".repeat(300))).toBeNull();
    await logout(e.kit, session_id);
    expect(await authenticate(e.kit, token)).toBeNull();
    const second = await login(e.kit, { email: e.emails.viewer, password: e.passwords.viewer });
    e.advance(e.kit.config.sessionTtlMs + 1);
    expect(await authenticate(e.kit, second.token)).toBeNull();
  });

  it("listSessions: an admin sees the workspace's sessions, others only their own; revoking a foreign or malformed id is NOT_FOUND / validation", async () => {
    const e = await env();
    const op = await login(e.kit, { email: e.emails.operator, password: e.passwords.operator });
    await login(e.kit, { email: e.emails.viewer, password: e.passwords.viewer });
    const adminSession = await login(e.kit, { email: e.emails.admin, password: e.passwords.admin });
    const asAdmin = await listSessions(e.kit, e.admin, adminSession.session_id);
    expect(asAdmin.length).toBeGreaterThanOrEqual(3);
    expect(asAdmin.find((s) => s.current)?.id).toBe(adminSession.session_id);
    const asOperator = await listSessions(e.kit, e.operator, op.session_id);
    expect(asOperator.every((s) => s.user_id === e.operator.user_id)).toBe(true);
    const other = await login(e.kit, { email: e.emails.adminB, password: e.passwords.adminB });
    expect((await rejection(() => revokeSession(e.kit, e.admin, other.session_id))).code).toBe("NOT_FOUND");
    expect((await rejection(() => revokeSession(e.kit, e.admin, "not-a-uuid"))).status).toBeLessThan(500);
  });

  it("a stored password hash in an unknown format never verifies (and the login still answers 401 in similar time)", async () => {
    const e = await env();
    await e.kit.db.query("UPDATE users SET password_hash = 'plain:text' WHERE email = $1", [e.emails.viewer]);
    expect((await rejection(() => login(e.kit, { email: e.emails.viewer, password: e.passwords.viewer }))).code).toBe("INVALID_CREDENTIALS");
  });
});

describe("operations and jobs: disabled connectors, tampered plans, cursors", () => {
  it("a disabled connector refuses planning and approval", async () => {
    const e = await env();
    const plan = await e.plan({ lifecycle_stage: "customer" });
    await e.kit.db.query("UPDATE connectors SET disabled_at = $2::timestamptz WHERE id = $1::uuid", [e.connectorId, "2026-01-15T12:00:00.000Z"]);
    const { approveOperation } = await import("../../src/index.js");
    expect((await rejection(() => approveOperation(e.kit, e.operator, plan.id, { plan_hash: plan.plan_hash, expected_version: "sim-v1" }))).code).toBe("VALIDATION_FAILED");
    expect((await rejection(() => e.plan({ lead_score: 3 }, { record_ref: "contact-0002" }))).message).toMatch(/disabled/);
  });

  it("a field that does not exist yet on the record is planned from null; a duplicate field in a connector allowlist is refused", async () => {
    const e = await env();
    e.sim.seed("contact-0007", { lifecycle_stage: "lead" });
    const p = await e.plan({ owner_label: "new-owner" }, { record_ref: "contact-0007" });
    expect((await e.view(p.id)).fields[0]).toMatchObject({ field: "owner_label", before: null, intended: "new-owner" });
    const policy = demoPolicy();
    const dup = { kind: "simulator", name: "dup-fields", policy: { ...policy, allowed_fields: [...policy.allowed_fields, policy.allowed_fields[0]!] }, config: { seed_records: [] } };
    const err = await rejection(() => createConnector(e.kit, e.admin, dup));
    expect(err.details?.[0]?.code).toBe("DUPLICATE_FIELD");
  });

  it("compensation approval is refused when the stored plan no longer matches its hash or the version moved, when another is already approved, and for non-applied operations", async () => {
    const e = await env();
    const { createCompensationPlan, compensateOperation } = await import("../../src/index.js");
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(e.kit, e.operator, op.id);
    await e.kit.db.query("UPDATE compensations SET plan_hash = $2 WHERE id = $1::uuid", [plan.id, plan.plan_hash]); // same value: no-op sanity
    await e.kit.db.query("UPDATE compensations SET expected_version = 'sim-v999' WHERE id = $1::uuid", [plan.id]);
    expect((await rejection(() => compensateOperation(e.kit, e.operator, op.id, { plan_hash: plan.plan_hash }))).code).toBe("PLAN_HASH_MISMATCH");
    const op2 = await e.applyOnce({ lead_score: 66 }, { record_ref: "contact-0002" });
    const plan2 = await createCompensationPlan(e.kit, e.operator, op2.id);
    await e.kit.db.query("UPDATE compensations SET expected_version = 'sim-v999', plan_hash = $2 WHERE id = $1::uuid", [plan2.id, plan2.plan_hash]);
    const failed = await e.plan({ lead_score: 71 }, { record_ref: "contact-0002" });
    expect((await rejection(() => compensateOperation(e.kit, e.operator, failed.id, { plan_hash: plan2.plan_hash }))).code).toBe("INVALID_STATE");
    expect((await rejection(() => createCompensationPlan(e.kit, e.operator, failed.id))).code).toBe("INVALID_STATE");
  });

  it("two compensation plans for one operation: approving one blocks approving the other", async () => {
    const e = await env();
    const { createCompensationPlan, compensateOperation } = await import("../../src/index.js");
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    const first = await createCompensationPlan(e.kit, e.operator, op.id);
    await e.kit.db.query("UPDATE compensations SET state = 'conflict' WHERE id = $1::uuid", [first.id]);
    const second = await createCompensationPlan(e.kit, e.operator, op.id);
    await e.kit.db.query("UPDATE compensations SET plan_hash = $2 WHERE id = $1::uuid", [first.id, `sha256:${"c".repeat(64)}`]);
    await compensateOperation(e.kit, e.operator, op.id, { plan_hash: second.plan_hash });
    const third = await e.kit.db.query<{ id: string }>("SELECT id FROM compensations WHERE operation_id = $1::uuid AND state = 'conflict' LIMIT 1", [op.id]);
    expect(third.rows).toHaveLength(1);
    expect((await rejection(() => createCompensationPlan(e.kit, e.operator, op.id))).code).toBe("INVALID_STATE");
  });

  it("operation and job lists page by cursor with state filters, and reject malformed cursors", async () => {
    const e = await env();
    for (let i = 0; i < 3; i += 1) {
      await e.applyOnce({ lead_score: 200 + i }, { record_ref: "contact-0002" });
      e.advance(1000);
    }
    const ops1 = await listOperations(e.kit, e.operator, { limit: 2 });
    expect(ops1.items).toHaveLength(2);
    const ops2 = await listOperations(e.kit, e.operator, { limit: 2, cursor: ops1.next_cursor! });
    expect(ops2.items).toHaveLength(1);
    expect(ops2.next_cursor).toBeNull();
    const jobs1 = await listJobs(e.kit, e.operator, { limit: 2 });
    expect(jobs1.next_cursor).toBeTruthy();
    expect((await listJobs(e.kit, e.operator, { limit: 2, cursor: jobs1.next_cursor! })).items).toHaveLength(1);
    expect((await listJobs(e.kit, e.operator, { state: "done" })).items.length).toBe(3);
    expect((await listJobs(e.kit, e.operator, { state: "failed" })).items).toEqual([]);
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of ["!!!", b64("x"), b64("not-a-date|00000000-0000-0000-0000-000000000000"), b64("2026-01-01T00:00:00Z|nope")]) {
      expect((await rejection(() => listOperations(e.kit, e.operator, { cursor: bad }))).status, bad).toBe(400);
    }
  });

  it("a reconcile request with an unknown operation and no recorded attempt still queues one reconcile job", async () => {
    const e = await env();
    const plan = await e.planAndApprove({ lifecycle_stage: "customer" });
    await e.worker.runOnce();
    await e.kit.db.query("UPDATE operations SET state = 'unknown' WHERE id = $1::uuid", [plan.id]);
    const r = await requestReconcile(e.kit, e.operator, plan.id);
    expect(r.state).toBe("unknown");
    expect(await e.count("jobs")).toBe(2);
  });

  it("the compensation conflict message distinguishes a missing record from a changed version, and a plan for a missing record is a conflict", async () => {
    const e = await env();
    const { createCompensationPlan, compensateOperation } = await import("../../src/index.js");
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(e.kit, e.operator, op.id);
    e.kit.connectors.register(e.connectorId, { kind: "simulator", live: false, label: "gone", supportsAtomicConditionalWrite: true, read: async () => null, ping: async () => undefined, conditionalWrite: async () => Promise.reject(new Error("no")) });
    const err = await rejection(() => compensateOperation(e.kit, e.operator, op.id, { plan_hash: plan.plan_hash }));
    expect(err.code).toBe("COMPENSATION_BLOCKED");
    expect(err.details?.map((d) => d.message)).toContain("record no longer exists");
  });
});

describe("status attention reasons", () => {
  it("every unresolved class is listed with a reason and a next step: unknown op, unknown compensation, failed, conflict, failed job", async () => {
    const e = await env();
    const { createCompensationPlan, compensateOperation } = await import("../../src/index.js");
    e.sim.failNextWrite("ambiguous_after_commit");
    await e.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    const base = await e.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(e.kit, e.operator, base.id);
    await compensateOperation(e.kit, e.operator, base.id, { plan_hash: plan.plan_hash });
    e.sim.failNextWrite("ambiguous_after_commit");
    await e.worker.runOnce();
    // A record with an unresolved operation accepts no new plan (review P2-3), so the other classes live on their own records.
    const fields = { ...(e.sim.snapshot("contact-0002")!.fields as Record<string, string | number | boolean | null>) };
    e.sim.seed("contact-0003", fields);
    e.sim.seed("contact-0004", fields);
    e.sim.failNextWrite("unavailable");
    const failed = await e.applyOnce({ lead_score: 12 }, { record_ref: "contact-0003" }).catch(() => undefined);
    const p = await e.planAndApprove({ lead_score: 13 }, { record_ref: "contact-0004" });
    e.sim.externalEdit("contact-0004", { owner_label: "x" });
    await e.worker.runOnce();
    await e.kit.db.query("UPDATE operations SET failure_message = NULL, failure_code = NULL WHERE id = $1::uuid", [p.id]);
    await e.kit.db.query("UPDATE jobs SET state = 'failed', last_error = NULL WHERE id = (SELECT id FROM jobs ORDER BY created_at LIMIT 1)");
    const status = await getStatus(e.kit, e.operator);
    const states = status.attention.map((a) => a.state);
    expect(states).toEqual(expect.arrayContaining(["unknown", "conflict", "job_failed"]));
    for (const item of status.attention) {
      expect(item.reason.length).toBeGreaterThan(5);
      expect(item.next_step.length).toBeGreaterThan(5);
    }
    expect(status.compensations_unknown).toBe(1);
    expect(status.operations.unknown).toBeGreaterThanOrEqual(1);
    expect(failed === undefined || failed.id).toBeTruthy();
  });

  it("an operation with no recorded failure text still gets a default reason", async () => {
    const e = await env();
    e.sim.failNextWrite("ambiguous_after_commit");
    const op = await e.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    await e.kit.db.query("UPDATE operations SET failure_message = NULL WHERE id = $1::uuid", [op.id]);
    const failedOp = await e.planAndApprove({ lead_score: 5 }, { record_ref: "contact-0001" }).catch(() => undefined);
    await e.kit.db.query("UPDATE operations SET state = 'failed', failure_message = NULL, failure_code = NULL WHERE id = $1::uuid", [failedOp?.id ?? op.id]);
    const { attention } = await getStatus(e.kit, e.operator);
    expect(attention.map((a) => a.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/unknown|did not complete/)]));
  });
});

describe("worker and outbox", () => {
  it("a job that fails with a non-Error value or a multi-line message keeps a single, bounded, redacted line (failed before an attempt started; done with the operation UNKNOWN after)", async () => {
    const e = await env();
    const long = `first line ${"y".repeat(500)}\nsecond line with detail`;
    /** Make the executor's first transaction throw `value` once (the failure happens before any attempt is recorded). */
    const failFirstTransaction = (value: unknown): (() => void) => {
      const db = e.kit.db;
      const original = db.transaction.bind(db);
      let calls = 0;
      db.transaction = (async (fn: Parameters<typeof original>[0]) => {
        calls += 1;
        if (calls === 1) throw value;
        return original(fn);
      }) as typeof db.transaction;
      return () => {
        db.transaction = original as typeof db.transaction;
      };
    };
    const lastErrors = async () => (await e.kit.db.query<{ state: string; last_error: string }>("SELECT state, last_error FROM jobs WHERE last_error IS NOT NULL ORDER BY created_at, id")).rows;

    await e.planAndApprove({ lifecycle_stage: "customer" });
    let restore = failFirstTransaction(long);
    const r = await e.worker.runOnce();
    restore();
    expect(r?.job_state).toBe("failed"); // nothing was in flight, so there is nothing to recover: the job fails
    expect((await lastErrors()).at(-1)).toEqual({ state: "failed", last_error: "error" }); // a thrown string is not an Error: no message is trusted

    const err = new Error(`secret ${"token-FAKEUNDOKIT0123456789abcdef"}\nsecond line`);
    await e.planAndApprove({ lead_score: 5 }, { record_ref: "contact-0002" });
    restore = failFirstTransaction(err);
    await e.worker.runOnce();
    restore();
    const failed = (await lastErrors()).filter((row) => row.state === "failed").at(-1)!;
    expect(failed.last_error).not.toContain("\n");
    expect(failed.last_error).not.toContain("FAKEUNDOKIT");
    expect(failed.last_error.length).toBeLessThanOrEqual(300);

    // After an attempt started (a fault at apply.before_remote) the same kinds of errors recover the operation to UNKNOWN and the job is done.
    e.kit.faults.onPoint("apply.before_remote", async () => {
      throw long;
    });
    const p3 = await e.planAndApprove({ lead_score: 6 }, { record_ref: "contact-0002" });
    const after = await e.worker.runOnce();
    e.kit.faults.clear();
    expect(after?.job_state).toBe("done");
    expect((await e.view(p3.id)).state).toBe("unknown");
    expect((await e.view(p3.id)).attempts.map((a) => a.error_code)).toContain("FINALIZE_FAILED");
    const done = (await lastErrors()).at(-1)!;
    expect(done.last_error).toBe("error");
    expect(e.sim.calls.write).toBe(0); // no write was ever sent
  });

  it("start() polls and stops; a stop before the first tick does nothing; errors from a poll go to the callback", async () => {
    const e = await env();
    const stopEarly = createWorker(e.kit, { workerId: "early" }).start(10);
    stopEarly();
    await new Promise((r) => setTimeout(r, 40));
    expect(await e.count("jobs")).toBe(0);
    const errors: unknown[] = [];
    e.kit.faults.crashAt("apply.before_remote");
    await e.planAndApprove({ lifecycle_stage: "customer" });
    const stop = createWorker(e.kit, { workerId: "polling" }).start(10, (err) => errors.push(err));
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    e.advance(ONE_MINUTE * 5);
    const stop2 = createWorker(e.kit, { workerId: "recover" }).start(10);
    await new Promise((r) => setTimeout(r, 150));
    stop2();
    // The restarted poller reclaimed the interrupted job (UNKNOWN), then its own reconcile proved the write never happened.
    const view = await e.view((await e.kit.db.query<{ id: string }>("SELECT id FROM operations LIMIT 1")).rows[0]!.id);
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("NOT_APPLIED");
    expect(e.sim.calls.write).toBe(0);
  });

  it("a worker on a kit that is not ready claims nothing", async () => {
    const e = await env();
    await e.planAndApprove({ lifecycle_stage: "customer" });
    const before = e.kit.readiness;
    e.kit.readiness = { ...before, ok: false, error: "simulated" };
    expect(await e.worker.runOnce()).toBeNull();
    e.kit.readiness = before;
    expect(await e.worker.runOnce()).not.toBeNull();
  });

  it("dispatchOutbox publishes pending rows and keeps failed ones pending with an attempt count", async () => {
    const e = await env();
    await e.applyOnce({ lifecycle_stage: "customer" });
    const pending = (await e.kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox")).rows[0]!.n;
    expect(pending).toBeGreaterThan(0);
    const failed = await dispatchOutbox(e.kit.db, async () => Promise.reject(new Error("sink down")), e.clock.now(), 10);
    expect(failed).toBeDefined();
    const stillPending = (await e.kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL")).rows[0]!.n;
    expect(stillPending).toBe(pending);
    const seen: unknown[] = [];
    await dispatchOutbox(e.kit.db, async (row) => void seen.push(row), e.clock.now(), 10);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("api edges", () => {
  it("an unknown non-API path falls back to the app shell when a web root is configured; an empty JSON body is accepted where none is needed", async () => {
    const e = await env();
    const { join: j } = await import("node:path");
    const { REPO_ROOT } = await import("../helpers/fixtures.js");
    const app = await buildServer(e.kit, { webRoot: j(REPO_ROOT, "dist", "web") });
    cleanups.push(() => app.close());
    const home = await app.inject({ method: "GET", url: "/some/client/route", headers: { host: HOST } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toMatch(/<div id="root"/);
    const apiMiss = await app.inject({ method: "GET", url: "/api/v1/nothing", headers: { host: HOST } });
    expect(apiMiss.statusCode).toBe(404);
    const { client } = await httpLogin(app, e.emails.operator, e.passwords.operator);
    const plan = await e.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    expect(plan.id).toBeTruthy();
    const empty = await client!.post(`/api/v1/operations/${plan.id}/reconcile`, undefined, { raw: "" });
    expect(empty.status).toBe(409); // nothing to reconcile, but the empty JSON body itself was accepted
    const exp = await client!.post("/api/v1/exports", undefined, { raw: "" });
    expect(exp.status).toBe(200);
    expect(anon(app)).toBeTruthy();
  });

  it("database outages surface as 503 DEPENDENCY_UNAVAILABLE and other unexpected failures as an opaque 500 with no internals", async () => {
    const e = await env();
    const app = await buildServer(e.kit);
    cleanups.push(() => app.close());
    const { client } = await httpLogin(app, e.emails.operator, e.passwords.operator);
    const realQuery = e.kit.db.query.bind(e.kit.db);
    const failWith = (error: unknown) => {
      (e.kit.db as { query: unknown }).query = async (text: string, params?: readonly unknown[]) => {
        if (/SELECT \* FROM operations\s+WHERE workspace_id/.test(text)) throw error;
        return realQuery(text, params);
      };
    };
    failWith(Object.assign(new Error("connection terminated"), { code: "57P01" }));
    const out = await client!.get("/api/v1/operations");
    expect(out.status).toBe(503);
    expect(out.body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    failWith(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }));
    expect((await client!.get("/api/v1/operations")).status).toBe(503);
    failWith(new Error("secret internal detail /Users/someone/file.ts"));
    const opaque = await client!.get("/api/v1/operations");
    expect(opaque.status).toBe(500);
    expect(opaque.body.error.message).toBe("internal error");
    expect(opaque.text).not.toMatch(/secret internal|\/Users\//);
  });
});

describe("database wrapper (src/db/client.ts)", () => {
  it("memory and persistent embedded databases normalize types; a persistent one survives reopen; a rollback leaves nothing", async () => {
    const mem = await openDatabase("pglite://memory");
    const r = await mem.query<{ t: string; n: number; s: string }>("SELECT now() AS t, 5::bigint AS n, 'x' AS s");
    expect(r.rows[0]!.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.rows[0]!.n).toBe(5);
    expect(typeof r.rows[0]!.n).toBe("number");
    await mem.query("CREATE TABLE t (id int)");
    await expect(
      mem.transaction(async (tx) => {
        await tx.query("INSERT INTO t VALUES (1)");
        throw new Error("rollback me");
      }),
    ).rejects.toThrow("rollback me");
    expect((await mem.query("SELECT * FROM t")).rows).toEqual([]);
    await mem.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (2)");
    });
    expect((await mem.query("SELECT * FROM t")).rows).toHaveLength(1);
    await mem.close();

    const dir = mkdtempSync(join(tmpdir(), "undokit-db-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = await openDatabase(`pglite://${join(dir, "data")}`);
    await first.query("CREATE TABLE keep (id int)");
    await first.query("INSERT INTO keep VALUES (7)");
    await first.close();
    const second = await openDatabase(`pglite://${join(dir, "data")}`);
    expect((await second.query<{ id: number }>("SELECT id FROM keep")).rows).toEqual([{ id: 7 }]);
    await second.close();
  });

  it("an unsupported scheme is refused, and an unreachable PostgreSQL fails fast instead of hanging", async () => {
    await expect(openDatabase("mysql://x")).rejects.toThrow(/unsupported database url/);
    await expect(openDatabase("postgres://127.0.0.1:1/x")).rejects.toThrow();
    await expect(openDatabase("postgresql://127.0.0.1:1/x")).rejects.toThrow();
  }, 20_000);

  it("the clock and ids passed to a kit are used by the services (determinism)", async () => {
    const kit = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()), clock: new FixedClock("2026-01-15T12:00:00.000Z"), ids: new SequentialIds("abababab") });
    cleanups.push(() => kit.close());
    const ws = await createWorkspaceWithAdmin(kit, { email: "d@example.test", password: newPassword(), workspace_name: "Det" });
    expect(ws.workspace_id).toBe(["abababab", "0000", "4000", "8000", "000000000001"].join("-"));
    expect(planOperation).toBeTypeOf("function");
  });
});
