// In-process tests for the deterministic demo, environment configuration, key resolution and startServer (QA-owned).
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyRing, loadConfig, resolveKeyRing, runDemo, startServer, verifyBundleText } from "../../src/index.js";
import { cleanTmp, tmpDir } from "../helpers/cli-ctx.js";

afterEach(cleanTmp);

describe("runDemo (synthetic, offline, deterministic)", () => {
  it("two runs produce an identical report and evidence bundle; the report says it is a simulator, never live", async () => {
    const a = await runDemo();
    const b = await runDemo();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a).toMatchObject({ kind: "undokit-demo", mode: "synthetic-simulator", live: false, all_passed: true });
    expect(a.label).toMatch(/SIMULATOR/);
    expect(a.checks.length).toBe(7);
    expect(a.checks.every((c) => c.pass)).toBe(true);
    expect(verifyBundleText(JSON.stringify(a.evidence)).bundle_hash).toBe(a.bundle.bundle_hash);
    expect(a.bundle).toMatchObject({ verified: true, file_count: 3 });
  });

  it("a different start time shifts every timestamp but not the outcome", async () => {
    const a = await runDemo({ startedAt: "2030-06-01T08:00:00.000Z" });
    expect(a.started_at).toBe("2030-06-01T08:00:00.000Z");
    expect(a.all_passed).toBe(true);
    expect(a.operations.every((o) => o.created_at.startsWith("2030-06-01"))).toBe(true);
    expect(a.evidence.bundle_hash).not.toBe((await runDemo()).evidence.bundle_hash);
  });

  it("each scenario shows its exact expected outcome: restored, blocked with the edit kept, five precise rejections, UNKNOWN then reconciled", async () => {
    const r = await runDemo();
    const steps = (i: number) => r.scenarios[i]!.steps.map((s) => [s.step, s.outcome]);
    expect(steps(0)).toEqual(expect.arrayContaining([["compensate", "compensated"]]));
    expect(steps(1)).toEqual(expect.arrayContaining([["compensate", "COMPENSATION_BLOCKED"]]));
    expect(r.scenarios[2]!.steps.map((s) => s.outcome)).toEqual(["FIELD_NOT_ALLOWED", "FORBIDDEN_ACTION", "DELETION_FORBIDDEN", "NON_SCALAR_VALUE", "RECORD_OUT_OF_SCOPE"]);
    expect(steps(3)).toEqual(expect.arrayContaining([["apply (response lost)", "unknown"], ["reconcile (read-only)", "applied"]]));
    expect(r.operations.map((o) => o.record_ref)).toEqual(["contact-0001", "contact-0002", "contact-0003"]);
  });

  it("the demo never writes a credential into its output", async () => {
    const text = JSON.stringify(await runDemo());
    expect(text).not.toMatch(/password|secret|token|authorization/i);
  });
});

describe("loadConfig", () => {
  it("defaults are loopback, port 8787, an embedded database under ./.undokit, worker on, secure cookies off", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8787, databaseUrl: "pglite://./.undokit/db", cookieSecure: false, runWorker: true, workerPollMs: 500, keyFile: undefined, keyBase64: undefined, webRoot: undefined });
    expect(c.service.approvalTtlMs).toBe(15 * 60 * 1000);
    expect(c.service.leaseMs).toBe(30_000);
  });

  it("a non-loopback host turns Secure cookies on by default; loopback names do not; an explicit setting wins either way", () => {
    expect(loadConfig({ UNDOKIT_HOST: "0.0.0.0" }).cookieSecure).toBe(true);
    expect(loadConfig({ UNDOKIT_HOST: "10.1.2.3" }).cookieSecure).toBe(true);
    for (const h of ["localhost", "127.0.0.1", "::1", "127.9.9.9"]) expect(loadConfig({ UNDOKIT_HOST: h }).cookieSecure, h).toBe(false);
    expect(loadConfig({ UNDOKIT_HOST: "0.0.0.0", UNDOKIT_COOKIE_SECURE: "0" }).cookieSecure).toBe(false);
    expect(loadConfig({ UNDOKIT_HOST: "127.0.0.1", UNDOKIT_COOKIE_SECURE: "1" }).cookieSecure).toBe(true);
  });

  it("numbers, switches and lists are parsed; blanks fall back; bad numbers are rejected by name", () => {
    const c = loadConfig({
      UNDOKIT_PORT: "9001",
      UNDOKIT_WORKER: "0",
      UNDOKIT_WORKER_POLL_MS: "250",
      UNDOKIT_APPROVAL_TTL_SECONDS: "60",
      UNDOKIT_LEASE_SECONDS: "5",
      UNDOKIT_ALLOWED_HOSTS: " 127.0.0.1 , couch.internal ,, ",
      UNDOKIT_DATABASE_URL: "postgres://u@h/db",
      UNDOKIT_KEY_FILE: "/k",
      UNDOKIT_ENCRYPTION_KEY: "abc",
      UNDOKIT_WEB_ROOT: "/web",
    });
    expect(c).toMatchObject({ port: 9001, runWorker: false, workerPollMs: 250, databaseUrl: "postgres://u@h/db", keyFile: "/k", keyBase64: "abc", webRoot: "/web" });
    expect(c.service.approvalTtlMs).toBe(60_000);
    expect(c.service.leaseMs).toBe(5_000);
    expect(c.service.allowedHosts).toEqual(["127.0.0.1", "couch.internal"]);
    expect(loadConfig({ UNDOKIT_PORT: "" }).port).toBe(8787);
    expect(() => loadConfig({ UNDOKIT_PORT: "abc" })).toThrow(/UNDOKIT_PORT must be a number of at least 0/);
    expect(() => loadConfig({ UNDOKIT_LEASE_SECONDS: "-1" })).toThrow(/UNDOKIT_LEASE_SECONDS/);
    expect(loadConfig({ UNDOKIT_ALLOWED_HOSTS: "" }).service.allowedHosts).toEqual(expect.arrayContaining(["127.0.0.1"]));
  });
});

describe("resolveKeyRing", () => {
  it("an explicit base64 key wins over any file", () => {
    const text = KeyRing.generateKeyText();
    expect(resolveKeyRing({ keyBase64: text, keyFile: "/does/not/exist" }).keyId).toBe(KeyRing.fromBase64(text).keyId);
  });

  it("a missing key file is created owner-only (with a 0700 parent) when allowed, and reused on the next call", () => {
    const d = tmpDir();
    const file = join(d, "nested", "undokit.key");
    const first = resolveKeyRing({ keyBase64: undefined, keyFile: file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, "nested")).mode & 0o777).toBe(0o700);
    expect(resolveKeyRing({ keyBase64: undefined, keyFile: file }).keyId).toBe(first.keyId);
  });

  it("create:false refuses to invent a key; a group-readable key file is refused", () => {
    const d = tmpDir();
    const file = join(d, "k.key");
    expect(() => resolveKeyRing({ keyBase64: undefined, keyFile: file }, { create: false })).toThrow(/key file not found/);
    writeFileSync(file, `${KeyRing.generateKeyText()}\n`, { mode: 0o600 });
    chmodSync(file, 0o644);
    expect(() => resolveKeyRing({ keyBase64: undefined, keyFile: file })).toThrow(/owner-only/);
    mkdirSync(join(d, "x"));
    expect(existsSync(join(d, "x"))).toBe(true);
  });
});

describe("startServer", () => {
  const keyBase64 = KeyRing.generateKeyText();
  const base = (over: Record<string, string> = {}) => loadConfig({ UNDOKIT_DATABASE_URL: "memory://", UNDOKIT_PORT: "0", UNDOKIT_ENCRYPTION_KEY: keyBase64, UNDOKIT_WORKER_POLL_MS: "50", ...over });

  it("listens on an ephemeral loopback port, serves health and the built UI, runs a worker, and closes cleanly", async () => {
    const s = await startServer(base());
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${s.url}/api/v1/health`)).status).toBe(200);
      const home = await fetch(`${s.url}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toMatch(/<div id="root"/);
      expect(s.kit.readiness.ok).toBe(true);
    } finally {
      await s.close();
    }
    await expect(fetch(`${s.url}/api/v1/health`)).rejects.toThrow();
  });

  it("with the worker switched off nothing processes jobs; with an explicit web root override the UI is served from there", async () => {
    const d = tmpDir();
    writeFileSync(join(d, "index.html"), "<!doctype html><title>custom</title><div id=\"root\"></div>");
    const s = await startServer({ ...base({ UNDOKIT_WORKER: "0" }), webRoot: d });
    try {
      expect(await (await fetch(`${s.url}/`)).text()).toContain("custom");
    } finally {
      await s.close();
    }
  });

  it("an explicit key ring override is used instead of resolving one from the config", async () => {
    const ring = KeyRing.fromBase64(KeyRing.generateKeyText());
    const s = await startServer({ ...base(), keyBase64: undefined, keyFile: "/does/not/exist" }, { keyring: ring });
    try {
      expect(s.kit.keyring.keyId).toBe(ring.keyId);
    } finally {
      await s.close();
    }
  });
});
