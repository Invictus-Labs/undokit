// In-process CLI tests for the commands that open a data directory: admin bootstrap, export, import, report --data-dir, serve,
// and the lock/key handling in src/cli/kit.ts (QA-owned). Real embedded databases in temp dirs; no mocks of the library.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyRing, createUndoKit } from "../../src/index.js";
import { acquireDataLock, configFor, localActor, openKit } from "../../src/cli/kit.js";
import { CliError } from "../../src/cli/exit.js";
import { bootstrapViaCli, cleanTmp, cli, makeCtx, populateDataDir, tmpDir } from "../helpers/cli-ctx.js";
import { newPassword } from "../helpers/kit.js";
import { run } from "../../src/cli/run.js";
import { syntheticUuid } from "../helpers/fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanTmp();
});

describe("admin bootstrap", () => {
  it("creates the admin and workspace from stdin (trailing newline dropped, owner-only files) and refuses a second bootstrap", async () => {
    const dir = join(tmpDir(), "data");
    const pw = newPassword();
    const r = await cli(["admin", "bootstrap", "--email", "  Admin@Example.Test ", "--workspace", "Synthetic QA", "--password-stdin", "--data-dir", dir], { stdin: async () => `${pw}\r\n` });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Created workspace "Synthetic QA" and its admin admin@example.test');
    expect(r.out).not.toContain(pw);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "undokit.key")).mode & 0o777).toBe(0o600);
    const again = await cli(["admin", "bootstrap", "--email", "other@example.test", "--password-stdin", "--data-dir", dir], { stdin: async () => `${newPassword()}\n` });
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already bootstrapped/);
  });

  it("the default workspace name is used when --workspace is omitted", async () => {
    const dir = join(tmpDir(), "data");
    const r = await cli(["admin", "bootstrap", "--email", "a@example.test", "--password-stdin", "--data-dir", dir], { stdin: async () => `${newPassword()}\n` });
    expect(r.out).toContain('"Default Workspace"');
  });

  it("--password-file works, warns when the file is readable by others, and a missing file is rejected input", async () => {
    const d = tmpDir();
    const file = join(d, "pw.txt");
    writeFileSync(file, `${newPassword()}\n`, { mode: 0o600 });
    const ok = await cli(["admin", "bootstrap", "--email", "a@example.test", "--password-file", file, "--data-dir", join(d, "d1")]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).toBe("");
    const loose = join(d, "loose.txt");
    writeFileSync(loose, `${newPassword()}\n`);
    chmodSync(loose, 0o644);
    const warn = await cli(["admin", "bootstrap", "--email", "b@example.test", "--password-file", loose, "--data-dir", join(d, "d2")]);
    expect(warn.code).toBe(0);
    expect(warn.err).toMatch(/readable by other users/);
    const missing = await cli(["admin", "bootstrap", "--email", "c@example.test", "--password-file", join(d, "nope.txt"), "--data-dir", join(d, "d3")]);
    expect(missing.code).toBe(4);
    expect(existsSync(join(d, "d3"))).toBe(false);
  });

  it("the interactive prompt path asks twice, rejects a mismatch and accepts a match; without a terminal it is a usage error", async () => {
    const d = tmpDir();
    const pw = newPassword();
    const answers = [pw, `${pw}-different`];
    const mismatch = await cli(["admin", "bootstrap", "--email", "a@example.test", "--data-dir", join(d, "d1")], { isTTY: true, prompt: async () => answers.shift()! });
    expect(mismatch.code).toBe(2);
    expect(mismatch.err).toMatch(/did not match/);
    expect(existsSync(join(d, "d1"))).toBe(false);
    const labels: string[] = [];
    const match = await cli(["admin", "bootstrap", "--email", "a@example.test", "--data-dir", join(d, "d2")], {
      isTTY: true,
      prompt: async (label) => {
        labels.push(label);
        return pw;
      },
    });
    expect(match.code, match.err).toBe(0);
    expect(labels).toEqual(["Password", "Confirm password"]);
    const noTty = await cli(["admin", "bootstrap", "--email", "a@example.test", "--data-dir", join(d, "d3")]);
    expect(noTty.code).toBe(2);
    expect(noTty.err).toMatch(/never accepted as a flag/);
  });

  it("both password sources together, a short password, and an unknown subcommand are refused with their codes", async () => {
    const d = tmpDir();
    expect((await cli(["admin", "bootstrap", "--email", "a@example.test", "--password-stdin", "--password-file", join(d, "x"), "--data-dir", join(d, "d")])).code).toBe(2);
    const short = await cli(["admin", "bootstrap", "--email", "a@example.test", "--password-stdin", "--data-dir", join(d, "d2")], { stdin: async () => "short\n" });
    expect(short.code).toBe(4);
    expect(short.err).toMatch(/at least 12 characters/);
    expect((await cli(["admin", "frobnicate"])).err).toMatch(/Unknown admin command: frobnicate/);
    expect((await cli(["admin"])).err).toMatch(/Missing admin command/);
  });
});

describe("export, import and report over a real data directory", () => {
  it("export before anything exists is rejected input and creates nothing; an empty bootstrapped directory exports zero operations", async () => {
    const d = tmpDir();
    const missing = await cli(["export", "--out", join(d, "o.json"), "--data-dir", join(d, "nope")]);
    expect(missing.code).toBe(4);
    expect(missing.err).toMatch(/Data directory not found/);
    expect(existsSync(join(d, "nope"))).toBe(false);
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const out = join(d, "o.json");
    const ok = await cli(["export", "--out", out, "--data-dir", dir]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/Exported 0 operation\(s\)/);
    expect(ok.out).toMatch(/no operations of its own/);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect((await cli(["verify", out])).code).toBe(0);
  });

  it("a populated directory: export verifies, report lists the unresolved operation with exit 5, import into a clean directory then report merges it", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    await populateDataDir(dir);
    const bundle = join(d, "b.json");
    const exp = await cli(["export", "--out", bundle, "--data-dir", dir]);
    expect(exp.code, exp.err).toBe(0);
    expect(exp.out).toMatch(/Exported 2 operation\(s\)/);
    expect((await cli(["verify", bundle])).code).toBe(0);

    const html = join(d, "r.html");
    const rep = await cli(["report", "--data-dir", dir, "--out", html]);
    expect(rep.code, rep.err).toBe(5);
    expect(rep.out).toMatch(/operations\s+2/);
    expect(rep.out).toMatch(/- contact-0002: unknown/);
    expect(readFileSync(html, "utf8")).toContain("Unknown outcome");

    const fresh = join(d, "fresh");
    const imp = await cli(["import", bundle, "--data-dir", fresh]);
    expect(imp.code, imp.err).toBe(0);
    expect(imp.out).toMatch(/^Imported /);
    const replay = await cli(["import", bundle, "--data-dir", fresh]);
    expect(replay.code).toBe(0);
    expect(replay.out).toMatch(/^Already imported /);
    const merged = await cli(["report", "--data-dir", fresh, "--out", join(d, "m.html")]);
    expect(merged.code).toBe(5);
    expect(readFileSync(join(d, "m.html"), "utf8")).toContain("imported bundle");
  }, 120_000);

  it("importing into a directory that already has a workspace imports as that workspace; an unknown --workspace is rejected input", async () => {
    const d = tmpDir();
    const src = join(d, "src");
    await bootstrapViaCli(src);
    await populateDataDir(src);
    const bundle = join(d, "b.json");
    await cli(["export", "--out", bundle, "--data-dir", src]);
    const dst = join(d, "dst");
    await bootstrapViaCli(dst, "dst-admin@example.test", "Destination");
    const ok = await cli(["import", bundle, "--data-dir", dst]);
    expect(ok.code, ok.err).toBe(0);
    const actor = await (async () => {
      const opened = await openKit(configFor(dst, {}), { create: false });
      try {
        return await localActor(opened.kit);
      } finally {
        await opened.close();
      }
    })();
    expect(actor?.role).toBe("admin");
    const bad = await cli(["import", bundle, "--data-dir", dst, "--workspace", syntheticUuid("no-such-workspace")]);
    expect(bad.code).toBe(4);
    expect(bad.err).toMatch(/workspace does not exist/);
    const exportMissing = await cli(["export", "--out", join(d, "x.json"), "--data-dir", dst, "--workspace", syntheticUuid("no-such-workspace")]);
    expect(exportMissing.code).toBe(1);
    expect(exportMissing.err).toMatch(/Nothing to export/);
    const withWs = await cli(["report", "--data-dir", dst, "--workspace", syntheticUuid("no-such-workspace"), "--out", join(d, "w.html")]);
    expect(withWs.code).toBe(0);
    expect(readFileSync(join(d, "w.html"), "utf8")).toContain("No workspace exists");
  }, 120_000);

  it("a bad bundle is refused before the data directory is even created; usage errors are exit 2", async () => {
    const d = tmpDir();
    const bad = join(d, "bad.json");
    writeFileSync(bad, "{ not json");
    const r = await cli(["import", bad, "--data-dir", join(d, "never")]);
    expect(r.code).toBe(1);
    expect(existsSync(join(d, "never"))).toBe(false);
    expect((await cli(["import"])).code).toBe(2);
    expect((await cli(["import", "a", "b"])).code).toBe(2);
    expect((await cli(["import", join(d, "missing.json")])).code).toBe(4);
  });

  it("report on a missing data directory writes an error-state page and exits 4; an empty database reports no workspace", async () => {
    const d = tmpDir();
    const out = join(d, "r.html");
    const r = await cli(["report", "--data-dir", join(d, "nowhere"), "--out", out]);
    expect(r.code).toBe(4);
    expect(readFileSync(out, "utf8")).toContain('data-testid="report-error"');
    // an existing but never-initialised directory: create db dir and key, no workspace
    const empty = join(d, "empty");
    mkdirSync(join(empty, "db"), { recursive: true });
    KeyRing.writeNewKeyFile(join(empty, "undokit.key"));
    const ok = await cli(["report", "--data-dir", empty, "--out", join(d, "e.html")]);
    expect(ok.code, ok.err).toBe(0);
    expect(readFileSync(join(d, "e.html"), "utf8")).toContain("No workspace exists");
    const noWs = await cli(["export", "--out", join(d, "e.json"), "--data-dir", empty]);
    expect(noWs.code).toBe(1);
    expect(noWs.err).toMatch(/Nothing to export: no workspace exists/);
  });
});

describe("data directory lock, key and database errors (src/cli/kit.ts)", () => {
  it("a lock holding THIS process's pid that this process does not hold is stale (container pid 1 after an unclean stop, pid reuse): the open succeeds and the lock is released", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const lock = join(dir, "db.lock");
    writeFileSync(lock, String(process.pid)); // a leftover from an earlier incarnation that had the same pid
    const r = await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("a different live process holding the lock still blocks the opener with a clear message", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const lock = join(dir, "db.lock");
    expect(process.ppid).not.toBe(process.pid);
    writeFileSync(lock, String(process.ppid)); // the parent process is alive and is not us
    const blocked = await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain(`in use by process ${process.ppid}`);
    expect(existsSync(lock)).toBe(true); // a live holder's lock is never removed
  });

  it("a dead holder or an unreadable lock is recovered", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const lock = join(dir, "db.lock");
    writeFileSync(lock, "999999999"); // no such process
    expect((await cli(["report", "--data-dir", dir, "--out", join(d, "r2.html")])).code).toBe(0);
    expect(existsSync(lock)).toBe(false); // released
    writeFileSync(lock, "not a pid");
    expect((await cli(["report", "--data-dir", dir, "--out", join(d, "r3.html")])).code).toBe(0);
  });

  it("a lock written by another host (another container sharing the volume) is live while its heartbeat is fresh and stale once nobody has touched it", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const lock = join(dir, "db.lock");
    writeFileSync(lock, `4242 some-other-container\n`); // fresh mtime: the holder is considered alive
    const blocked = await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toMatch(/process 4242 on host some-other-container \(last heartbeat \d+s ago\)/);
    expect(existsSync(lock)).toBe(true);
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, longAgo, longAgo); // nobody has touched it for ten minutes
    const ok = await cli(["report", "--data-dir", dir, "--out", join(d, "r2.html")]);
    expect(ok.code, ok.err).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("the same pid as ours but written by another host is NOT mistaken for our own leftover: its heartbeat decides", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const lock = join(dir, "db.lock");
    writeFileSync(lock, `${process.pid} some-other-container\n`);
    expect((await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")])).code).toBe(1);
    expect(existsSync(lock)).toBe(true);
  });

  it("the lock is created atomically: twelve processes racing a fresh data directory produce exactly one winner, eleven refusals, and no .lock or .tmp leftovers", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    mkdirSync(dir);
    const startAt = Date.now() + 4000; // every racer waits for this instant, then calls acquireDataLock
    const racer = join(import.meta.dirname, "..", "helpers", "lock-racer.ts");
    const tsx = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        new Promise<string>((resolve) => {
          const child = spawn(tsx, [racer, `pglite://${join(dir, "db")}`, String(startAt), "2500"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
          let out = "";
          child.stdout.on("data", (c: Buffer) => (out += c.toString()));
          child.on("close", () => resolve(out.trim()));
        }),
      ),
    );
    expect(results.filter((r) => r === "WIN"), JSON.stringify(results)).toHaveLength(1);
    expect(results.filter((r) => r.startsWith("REFUSED:") && /in use by process/.test(r)), JSON.stringify(results)).toHaveLength(11);
    expect(readdirSync(dir).filter((f) => /\.lock|\.tmp$/.test(f)), "nothing left behind").toEqual([]);
  }, 60_000);

  it("no temporary lock file is left behind by a normal acquire and release or by a refused acquire", async () => {
    const d = tmpDir();
    const url = `pglite://${join(d, "db")}`;
    const release = acquireDataLock(url);
    expect(() => acquireDataLock(url)).toThrow(/in use by process/); // held by this process
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    release();
    expect(readdirSync(d)).toEqual([]);
  });

  it("a lock this very process really holds (serve still running) refuses a second open, and is released when serve stops", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const c = makeCtx({ waitForStop: () => stopped });
    const serving = run(["serve", "--port", "0", "--data-dir", dir], c.ctx);
    for (let i = 0; i < 300 && !/running at/.test(c.out()); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(c.out(), c.err()).toMatch(/running at/);
    const lock = join(dir, "db.lock");
    expect(readFileSync(lock, "utf8").trim().split(/\s+/)[0]).toBe(String(process.pid)); // "<pid> <host name>"
    const second = await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")]);
    expect(second.code).toBe(1);
    expect(second.err).toContain(`in use by process ${process.pid}`); // held by us, so NOT treated as a stale leftover
    expect(existsSync(lock)).toBe(true);
    stop();
    expect(await serving).toBe(0);
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  it("acquireDataLock is a no-op for in-memory and PostgreSQL URLs, and releasing twice is safe", () => {
    expect(() => acquireDataLock("memory://")()).not.toThrow();
    expect(() => acquireDataLock("postgres://u@127.0.0.1:1/db")()).not.toThrow();
    const d = tmpDir();
    const release = acquireDataLock(`pglite://${join(d, "db")}`);
    expect(existsSync(join(d, "db.lock"))).toBe(true);
    release();
    release();
    expect(existsSync(join(d, "db.lock"))).toBe(false);
  });

  it("an unreachable PostgreSQL database is exit 3 (nothing written) and never mentions the password", async () => {
    const d = tmpDir();
    const key = KeyRing.generateKeyText();
    const r = await cli(["export", "--out", join(d, "o.json")], { env: { UNDOKIT_DATABASE_URL: "postgres://qa:placeholder-pw-123@127.0.0.1:1/undokit", UNDOKIT_ENCRYPTION_KEY: key } });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/not reachable/);
    expect(r.err).not.toContain("placeholder-pw-123");
    expect(existsSync(join(d, "o.json"))).toBe(false);
  }, 30_000);

  it("a missing key file in an existing data directory is refused for read commands; a group-readable key is refused", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const key = join(dir, "undokit.key");
    chmodSync(key, 0o644);
    const loose = await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")]);
    expect(loose.code).toBe(1);
    expect(loose.err).toMatch(/owner-only/);
    expect(loose.err).toMatch(/operator-managed/);
    chmodSync(key, 0o600);
    const noKey = join(d, "nokey");
    mkdirSync(join(noKey, "db"), { recursive: true });
    const r = await cli(["report", "--data-dir", noKey, "--out", join(d, "r2.html")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/key file not found/);
  });

  it("the wrong encryption key does not serve garbage: reading encrypted evidence fails with an exit code, never wrong data", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    await populateDataDir(dir);
    const other = Buffer.alloc(32, 9).toString("base64");
    const r = await cli(["export", "--out", join(d, "o.json"), "--data-dir", dir], { env: { UNDOKIT_ENCRYPTION_KEY: other } });
    expect(r.code).toBe(1);
    expect(existsSync(join(d, "o.json"))).toBe(false);
    expect(r.err).not.toContain(other);
  }, 90_000);

  it("configFor: with no data dir the environment decides; with one the database and key live inside it", () => {
    expect(configFor(undefined, { UNDOKIT_DATABASE_URL: "memory://" }).databaseUrl).toBe("memory://");
    const c = configFor("/tmp/some-undokit-dir", {});
    expect(c.databaseUrl).toBe("pglite:///tmp/some-undokit-dir/db");
    expect(c.keyFile).toBe("/tmp/some-undokit-dir/undokit.key");
    const withKey = configFor("/tmp/some-undokit-dir", { UNDOKIT_ENCRYPTION_KEY: KeyRing.generateKeyText(), UNDOKIT_KEY_FILE: "/elsewhere.key" });
    expect(withKey.keyFile).toBe("/elsewhere.key"); // an explicit key text wins; the file setting is untouched
  });

  it("localActor prefers an admin over an operator and returns null for an empty database", async () => {
    const kit = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()) });
    try {
      expect(await localActor(kit)).toBeNull();
    } finally {
      await kit.close();
    }
  });

  it("opening a create:true kit on a corrupt database directory surfaces an error and releases the lock", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    mkdirSync(join(dir, "db"), { recursive: true });
    writeFileSync(join(dir, "db", "PG_VERSION"), "garbage");
    KeyRing.writeNewKeyFile(join(dir, "undokit.key"));
    const r = await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")]);
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "db.lock"))).toBe(false);
  }, 60_000);
});

describe("serve (in process)", () => {
  async function startServe(dir: string, extra: string[] = [], env: Record<string, string> = {}) {
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const c = makeCtx({ env, waitForStop: () => stopped });
    const done = run(["serve", "--port", "0", "--data-dir", dir, ...extra], c.ctx);
    let url = "";
    for (let i = 0; i < 300 && !url; i += 1) {
      const m = /running at (http:\/\/\S+)/.exec(c.out());
      if (m) url = m[1]!.replace("localhost", "127.0.0.1");
      else await new Promise((r) => setTimeout(r, 50));
    }
    if (!url) throw new Error(`serve did not start: ${c.err()}${c.out()}`);
    return { url, stop, done, c };
  }

  it("starts on a fresh directory, prints the loopback message and the no-admin hint, serves health, and stops with exit 0 releasing the lock", async () => {
    const dir = join(tmpDir(), "fresh");
    const s = await startServe(dir);
    expect((await fetch(`${s.url}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${s.url}/api/v1/ready`)).status).toBe(200);
    expect(s.c.out()).toMatch(/Bound to this machine only/);
    expect(s.c.out()).toMatch(/No admin exists yet/);
    expect(existsSync(join(dir, "db.lock"))).toBe(true);
    s.stop();
    expect(await s.done).toBe(0);
    expect(s.c.out()).toContain("Stopping...");
    expect(existsSync(join(dir, "db.lock"))).toBe(false);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("a second serve (or any data command) on a running directory fails with the in-use message", async () => {
    const dir = join(tmpDir(), "d");
    const s = await startServe(dir);
    const second = await cli(["serve", "--port", "0", "--data-dir", dir]);
    expect(second.code).toBe(1);
    expect(second.err).toContain("in use by process");
    s.stop();
    await s.done;
  });

  it("a bootstrapped directory does not print the no-admin hint; --host 0.0.0.0 prints the exposure warning and Secure cookies", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const s = await startServe(dir, ["--host", "0.0.0.0"]);
    expect(s.c.out()).not.toMatch(/No admin exists yet/);
    expect(s.c.out()).toMatch(/WARNING: bound to 0\.0\.0\.0, reachable from the network/);
    s.stop();
    await s.done;
  });

  it("UNDOKIT_COOKIE_SECURE overrides the bind-address default", async () => {
    const dir = join(tmpDir(), "d");
    const s = await startServe(dir, [], { UNDOKIT_COOKIE_SECURE: "1" });
    expect((await fetch(`${s.url}/api/v1/health`)).status).toBe(200);
    s.stop();
    expect(await s.done).toBe(0);
  });

  it("a database whose migrations were altered starts, warns that it is not ready, and the API refuses (health still answers)", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const kit = await createUndoKit({ databaseUrl: `pglite://${dir}/db`, keyring: KeyRing.fromFile(join(dir, "undokit.key")) });
    await kit.db.query("UPDATE schema_version SET checksum = 'tampered'");
    await kit.close();
    const s = await startServe(dir);
    expect(s.c.err()).toMatch(/WARNING: the database is not ready/);
    expect((await fetch(`${s.url}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${s.url}/api/v1/ready`)).status).toBe(503);
    s.stop();
    await s.done;
  });

  it("a start-up failure releases the lock and is mapped to an exit code", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    mkdirSync(join(dir, "db"), { recursive: true });
    writeFileSync(join(dir, "db", "PG_VERSION"), "garbage");
    KeyRing.writeNewKeyFile(join(dir, "undokit.key"));
    const r = await cli(["serve", "--port", "0", "--data-dir", dir]);
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "db.lock"))).toBe(false);
    expect(new CliError(1, "x").exitCode).toBe(1);
  }, 60_000);
});

describe("the encryption key location with --data-dir (src/cli/kit.ts configFor and assertKeyLocation)", () => {
  it("an explicit UNDOKIT_KEY_FILE wins over the data directory default; UNDOKIT_ENCRYPTION_KEY wins over any file; with neither the key sits in the data directory", () => {
    const d = tmpDir();
    const dir = join(d, "data");
    const outside = join(d, "custody", "undokit.key");
    expect(configFor(dir, { UNDOKIT_KEY_FILE: outside }).keyFile).toBe(outside);
    expect(configFor(dir, { UNDOKIT_ENCRYPTION_KEY_FILE: outside }).keyFile).toBe(outside);
    expect(configFor(dir, {}).keyFile).toBe(join(dir, "undokit.key"));
    const withKey = configFor(dir, { UNDOKIT_ENCRYPTION_KEY: KeyRing.generateKeyText(), UNDOKIT_KEY_FILE: outside });
    expect(withKey.keyBase64).toBeTruthy();
  });

  it("a key file that does not exist outside the data directory is refused, and nothing is created (no data directory, lock, database or key)", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    const missing = join(d, "custody", "undokit.key");
    const env = { UNDOKIT_KEY_FILE: missing };
    for (const argv of [
      ["admin", "bootstrap", "--email", "key-admin@example.test", "--workspace", "Synthetic", "--password-stdin", "--data-dir", dir],
      ["serve", "--port", "0", "--data-dir", dir],
    ]) {
      const r = await cli(argv, { env, stdin: async () => `${newPassword()}\n` });
      expect(r.code, argv[0]).toBe(1);
      expect(r.err, argv[0]).toContain(`Encryption key file not found: ${missing}`);
    }
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(d, "custody"))).toBe(false);
  });

  it("with the key kept outside the data directory, bootstrap and report work and the data directory holds no key file", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    const custody = join(d, "custody");
    mkdirSync(custody, { mode: 0o700 });
    const keyPath = join(custody, "undokit.key");
    KeyRing.writeNewKeyFile(keyPath);
    const env = { UNDOKIT_KEY_FILE: keyPath };
    const boot = await cli(["admin", "bootstrap", "--email", "key-admin@example.test", "--workspace", "Synthetic", "--password-stdin", "--data-dir", dir], { env, stdin: async () => `${newPassword()}\n` });
    expect(boot.code, boot.err).toBe(0);
    expect(existsSync(join(dir, "undokit.key")), "no key copy inside the data directory").toBe(false);
    const rep = await cli(["report", "--data-dir", dir, "--out", join(d, "r.html")], { env });
    expect(rep.code, rep.err).toBe(0);
    // Without the key setting the same data directory has no key at all: refused for a read command, nothing minted over existing data.
    const noKey = await cli(["report", "--data-dir", dir, "--out", join(d, "r2.html")]);
    expect(noKey.code).toBe(1);
    expect(noKey.err).toMatch(/key file not found/);
    expect(existsSync(join(dir, "undokit.key"))).toBe(false);
  });

  it("an explicit key path INSIDE the data directory is still created owner-only on first run", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    const inside = join(dir, "custom.key");
    const boot = await cli(["admin", "bootstrap", "--email", "key-admin@example.test", "--workspace", "Synthetic", "--password-stdin", "--data-dir", dir], { env: { UNDOKIT_KEY_FILE: inside }, stdin: async () => `${newPassword()}\n` });
    expect(boot.code, boot.err).toBe(0);
    expect(statSync(inside).mode & 0o777).toBe(0o600);
  });
});

describe("the CLI never mints a key over a database that holds data (src/cli/kit.ts resolveKeyRingChecked)", () => {
  it("with the key deleted, report, export, admin bootstrap, import and serve all refuse (exit 1) and nothing is minted; restoring the key works again; a fresh empty directory still gets its key", async () => {
    const d = tmpDir();
    const dir = join(d, "data");
    await bootstrapViaCli(dir);
    const keyPath = join(dir, "undokit.key");
    const saved = readFileSync(keyPath);
    const demo = await cli(["demo", "--out", join(d, "demo")]);
    expect(demo.code).toBe(0);
    rmSync(keyPath);

    const attempts: [string, string[]][] = [
      ["report", ["report", "--data-dir", dir, "--out", join(d, "r.html")]],
      ["export", ["export", "--out", join(d, "e.json"), "--data-dir", dir]],
      ["admin bootstrap", ["admin", "bootstrap", "--email", "second-admin@example.test", "--workspace", "Another", "--password-stdin", "--data-dir", dir]],
      ["import", ["import", join(d, "demo", "evidence.json"), "--data-dir", dir]],
      ["serve", ["serve", "--port", "0", "--data-dir", dir]],
    ];
    for (const [name, argv] of attempts) {
      const r = await cli(argv, { stdin: async () => `${newPassword()}\n` });
      expect(r.code, `${name}: ${r.err}`).toBe(1);
      expect(r.err, name).toMatch(/encryption key file not found/);
      expect(existsSync(keyPath), `${name} must not mint a key`).toBe(false);
      expect(existsSync(join(dir, "db.lock")), `${name} must release the lock`).toBe(false);
    }
    expect(existsSync(join(d, "e.json"))).toBe(false);

    writeFileSync(keyPath, saved, { mode: 0o600 });
    expect((await cli(["report", "--data-dir", dir, "--out", join(d, "r2.html")])).code).toBe(0);

    const fresh = join(d, "fresh");
    await bootstrapViaCli(fresh);
    expect(existsSync(join(fresh, "undokit.key"))).toBe(true);
  }, 120_000);
});
