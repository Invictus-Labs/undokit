// AC-08 (offline, no telemetry, explicit failure when a live connector is not connected) for the DAEMON path (QA-owned).
// The demo path is covered in cli-packaged.test.ts. Real process, real sockets, outbound-denied harness with a negative control.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, checkConnector, createConnector, planOperation } from "../../src/index.js";
import { createPackagedCli } from "../helpers/cli.js";
import { REPO_ROOT } from "../helpers/fixtures.js";
import { makeEnv, rejection } from "../helpers/kit.js";

const DENY = join(REPO_ROOT, "tests", "helpers", "deny-outbound.cjs");
const procs: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null) {
      p.kill("SIGKILL");
      await new Promise((r) => p.once("exit", r));
    }
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|css|json|map)$/.test(e.name) && !e.name.endsWith(".map")) out.push(p);
  }
  return out;
}

describe("AC-08 no outbound references or telemetry in the shipped code", () => {
  it("every URL literal in the built server and web UI is a namespace, a schema id, error-message text, or localhost", () => {
    const allowed = [/^http:\/\/www\.w3\.org\//, /^https:\/\/json-schema\.org\//, /^https:\/\/undokit\.local\//, /^https:\/\/react\.dev\/errors/, /^http:\/\/localhost(:\d+)?/, /^http:\/\/127\.0\.0\.1/];
    const offenders: string[] = [];
    for (const root of ["dist/src", "dist/web"]) {
      const dir = join(REPO_ROOT, root);
      expect(existsSync(dir), `${root} must be built`).toBe(true);
      for (const file of walk(dir)) {
        for (const m of readFileSync(file, "utf8").matchAll(/https?:\/\/[A-Za-z0-9._:/?#@!$&'()*+,;=%~-]+/g)) {
          if (!allowed.some((re) => re.test(m[0]))) offenders.push(`${file.replace(REPO_ROOT, "")}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no telemetry, analytics or error-reporting package is a runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const banned = /sentry|datadog|newrelic|segment|mixpanel|amplitude|posthog|rollbar|bugsnag|opentelemetry|google-analytics|gtag|telemetry|analytics/i;
    expect(Object.keys(pkg.dependencies).filter((d) => banned.test(d))).toEqual([]);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

describe("AC-08 the daemon makes zero outbound connection attempts through a full apply and compensation", () => {
  it("under the outbound-denied harness, a bootstrapped daemon serves a complete plan, approve, apply, compensate flow and records no attempt", async () => {
    const c = createPackagedCli();
    const password = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}Zz9`;
    const email = "offline-admin@example.test";
    expect(c.run(["admin", "bootstrap", "--email", email, "--password-stdin", "--data-dir", "./data"], { input: `${password}\n` }).status).toBe(0);
    const log = join(c.workdir, "deny.log");
    const port = await freePort();
    const proc = spawn(process.execPath, [c.executable, "serve", "--port", String(port), "--data-dir", "./data"], {
      cwd: c.workdir,
      env: { PATH: process.env.PATH ?? "", HOME: join(c.workdir, "home"), TMPDIR: c.workdir, NO_COLOR: "1", UNDOKIT_WORKER_POLL_MS: "50", NODE_OPTIONS: `--require "${DENY}"`, UNDOKIT_DENY_LOG: log },
    });
    procs.push(proc);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i += 1) {
      try {
        if ((await fetch(`${base}/api/v1/health`)).ok) break;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}, cookie = "", csrf = "") => {
      const res = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as any) : undefined, headers: res.headers };
    };
    const login = await call("POST", "/api/v1/auth/login", { email, password });
    expect(login.status, out).toBe(200);
    const cookie = /undokit_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
    const csrf = login.json.csrf_token as string;
    const conn = await call("POST", "/api/v1/connectors", { kind: "simulator", name: "offline-sim", policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32 }], record_prefixes: ["contact-"] }, config: { seed_records: [{ record_ref: "contact-0001", fields: { lifecycle_stage: "lead" } }] } }, {}, cookie, csrf);
    const plan = await call("POST", "/api/v1/operations", { connector_id: conn.json.id, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" }, { "idempotency-key": "offline-1" }, cookie, csrf);
    expect(plan.status).toBe(201);
    await call("POST", `/api/v1/operations/${plan.json.id}/approve`, { plan_hash: plan.json.plan_hash, expected_version: "sim-v1" }, {}, cookie, csrf);
    for (let i = 0; i < 100; i += 1) {
      if ((await call("GET", `/api/v1/operations/${plan.json.id}`, undefined, {}, cookie)).json.state === "applied") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await call("GET", `/api/v1/operations/${plan.json.id}`, undefined, {}, cookie)).json.state).toBe("applied");
    const cp = await call("POST", `/api/v1/operations/${plan.json.id}/compensation-plans`, {}, {}, cookie, csrf);
    expect((await call("POST", `/api/v1/operations/${plan.json.id}/compensate`, { plan_hash: cp.json.plan_hash }, {}, cookie, csrf)).status).toBe(202);
    for (let i = 0; i < 100; i += 1) {
      if ((await call("GET", `/api/v1/operations/${plan.json.id}/compensations`, undefined, {}, cookie)).json[0]?.state === "compensated") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await call("GET", `/api/v1/operations/${plan.json.id}/compensations`, undefined, {}, cookie)).json[0]?.state).toBe("compensated");
    expect(existsSync(log) && statSync(log).size > 0 ? readFileSync(log, "utf8") : "", "outbound attempts recorded by the harness").toBe("");
    expect(out).not.toMatch(/UNDOKIT_OUTBOUND_DENIED/);
  }, 90_000);
});

describe("AC-08 negative control: the outbound-denied harness is really active inside the daemon process", () => {
  it("a connector check against an operator-allowlisted external address is attempted, recorded and denied (so an empty log elsewhere is meaningful)", async () => {
    const c = createPackagedCli();
    const password = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}Zz9`;
    const email = "control-admin@example.test";
    expect(c.run(["admin", "bootstrap", "--email", email, "--password-stdin", "--data-dir", "./data"], { input: `${password}\n` }).status).toBe(0);
    const log = join(c.workdir, "deny.log");
    const port = await freePort();
    const proc = spawn(process.execPath, [c.executable, "serve", "--port", String(port), "--data-dir", "./data"], {
      cwd: c.workdir,
      env: { PATH: process.env.PATH ?? "", HOME: join(c.workdir, "home"), TMPDIR: c.workdir, NO_COLOR: "1", UNDOKIT_ALLOWED_HOSTS: "127.0.0.1,localhost,::1,203.0.113.9", NODE_OPTIONS: `--require "${DENY}"`, UNDOKIT_DENY_LOG: log },
    });
    procs.push(proc);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i += 1) {
      try {
        if ((await fetch(`${base}/api/v1/health`)).ok) break;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const csrf = ((await login.json()) as { csrf_token: string }).csrf_token;
    const cookie = /undokit_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
    const headers = { "content-type": "application/json", cookie, "x-csrf-token": csrf };
    const created = await fetch(`${base}/api/v1/connectors`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "couchdb", name: "external-probe", policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32 }], record_prefixes: ["contact-"] }, config: { base_url: "http://203.0.113.9:5984", database: "crm", timeout_ms: 1500 }, credentials: { username: "u", password: "p-placeholder" } }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const check = await fetch(`${base}/api/v1/connectors/${id}/check`, { method: "POST", headers, body: "{}" });
    expect(check.status).toBe(503); // refused by the harness, surfaced as an explicit unavailable error
    expect(readFileSync(log, "utf8")).toContain("203.0.113.9");
  }, 60_000);
});

describe("AC-08 a live connector that is not connected fails explicitly and never falls back to the simulator", () => {
  it("an unreachable CouchDB connector: the check is 503 CONNECTOR_UNAVAILABLE, planning is refused with the same code, nothing is stored and no simulator is touched", async () => {
    const e = await makeEnv();
    try {
      const closedPort = await freePort(); // nothing listens here
      const live = await createConnector(e.kit, e.admin, {
        kind: "couchdb",
        name: "down-couch",
        policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32 }], record_prefixes: ["contact-"] },
        config: { base_url: `http://127.0.0.1:${closedPort}`, database: "crm", timeout_ms: 1000 },
        credentials: { username: "sandbox-admin", password: "placeholder-not-a-real-password" },
      });
      expect(live.live).toBe(true);
      const check = await rejection(() => checkConnector(e.kit, e.admin, live.id));
      expect(check.code).toBe("CONNECTOR_UNAVAILABLE");
      expect(check.status).toBe(503);
      const plan = await rejection(() => planOperation(e.kit, e.operator, { connector_id: live.id, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "1-abc" }, "live-down-1"));
      expect(plan.code).toBe("CONNECTOR_UNAVAILABLE");
      expect(plan.status).toBe(503);
      expect(await e.count("operations")).toBe(0);
      expect(await e.count("idempotency_keys")).toBe(0);
      expect(e.sim.calls.read + e.sim.calls.write + e.sim.calls.ping).toBe(0); // the simulator was never consulted as a fallback
      expect(plan instanceof AppError).toBe(true);
    } finally {
      await e.close();
    }
  });

  it("the credential given for a live connector never appears in the error text", async () => {
    const e = await makeEnv();
    try {
      const closedPort = await freePort();
      const secret = "placeholder-not-a-real-password-9f2c";
      const live = await createConnector(e.kit, e.admin, {
        kind: "couchdb",
        name: "down-couch-2",
        policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32 }], record_prefixes: ["contact-"] },
        config: { base_url: `http://127.0.0.1:${closedPort}`, database: "crm", timeout_ms: 1000 },
        credentials: { username: "sandbox-admin", password: secret },
      });
      const check = await rejection(() => checkConnector(e.kit, e.admin, live.id));
      expect(JSON.stringify({ m: check.message, d: check.details })).not.toContain(secret);
      const views = JSON.stringify(live);
      expect(views).not.toContain(secret);
    } finally {
      await e.close();
    }
  });

  it("a connector base URL outside the outbound allowlist is refused at creation (default: loopback only)", async () => {
    const e = await makeEnv();
    try {
      for (const base_url of ["http://203.0.113.9:5984", "http://example.test:5984", "http://169.254.169.254/latest/meta-data", "http://[fd00::1]:5984", "http://127.0.0.1.evil.test:5984"]) {
        const err = await rejection(() =>
          createConnector(e.kit, e.admin, {
            kind: "couchdb",
            name: `blocked-${base_url.length}`,
            policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32 }], record_prefixes: ["contact-"] },
            config: { base_url, database: "crm" },
            credentials: { username: "u", password: "p-placeholder" },
          }),
        );
        expect(err.status, base_url).toBeGreaterThanOrEqual(400);
        expect(err.status, base_url).toBeLessThan(500);
      }
      expect(await e.count("connectors")).toBe(1); // only the seeded simulator
    } finally {
      await e.close();
    }
  });
});
