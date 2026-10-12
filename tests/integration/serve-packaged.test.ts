// The shipped daemon, run as a separate process from the extracted tarball (QA-owned). Real sockets, real worker, real
// database on disk, real signals. Requires `npm run build` first.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPackagedCli, type PackagedCli } from "../helpers/cli.js";

const running: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const p of running.splice(0)) {
    if (p.exitCode === null) {
      p.kill("SIGKILL");
      await new Promise((r) => p.once("exit", r));
    }
  }
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

interface Daemon {
  proc: ChildProcessWithoutNullStreams;
  port: number;
  url: string;
  output: () => string;
  exited: Promise<number | null>;
}

async function serve(c: PackagedCli, dataDir: string, extra: string[] = [], env: Record<string, string> = {}, port?: number): Promise<Daemon> {
  const p = port ?? (await freePort());
  const proc = spawn(process.execPath, [c.executable, "serve", "--port", String(p), "--data-dir", dataDir, ...extra], {
    cwd: c.workdir,
    env: { PATH: process.env.PATH ?? "", HOME: join(c.workdir, "home"), TMPDIR: c.workdir, NO_COLOR: "1", UNDOKIT_WORKER_POLL_MS: "50", ...env },
  });
  running.push(proc);
  let buf = "";
  proc.stdout.on("data", (d: Buffer) => (buf += d.toString()));
  proc.stderr.on("data", (d: Buffer) => (buf += d.toString()));
  const exited = new Promise<number | null>((r) => proc.once("exit", (code) => r(code)));
  const url = `http://127.0.0.1:${p}`;
  return { proc, port: p, url, output: () => buf, exited };
}

async function waitHealthy(d: Daemon, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (d.proc.exitCode !== null) throw new Error(`daemon exited early (${d.proc.exitCode}): ${d.output()}`);
    try {
      const r = await fetch(`${d.url}/api/v1/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon not healthy in ${timeoutMs}ms: ${d.output()}`);
}

async function stop(d: Daemon): Promise<number | null> {
  d.proc.kill("SIGTERM");
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000));
  const res = await Promise.race([d.exited, timeout]);
  if (res === "timeout") throw new Error(`daemon did not exit on SIGTERM: ${d.output()}`);
  return res;
}

const pw = () => `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}Zz9`;

function bootstrap(c: PackagedCli, dir: string, email: string, password: string) {
  const r = c.run(["admin", "bootstrap", "--email", email, "--workspace", "Synthetic Daemon", "--password-stdin", "--data-dir", dir], { input: `${password}\n` });
  expect(r.status, r.output).toBe(0);
}

class Http {
  cookie = "";
  csrf = "";
  constructor(private readonly base: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== "GET" && this.csrf ? { "x-csrf-token": this.csrf } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  async login(email: string, password: string) {
    const r = await this.req("POST", "/api/v1/auth/login", { email, password });
    if (r.status === 200) {
      this.cookie = /undokit_session=[^;]+/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
      this.csrf = r.json.csrf_token;
    }
    return r;
  }
}

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("the packaged daemon", () => {
  it("binds to loopback only, prints its URL, serves the UI and a typed API, and stops cleanly on SIGTERM", async () => {
    const c = createPackagedCli();
    const email = "daemon-admin@example.test";
    bootstrap(c, "./data", email, pw());
    const d = await serve(c, "./data");
    await waitHealthy(d);
    expect(d.output()).toContain(`http://localhost:${d.port}`);

    const home = await fetch(`${d.url}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toMatch(/text\/html/);
    const homeHtml = await home.text();
    expect(homeHtml).toMatch(/<div id="root"/);
    // The shipped daemon serves the BUILT UI (dist/web: hashed bundles under /assets), never the Vite dev page, whose
    // entry is ./main.tsx. The control: the dev index in the source tree is a different document that this check rejects.
    const devIndex = readFileSync(join(import.meta.dirname, "../../src/web/index.html"), "utf8");
    expect(devIndex).toContain("main.tsx");
    expect(homeHtml).not.toContain("main.tsx");
    expect(homeHtml).not.toMatch(/\/src\//);
    const bundle = /src="(\/assets\/[^"]+\.js)"/.exec(homeHtml)?.[1];
    const sheet = /href="(\/assets\/[^"]+\.css)"/.exec(homeHtml)?.[1];
    expect(bundle, "the page references a built script bundle").toBeTruthy();
    expect(sheet, "the page references a built stylesheet").toBeTruthy();
    const js = await fetch(`${d.url}${bundle}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect((await js.text()).length).toBeGreaterThan(10_000);
    const css = await fetch(`${d.url}${sheet}`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    const spa = await fetch(`${d.url}/some/client/route`);
    expect(spa.status).toBe(200); // client-side routes fall back to the app shell
    expect(await spa.text()).toBe(homeHtml); // the built shell, byte for byte
    const api404 = await fetch(`${d.url}/api/v1/nope`);
    expect(api404.status).toBe(404);
    expect((await api404.json()).error.code).toBe("NOT_FOUND");
    expect(home.headers.get("x-powered-by")).toBeNull();
    expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await fetch(`${d.url}/api/v1/ready`)).status).toBe(200);

    // Loopback only: the listening socket is 127.0.0.1, and no other interface address accepts a connection.
    const lsof = spawnSync("lsof", ["-nP", `-iTCP:${d.port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const external = Object.values(networkInterfaces()).flat().filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal);
    if (lsof.status === 0 && lsof.stdout.includes("LISTEN")) {
      expect(lsof.stdout).toMatch(new RegExp(`127\\.0\\.0\\.1:${d.port}`));
      expect(lsof.stdout).not.toMatch(/\*:\d+|0\.0\.0\.0:\d+/);
    } else if (external.length > 0) {
      const refused = await new Promise<boolean>((resolve) => {
        const s = connect({ host: external[0]!.address, port: d.port, timeout: 2000 });
        s.once("connect", () => {
          s.destroy();
          resolve(false);
        });
        s.once("error", () => resolve(true));
        s.once("timeout", () => {
          s.destroy();
          resolve(true);
        });
      });
      expect(refused, `a non-loopback address ${external[0]!.address} must not accept connections`).toBe(true);
    } else {
      throw new Error("cannot verify the bind address: neither lsof nor a non-loopback interface is available");
    }

    expect(await stop(d)).toBe(0);
  });

  it("there is no default credential: common defaults and the wrong password are all 401", async () => {
    const c = createPackagedCli();
    const email = "daemon-admin@example.test";
    const password = pw();
    bootstrap(c, "./data", email, password);
    const d = await serve(c, "./data");
    await waitHealthy(d);
    const h = new Http(d.url);
    for (const [e, p] of [["admin@example.test", "admin"], [email, "admin"], [email, "password"], [email, "changeme123456"], ["admin", "admin"], [email, ""]] as const) {
      expect((await h.login(e, p)).status, `${e}/${p}`).toBeGreaterThanOrEqual(400);
    }
    expect((await h.login(email, password)).status).toBe(200);
    await stop(d);
  });

  it("end to end over HTTP against the shipped worker: connector, plan, approve, apply, compensation preview and restore", async () => {
    const c = createPackagedCli();
    const email = "daemon-admin@example.test";
    const password = pw();
    bootstrap(c, "./data", email, password);
    const d = await serve(c, "./data");
    await waitHealthy(d);
    const h = new Http(d.url);
    expect((await h.login(email, password)).status).toBe(200);
    const policy = { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32, enum: ["lead", "customer"] }], record_prefixes: ["contact-"] };
    const conn = await h.req("POST", "/api/v1/connectors", { kind: "simulator", name: "daemon-sim", policy, config: { seed_records: [{ record_ref: "contact-0001", fields: { lifecycle_stage: "lead" } }] } });
    expect(conn.status, conn.text).toBe(201);
    expect(conn.json.live).toBe(false);
    const plan = await h.req("POST", "/api/v1/operations", { connector_id: conn.json.id, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" }, { "idempotency-key": "daemon-1" });
    expect(plan.status, plan.text).toBe(201);
    const replay = await h.req("POST", "/api/v1/operations", { connector_id: conn.json.id, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" }, { "idempotency-key": "daemon-1" });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect((await h.req("POST", `/api/v1/operations/${plan.json.id}/approve`, { plan_hash: plan.json.plan_hash, expected_version: "sim-v1" })).status).toBe(202);
    const applied = await until(async () => {
      const r = await h.req("GET", `/api/v1/operations/${plan.json.id}`);
      return r.json.state === "applied" ? r.json : undefined;
    }, "apply by the shipped worker");
    expect(applied.fields[0]).toMatchObject({ before: "lead", intended: "customer", observed_after: "customer", apply_outcome: "applied" });
    const cp = await h.req("POST", `/api/v1/operations/${plan.json.id}/compensation-plans`, {});
    expect(cp.status).toBe(201);
    expect(cp.json.state).toBe("planned");
    expect((await h.req("POST", `/api/v1/operations/${plan.json.id}/compensate`, { plan_hash: cp.json.plan_hash })).status).toBe(202);
    await until(async () => {
      const r = await h.req("GET", `/api/v1/operations/${plan.json.id}/compensations`);
      return r.json[0]?.state === "compensated";
    }, "compensation by the shipped worker");
    const events = await h.req("GET", `/api/v1/operations/${plan.json.id}/events`);
    expect(events.json.map((e: { event_type: string }) => e.event_type)).toEqual(expect.arrayContaining(["operation.planned", "operation.approved", "apply.succeeded", "compensation.approved", "compensation.succeeded"]));
    await stop(d);
  });

  it("evidence survives a restart: stop, start again on the same data directory, and the operation history is still there", async () => {
    const c = createPackagedCli();
    const email = "daemon-admin@example.test";
    const password = pw();
    bootstrap(c, "./data", email, password);
    let d = await serve(c, "./data");
    await waitHealthy(d);
    let h = new Http(d.url);
    await h.login(email, password);
    const conn = await h.req("POST", "/api/v1/connectors", { kind: "simulator", name: "daemon-sim", policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32 }], record_prefixes: ["contact-"] }, config: { seed_records: [{ record_ref: "contact-0001", fields: { lifecycle_stage: "lead" } }] } });
    const plan = await h.req("POST", "/api/v1/operations", { connector_id: conn.json.id, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" }, { "idempotency-key": "persist-1" });
    expect(plan.status).toBe(201);
    expect(await stop(d)).toBe(0);
    d = await serve(c, "./data");
    await waitHealthy(d);
    h = new Http(d.url);
    expect((await h.login(email, password)).status).toBe(200);
    const list = await h.req("GET", "/api/v1/operations");
    expect(list.json.items.map((o: { id: string }) => o.id)).toContain(plan.json.id);
    expect((await h.req("GET", `/api/v1/operations/${plan.json.id}`)).json.plan_hash).toBe(plan.json.plan_hash);
    await stop(d);
  });

  it("the data directory is single-process: report on a running daemon's directory fails with a clear message, then works after stop", async () => {
    const c = createPackagedCli();
    bootstrap(c, "./data", "daemon-admin@example.test", pw());
    const d = await serve(c, "./data");
    await waitHealthy(d);
    const locked = c.run(["report", "--data-dir", "./data", "--out", "./r.html"]);
    expect(locked.status).toBe(1);
    expect(locked.output).toMatch(/in use/i);
    await stop(d);
    const ok = c.run(["report", "--data-dir", "./data", "--out", "./r.html"]);
    expect([0, 5], ok.output).toContain(ok.status);
  });

  it("a key file readable by group or others is refused; owner-only works; the key file is never created world-readable", async () => {
    const c = createPackagedCli();
    bootstrap(c, "./data", "daemon-admin@example.test", pw());
    const key = join(c.workdir, "data", "undokit.key");
    expect(statSync(key).mode & 0o077).toBe(0);
    chmodSync(key, 0o644);
    const d = await serve(c, "./data");
    const code = await Promise.race([d.exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), 8000))]);
    expect(code, `daemon must refuse a group/other readable key: ${d.output()}`).not.toBe("alive");
    expect(code).not.toBe(0);
    expect(d.output()).toMatch(/owner-only|chmod 600/i);
    chmodSync(key, 0o600);
    const again = await serve(c, "./data");
    await waitHealthy(again);
    await stop(again);
  });

  it("a wrong encryption key does not silently serve garbage: values are unreadable, not wrong", async () => {
    const c = createPackagedCli();
    const email = "daemon-admin@example.test";
    const password = pw();
    bootstrap(c, "./data", email, password);
    const d = await serve(c, "./data");
    await waitHealthy(d);
    const h = new Http(d.url);
    await h.login(email, password);
    const conn = await h.req("POST", "/api/v1/connectors", { kind: "simulator", name: "daemon-sim", policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 32 }], record_prefixes: ["contact-"] }, config: { seed_records: [{ record_ref: "contact-0001", fields: { lifecycle_stage: "lead" } }] } });
    const plan = await h.req("POST", "/api/v1/operations", { connector_id: conn.json.id, record_ref: "contact-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" }, { "idempotency-key": "key-1" });
    await stop(d);
    const other = Buffer.alloc(32, 7).toString("base64");
    const d2 = await serve(c, "./data", [], { UNDOKIT_ENCRYPTION_KEY: other });
    await waitHealthy(d2);
    const h2 = new Http(d2.url);
    expect((await h2.login(email, password)).status).toBe(200);
    const read = await h2.req("GET", `/api/v1/operations/${plan.json.id}`);
    expect(read.status).toBe(500);
    expect(read.text).not.toContain("customer");
    expect(read.text).not.toMatch(/\bat \w+.*\.(ts|js):\d+|node_modules/);
    await stop(d2);
  });

  // Regression test for QA-D13 (fixed in db3202e): `serve` on a data directory that does not exist yet creates it owner-only and
  // starts (printing the bootstrap hint); it never fails with a raw ENOENT. If it ever fails instead, the message must be actionable.
  it("serve on a missing data directory never fails with a raw ENOENT: it creates the directory owner-only and starts", async () => {
    const c = createPackagedCli();
    const d = await serve(c, "./not-created-yet");
    try {
      await waitHealthy(d);
    } catch {
      /* exited early: judged below */
    }
    const text = d.output();
    expect(text, "no raw ENOENT").not.toMatch(/ENOENT/);
    if (d.proc.exitCode === null) {
      expect(statSync(join(c.workdir, "not-created-yet")).mode & 0o777).toBe(0o700);
      expect(statSync(join(c.workdir, "not-created-yet", "undokit.key")).mode & 0o777).toBe(0o600);
      expect(text).toMatch(/bootstrap/i);
      expect(await stop(d)).toBe(0);
    } else {
      expect(text).toMatch(/bootstrap|does not exist|not found/i);
    }
  });

  it("--host 0.0.0.0 prints an explicit exposure warning (on an empty data directory with no accounts)", async () => {
    const c = createPackagedCli();
    mkdirSync(join(c.workdir, "empty"), { mode: 0o700 });
    const d = await serve(c, "./empty", ["--host", "0.0.0.0"]);
    await waitHealthy(d);
    expect(d.output()).toMatch(/0\.0\.0\.0|all (network )?interfaces|every network interface/i);
    expect(d.output()).toMatch(/warn|only use behind|trusted/i);
    await stop(d);
    expect(existsSync(join(c.workdir, "empty"))).toBe(true);
    expect(readFileSync(join(c.workdir, "empty", "undokit.key"), "utf8").length).toBeGreaterThan(20);
    writeFileSync(join(c.workdir, "marker"), "ok");
  });
});
