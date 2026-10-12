// Regressions for the independent review's fixes (QA-owned): P2-2 no silent new key over existing data, P2-1 opt-in proxy trust for TLS
// reverse proxies, minimum lease / approval lifetime / poll interval. Each is a behavior test; revert controls are recorded in the matrix.
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, FixedClock, KeyRing, approveOperation, buildServer, createCompensationPlan, compensateOperation, createUndoKit, createWorkspaceWithAdmin, databaseHasData, loadConfig, openDatabase, planOperation, requestReconcile, startServer, type ServerConfig } from "../../src/index.js";
import { LoginRateLimiter } from "../../src/services/ratelimit.js";
import { quietPeriodMs } from "../../src/config.js";
import { cli } from "../helpers/cli-ctx.js";
import { makeEnv, newPassword, rejection, type Env } from "../helpers/kit.js";

const scratch: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "undokit-review-"));
  scratch.push(d);
  return d;
};
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

const writeKey = (path: string, text: string): void => writeFileSync(path, text, { mode: 0o600 });

/** A real file-backed database that already holds a workspace, encrypted under `keyText`. */
async function populated(dir: string, keyText: string): Promise<{ keyPath: string; databaseUrl: string }> {
  const keyPath = join(dir, "undokit.key");
  writeKey(keyPath, keyText);
  const databaseUrl = `pglite://${dir}/db`;
  const kit = await createUndoKit({ databaseUrl, keyring: KeyRing.fromBase64(keyText) });
  await createWorkspaceWithAdmin(kit, { email: "key-admin@example.test", password: newPassword(), workspace_name: "Existing Data" });
  await kit.close();
  return { keyPath, databaseUrl };
}
const serverConfig = (databaseUrl: string, keyFile: string): ServerConfig => ({ ...loadConfig({}), databaseUrl, keyFile, host: "127.0.0.1", port: 0, runWorker: false });

describe("P2-2: serve never mints a new encryption key over a database that already holds data", () => {
  it("a missing key file with existing data is refused with an actionable message and no key file is created", async () => {
    const dir = tmp();
    const { keyPath, databaseUrl } = await populated(dir, KeyRing.generateKeyText());
    rmSync(keyPath);
    await expect(startServer(serverConfig(databaseUrl, keyPath))).rejects.toThrow(/already contains data/);
    expect(existsSync(keyPath), "nothing was minted").toBe(false);
  }, 60_000);

  it("the same refusal through the CLI: nonzero exit, the message names the problem, no key file, and the data directory lock is released", async () => {
    const dir = join(tmp(), "data");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const { keyPath } = await populated(dir, KeyRing.generateKeyText());
    rmSync(keyPath);
    const r = await cli(["serve", "--port", "0", "--data-dir", dir]);
    expect(r.code).not.toBe(0);
    expect(`${r.err}${r.out}`).toMatch(/already contains data/);
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(join(dir, "db.lock"))).toBe(false);
  }, 60_000);

  it("with the original key in place the same database starts; a brand-new empty directory still mints a key owner-only", async () => {
    const dir = tmp();
    const text = KeyRing.generateKeyText();
    const { keyPath, databaseUrl } = await populated(dir, text);
    const running = await startServer(serverConfig(databaseUrl, keyPath));
    await running.close();
    const fresh = tmp();
    const freshKey = join(fresh, "undokit.key");
    const second = await startServer(serverConfig(`pglite://${fresh}/db`, freshKey));
    await second.close();
    expect(existsSync(freshKey)).toBe(true);
    expect(statSync(freshKey).mode & 0o777).toBe(0o600);
  }, 90_000);

  it("UNDOKIT_ENCRYPTION_KEY (explicit key in the environment) is not subject to the file check", async () => {
    const dir = tmp();
    const text = KeyRing.generateKeyText();
    const { keyPath, databaseUrl } = await populated(dir, text);
    rmSync(keyPath);
    const running = await startServer({ ...serverConfig(databaseUrl, keyPath), keyBase64: text });
    await running.close();
    expect(existsSync(keyPath)).toBe(false);
  }, 60_000);
});

describe("P2-1: forwarded headers are trusted only when the operator opts in (UNDOKIT_TRUST_PROXY=1)", () => {
  let env: Env | undefined;
  afterEach(async () => {
    await env?.close();
    env = undefined;
  });

  const login = async (e: Env, opts: { trustProxy?: boolean }, headers: Record<string, string>) => {
    const app = await buildServer(e.kit, { cookieSecure: true, ...opts });
    try {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { host: "undokit.test", ...headers }, payload: { email: e.emails.operator, password: e.passwords.operator } });
      return { status: res.statusCode, code: (JSON.parse(res.body) as { error?: { code?: string } }).error?.code };
    } finally {
      await app.close();
    }
  };
  const proxied = { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.test", origin: "https://app.example.test" };

  it("default (off): a browser behind a TLS proxy is refused with CSRF_FAILED, and forged forwarded headers cannot make a foreign Origin acceptable", async () => {
    env = await makeEnv();
    expect(await login(env, {}, proxied)).toEqual({ status: 403, code: "CSRF_FAILED" });
    expect(await login(env, {}, { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example.test", origin: "https://evil.example.test" })).toEqual({ status: 403, code: "CSRF_FAILED" });
    expect((await login(env, {}, { origin: "http://undokit.test" })).status, "a direct same-origin browser still works").toBe(200);
  }, 60_000);

  it("opted in: the same proxied request logs in; a mismatching Origin, scheme or host is still refused; a direct request still works", async () => {
    env = await makeEnv();
    expect((await login(env, { trustProxy: true }, proxied)).status).toBe(200);
    expect(await login(env, { trustProxy: true }, { ...proxied, origin: "https://evil.example.test" })).toEqual({ status: 403, code: "CSRF_FAILED" });
    expect(await login(env, { trustProxy: true }, { ...proxied, origin: "http://app.example.test" })).toEqual({ status: 403, code: "CSRF_FAILED" }); // scheme differs from the forwarded one
    expect((await login(env, { trustProxy: true }, { origin: "http://undokit.test" })).status).toBe(200);
  }, 60_000);

  it("UNDOKIT_TRUST_PROXY is off by default; 1 or true means one proxy hop, N means N hops, a list names trusted proxies, and nothing means 'trust every hop'", () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    for (const v of ["", "0", "false", "off", "no", " 0 "]) expect(loadConfig({ UNDOKIT_TRUST_PROXY: v }).trustProxy, `"${v}"`).toBe(false);
    for (const v of ["1", "true", "yes", "on"]) expect(loadConfig({ UNDOKIT_TRUST_PROXY: v }).trustProxy, v).toBe(1);
    expect(loadConfig({ UNDOKIT_TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ UNDOKIT_TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }).trustProxy).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(() => loadConfig({ UNDOKIT_TRUST_PROXY: "10.0.0.1,,10.0.0.2" })).toThrow(/UNDOKIT_TRUST_PROXY must be 0, a hop count/);
  });

  it("a forged leftmost X-Forwarded-For cannot dodge the login lockout: only the entry the declared proxy appended is the client address", async () => {
    env = await makeEnv();
    const e = env;
    const app = await buildServer(e.kit, { trustProxy: true }); // one declared hop
    try {
      const attempt = async (i: number) =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          remoteAddress: "10.0.0.1", // the proxy
          headers: { host: "undokit.test", origin: "http://undokit.test", "x-forwarded-for": `6.6.6.${i}, 203.0.113.9` }, // the client forged the first entry; the proxy appended the second
          payload: { email: e.emails.operator, password: "wrong-password-for-lockout" },
        });
      const statuses: number[] = [];
      for (let i = 1; i <= e.kit.config.loginMaxFailures + 2; i += 1) statuses.push((await attempt(i)).statusCode);
      expect(statuses.slice(0, e.kit.config.loginMaxFailures).every((c) => c === 401)).toBe(true);
      expect(statuses.slice(e.kit.config.loginMaxFailures), "locked out despite a different forged address each time").toEqual([429, 429]);
    } finally {
      await app.close();
    }
  }, 120_000);
});

describe("minimum lease, approval lifetime and poll interval", () => {
  it("values below the minimum are refused with the variable name and the minimum; the minimum itself is accepted", () => {
    expect(() => loadConfig({ UNDOKIT_LEASE_SECONDS: "0" })).toThrow(/UNDOKIT_LEASE_SECONDS must be a number of at least 5/);
    expect(() => loadConfig({ UNDOKIT_LEASE_SECONDS: "4" })).toThrow(/at least 5/);
    expect(() => loadConfig({ UNDOKIT_APPROVAL_TTL_SECONDS: "0" })).toThrow(/UNDOKIT_APPROVAL_TTL_SECONDS must be a number of at least 60/);
    expect(() => loadConfig({ UNDOKIT_APPROVAL_TTL_SECONDS: "59" })).toThrow(/at least 60/);
    expect(() => loadConfig({ UNDOKIT_WORKER_POLL_MS: "9" })).toThrow(/UNDOKIT_WORKER_POLL_MS must be a number of at least 10/);
    const ok = loadConfig({ UNDOKIT_LEASE_SECONDS: "5", UNDOKIT_APPROVAL_TTL_SECONDS: "60", UNDOKIT_WORKER_POLL_MS: "10" });
    expect([ok.service.leaseMs, ok.service.approvalTtlMs, ok.workerPollMs]).toEqual([5000, 60_000, 10]);
    expect(() => loadConfig({ UNDOKIT_LEASE_SECONDS: "abc" })).toThrow();
  });
});

describe("P2-3: no new change on a record that has an unresolved operation", () => {
  let env: Env | undefined;
  afterEach(async () => {
    await env?.close();
    env = undefined;
  });
  const REF = "contact-0002";
  const request = (e: Env, patch: Record<string, unknown>, key: string) =>
    planOperation(e.kit, e.operator, { connector_id: e.connectorId, record_ref: REF, patch, expected_version: e.sim.snapshot(REF)!.version }, key);

  it("planning on a record with an UNKNOWN operation is refused with a typed 409; another record is fine; after reconciliation the record is plannable again", async () => {
    env = await makeEnv();
    const e = env;
    e.sim.failNextWrite("ambiguous_before_commit"); // the request was lost before the commit: the record stays untouched
    const unknown = await e.applyOnce({ lifecycle_stage: "customer" }, { record_ref: REF });
    expect((await e.view(unknown.id)).state).toBe("unknown");
    // Without the guard, a second change with the same value would land and reconciliation would then credit it to the first operation.
    let err: unknown;
    try {
      await request(e, { lifecycle_stage: "customer" }, "k-blocked");
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("UNRESOLVED_OPERATION");
    expect((err as AppError).status).toBe(409);
    expect((err as AppError).message).toContain(unknown.id);
    expect(await e.count("operations")).toBe(1); // nothing was stored for the refused plan
    expect(e.sim.calls.write).toBe(1);

    await expect(e.plan({ lead_score: 5 }, { record_ref: "contact-0001" })).resolves.toBeTruthy(); // other records are unaffected

    e.advance(quietPeriodMs(e.kit.config));
    await requestReconcile(e.kit, e.operator, unknown.id);
    await e.worker.drain();
    expect((await e.view(unknown.id)).state).toBe("failed"); // reconciled as not applied
    await expect(request(e, { lifecycle_stage: "customer" }, "k-after")).resolves.toBeTruthy();
  }, 60_000);

  it("approving a second plan is refused while the first operation on the same record is unresolved, and the plan stays planned", async () => {
    env = await makeEnv();
    const e = env;
    const second = await e.plan({ lead_score: 7 }, { record_ref: REF }); // planned before the first one went wrong
    e.sim.failNextWrite("ambiguous_before_commit"); // the record keeps its version, so only the guard can refuse the approval
    const first = await e.applyOnce({ lifecycle_stage: "customer" }, { record_ref: REF });
    expect((await e.view(first.id)).state).toBe("unknown");
    const version = e.sim.snapshot(REF)!.version;
    const err = await rejection(() => approveOperation(e.kit, e.operator, second.id, { plan_hash: second.plan_hash, expected_version: version }));
    expect(err.code).toBe("UNRESOLVED_OPERATION");
    expect((await e.view(second.id)).state).toBe("planned");
    expect(e.sim.calls.write).toBe(1);
  }, 60_000);

  it("an UNKNOWN compensation on the record blocks new plans too", async () => {
    env = await makeEnv();
    const e = env;
    const applied = await e.applyOnce({ lifecycle_stage: "customer" }, { record_ref: REF });
    const plan = await createCompensationPlan(e.kit, e.operator, applied.id);
    await compensateOperation(e.kit, e.operator, applied.id, { plan_hash: plan.plan_hash });
    e.sim.failNextWrite("ambiguous_after_commit");
    await e.worker.runOnce();
    const err = await rejection(() => request(e, { lead_score: 9 }, "k-comp-blocked"));
    expect(err.code).toBe("UNRESOLVED_OPERATION");
  }, 60_000);
});

describe("P3-6: the login rate limiter is bounded", () => {
  it("unique keys cannot grow it without limit, and a key that is currently locked out stays locked", () => {
    const limiter = new LoginRateLimiter(new FixedClock("2026-01-15T12:00:00.000Z"), 3, 15 * 60 * 1000);
    for (let i = 0; i < 25_000; i += 1) limiter.recordFailure(`ip|user-${i}@example.test`);
    const tracked = (limiter as unknown as { failures: Map<string, number[]> }).failures.size;
    expect(tracked).toBeLessThanOrEqual(10_000);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("ip|locked@example.test");
    expect(limiter.blocked("ip|locked@example.test")).toBe(true);
  });
});

describe("P3-1: a flood of unique keys cannot reset a live lockout; P3-8: databaseHasData never creates anything", () => {
  it("a locked-out key survives a flood of unique one-failure keys larger than the cap", () => {
    const limiter = new LoginRateLimiter(new FixedClock("2026-01-15T12:00:00.000Z"), 3, 15 * 60 * 1000);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("ip|victim-lockout@example.test");
    expect(limiter.blocked("ip|victim-lockout@example.test")).toBe(true);
    for (let i = 0; i < 12_000; i += 1) limiter.recordFailure(`ip|flood-${i}@example.test`); // oldest-first eviction would drop the locked key first
    expect(limiter.blocked("ip|victim-lockout@example.test"), "the lockout is not reset by the flood").toBe(true);
  });

  it("databaseHasData is false for a missing or uninitialised PGlite directory and creates nothing there", async () => {
    const dir = join(tmp(), "never-created");
    expect(await databaseHasData(`pglite://${dir}`)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(await databaseHasData("memory://")).toBe(false);
  });
});

describe("P3-5: a PostgreSQL pool error on an idle client does not crash the process", () => {
  it("openDatabase registers an 'error' listener on the pool (an unhandled 'error' event would throw)", async () => {
    class FakePool extends EventEmitter {
      query = async () => ({ rows: [{ "?column?": 1 }], rowCount: 1 });
      end = async () => undefined;
    }
    let made: FakePool | undefined;
    const spy = vi.spyOn(pg, "Pool").mockImplementation(function () {
      made = new FakePool();
      return made;
    } as never);
    try {
      const db = await openDatabase("postgres://127.0.0.1:1/placeholder");
      expect(made?.listenerCount("error")).toBeGreaterThan(0);
      expect(() => made!.emit("error", new Error("idle client lost the connection"))).not.toThrow();
      await db.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("P2-1b: a failed reconcile job never blocks reconciliation forever", () => {
  let env: Env | undefined;
  afterEach(async () => {
    await env?.close();
    env = undefined;
  });

  it("when the queued reconcile job fails once (a transient database error), requesting reconciliation again re-queues it and resolves the operation, with one write in total", async () => {
    env = await makeEnv();
    const e = env;
    e.sim.failNextWrite("ambiguous_after_commit");
    const op = await e.applyOnce({ lifecycle_stage: "customer" });
    expect((await e.view(op.id)).state).toBe("unknown");
    const reconcileJobs = async () => (await e.kit.db.query<{ id: string; state: string; last_error: string | null }>("SELECT id, state, last_error FROM jobs WHERE kind = 'reconcile' ORDER BY created_at, id")).rows;
    await requestReconcile(e.kit, e.operator, op.id); // the operator asks for reconciliation
    expect((await reconcileJobs()).map((j) => j.state)).toEqual(["queued"]);

    // The first run of the reconcile job dies on a transient database error before it reads the provider.
    const db = e.kit.db;
    const original = db.transaction.bind(db);
    let calls = 0;
    db.transaction = (async (fn: Parameters<typeof original>[0]) => {
      calls += 1;
      if (calls === 1) throw new Error("transient database error");
      return original(fn);
    }) as typeof db.transaction;
    const ran = await e.worker.runOnce();
    db.transaction = original as typeof db.transaction;
    expect(ran?.job_state).toBe("failed");
    const [dead] = await reconcileJobs();
    expect(dead?.state).toBe("failed");
    expect((await e.view(op.id)).state).toBe("unknown");

    await requestReconcile(e.kit, e.operator, op.id); // the operator asks again after the failure
    const after = await reconcileJobs();
    expect(after.map((j) => j.id), "the same job is re-queued, not a duplicate").toEqual([dead!.id]);
    expect(after[0]?.state).toBe("queued");
    await e.worker.drain();
    expect((await e.view(op.id)).state).toBe("applied");
    expect(e.sim.calls.write).toBe(1); // reconciliation never writes
  }, 60_000);
});
