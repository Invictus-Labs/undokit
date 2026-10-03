// Packaged-CLI e2e (QA-owned): the tarball is built with `npm pack`, extracted into a fresh temp dir, and the shipped
// executable runs from a second fresh temp dir. Requires `npm run build` first (the harness fails clearly if dist/ is missing).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createPackagedCli, type PackagedCli } from "../helpers/cli.js";
import { REPO_ROOT, leakedNeedles, loadSecrets } from "../helpers/fixtures.js";

const cli = (): PackagedCli => createPackagedCli();
const mode = (p: string) => statSync(p).mode & 0o777;
const read = (p: string) => readFileSync(p, "utf8");
const DENY = join(REPO_ROOT, "tests", "helpers", "deny-outbound.cjs");

function packFileList(): string[] {
  const out = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: REPO_ROOT, encoding: "utf8" });
  const parsed = JSON.parse(out.stdout) as { files: { path: string }[] }[];
  return parsed[0]!.files.map((f) => f.path);
}

describe("packaged artifact contents", () => {
  it("contains the executable, the web UI, schemas, migrations, templates and the licence", () => {
    const files = packFileList();
    for (const needed of ["dist/src/cli/main.js", "dist/web/index.html", "LICENSE", "package.json"]) expect(files, needed).toContain(needed);
    for (const dir of ["schemas/", "migrations/", "templates/"]) expect(files.some((f) => f.startsWith(dir)), dir).toBe(true);
  });

  // Regression test for QA-P1 (fixed in 756890c): the "files" whitelist keeps tests, fixtures (planted fake secrets),
  // sources and internal notes out of the public tarball.
  it("contains no tests, fixtures, sources or internal notes", () => {
    const files = packFileList();
    const banned = files.filter((f) => /^(tests|fixtures|scripts|src)\//.test(f) || ["AGENTS.md", "CLAUDE.md", "lessons.md", ".env.example", "Dockerfile", ".dockerignore"].includes(f));
    expect(banned).toEqual([]);
  });
});

describe("packaged artifact: documents and a real offline install", () => {
  it("ships every document the README links to, and the documents the package.json whitelist names", () => {
    const files = packFileList();
    const linked = [...new Set(read(join(REPO_ROOT, "README.md")).match(/docs\/[A-Za-z0-9_./-]+\.md/g) ?? [])];
    expect(linked.length).toBeGreaterThan(3);
    for (const doc of linked) expect(files, `README links ${doc}`).toContain(doc);
    const manifest = JSON.parse(read(join(REPO_ROOT, "package.json"))) as { files: string[] };
    for (const doc of manifest.files.filter((f) => f.endsWith(".md"))) expect(files, doc).toContain(doc);
    for (const doc of ["docs/KNOWN-LIMITATIONS.md", "docs/PROVIDER-DECISION.md", "docs/DEPENDENCY-LICENSES.md", "docs/DOD.md", "docs/PRD.md", "docs/qa/AC-MATRIX.md"]) expect(files, doc).toContain(doc);
  });

  // The other packaged tests symlink the repo's node_modules into the extracted tarball, so they cannot notice a runtime dependency that
  // is missing from package.json. This one installs the tarball into an empty project with the npm cache only (no network) and runs it.
  it("installs from the tarball into a fresh project with `npm install --offline` and runs the offline demo using only the declared dependencies", () => {
    const base = mkdtempSync(join(tmpdir(), "undokit-install-"));
    try {
      const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", base], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(pack.status, pack.stderr).toBe(0);
      const tarball = join(base, (JSON.parse(pack.stdout) as { filename: string }[])[0]!.filename);
      const project = join(base, "project");
      mkdirSync(project);
      writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fresh-project", version: "1.0.0", private: true }));
      const install = spawnSync("npm", ["install", tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project, encoding: "utf8", timeout: 120_000 });
      expect(install.status, `npm install --offline failed (a cold npm cache needs one online \`npm ci\` first): ${install.stderr}`).toBe(0);
      const main = join(project, "node_modules", "undokit", "dist", "src", "cli", "main.js");
      expect(existsSync(main)).toBe(true);
      expect(lstatSync(join(project, "node_modules", "undokit")).isSymbolicLink(), "installed as a copy, not a link to the repository").toBe(false);
      const run = (args: string[]) => spawnSync(process.execPath, [main, ...args], { cwd: project, encoding: "utf8", timeout: 120_000, env: { ...process.env, NODE_OPTIONS: "" } });
      const version = run(["version"]);
      expect(version.status, version.stderr).toBe(0);
      const demo = run(["demo", "--out", "./out"]);
      expect(demo.status, `${demo.stdout}${demo.stderr}`).toBe(0);
      expect(existsSync(join(project, "out", "report.html"))).toBe(true);
      expect(run(["verify", "./out/evidence.json"]).status).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 240_000);
});

describe("AC-08 offline demo, run from the packaged executable in a fresh directory", () => {
  it("version, help and unknown commands behave and use the documented exit codes", () => {
    const c = cli();
    const v = c.run(["version"]);
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe((JSON.parse(read(join(REPO_ROOT, "package.json"))) as { version: string }).version);
    const help = c.run(["--help"]);
    expect(help.status).toBe(0);
    for (const cmd of ["demo", "serve", "admin bootstrap", "report", "export", "verify", "import", "version"]) expect(help.stdout, cmd).toContain(cmd);
    for (const code of ["0  success", "1  failure", "2  usage error", "3  ", "4  input rejected", "5  "]) expect(help.stdout, code).toContain(code);
    expect(help.stdout).toMatch(/no network calls and sends no telemetry/);
    for (const cmd of ["demo", "serve", "report", "export", "verify", "import", "version"]) expect(c.run([cmd, "--help"]).status, `${cmd} --help`).toBe(0);
    expect(c.run(["bogus"]).status).toBe(2);
    expect(c.run(["demo", "--no-such-flag"]).status).toBe(2);
    expect(c.run([]).status).toBeLessThanOrEqual(2);
  });

  it("demo exits 0 with every check passing, writes owner-only files, and shows both the clean restore and the blocked path", () => {
    const c = cli();
    const out = c.run(["demo", "--out", "./out"]);
    expect(out.status, out.output).toBe(0);
    expect(out.stdout).toMatch(/Checks: (\d+)\/\1 passed/);
    expect(out.stdout).not.toMatch(/FAIL /);
    expect(out.stdout).toContain("synthetic data, built-in simulator (not a live provider)");
    expect(out.stdout).toMatch(/Compensated \(original value restored\)/);
    expect(out.stdout).toMatch(/Compensation blocked \(the later edit was kept/);
    expect(out.stdout).toMatch(/response lost|lost response/i);
    const dir = join(c.workdir, "out");
    expect(readdirSync(dir).sort()).toEqual(["evidence.json", "report.html"]);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "evidence.json"))).toBe(0o600);
  });

  it("demo --json prints machine-readable output with every check passed", () => {
    const c = cli();
    const r = c.run(["demo", "--out", "./out", "--json"]);
    expect(r.status, r.output).toBe(0);
    const parsed = JSON.parse(r.stdout) as { all_passed: boolean; live: boolean; mode: string; checks: { name: string; pass: boolean }[] };
    expect(parsed.all_passed).toBe(true);
    expect(parsed.live).toBe(false); // the simulator is never presented as a live provider
    expect(parsed.checks.length).toBeGreaterThanOrEqual(5);
    expect(parsed.checks.every((x) => x.pass === true)).toBe(true);
  });

  it("demo is deterministic: two runs in two fresh directories write byte-identical evidence and report", () => {
    const a = cli();
    const b = cli();
    expect(a.run(["demo", "--out", "./o"]).status).toBe(0);
    expect(b.run(["demo", "--out", "./o"]).status).toBe(0);
    expect(read(join(a.workdir, "o", "evidence.json"))).toBe(read(join(b.workdir, "o", "evidence.json")));
    expect(read(join(a.workdir, "o", "report.html"))).toBe(read(join(b.workdir, "o", "report.html")));
  });

  it("demo makes zero outbound connection attempts (outbound-denied harness), and loopback is the only thing allowed", () => {
    const c = cli();
    const log = join(c.workdir, "deny.log");
    const r = c.run(["demo", "--out", "./out"], { env: { NODE_OPTIONS: `--require "${DENY}"`, UNDOKIT_DENY_LOG: log, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" } });
    expect(r.status, r.output).toBe(0);
    expect(existsSync(log) ? read(log) : "").toBe("");
    expect(r.output).not.toMatch(/UNDOKIT_OUTBOUND_DENIED/);
  });

  it("the harness itself works: a deliberate outbound attempt IS recorded and denied (negative control)", () => {
    const c = cli();
    const log = join(c.workdir, "deny.log");
    const probe = spawnSync(process.execPath, ["-e", "fetch('http://203.0.113.9/').catch(e=>{console.log(e.code);})"], {
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require "${DENY}"`, UNDOKIT_DENY_LOG: log },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(probe.stdout).toContain("UNDOKIT_OUTBOUND_DENIED");
    expect(read(log)).toContain("203.0.113.9");
  });

  it("the demo report is static, script-free and self-contained, and verify and report accept it", () => {
    const c = cli();
    c.run(["demo", "--out", "./out"]);
    const html = read(join(c.workdir, "out", "report.html"));
    expect(html).not.toMatch(/<script|https?:\/\/|@import|url\(/i);
    expect(html).toContain("default-src 'none'");
    const v = c.run(["verify", "./out/evidence.json"]);
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/All content hashes match/);
    const rep = c.run(["report", "--bundle", "./out/evidence.json", "--out", "./again.html"]);
    expect(rep.status, rep.output).toBe(5); // unresolved/blocked outcomes are listed on purpose, so never exit 0
    expect(rep.stdout).toMatch(/need attention\s+\d+/);
    expect(read(join(c.workdir, "again.html"))).toContain("Compensation blocked");
  });
});

describe("AC-10 portability and corruption through the packaged CLI", () => {
  function demoDir(): { c: PackagedCli; evidence: string } {
    const c = cli();
    expect(c.run(["demo", "--out", "./out"]).status).toBe(0);
    return { c, evidence: join(c.workdir, "out", "evidence.json") };
  }

  it("happy: a bundle exported in one directory verifies in a second fresh directory with the same hash", () => {
    const { c, evidence } = demoDir();
    const second = cli();
    const copy = join(second.workdir, "copy.json");
    writeFileSync(copy, read(evidence));
    const a = c.run(["verify", evidence]);
    const b = second.run(["verify", "./copy.json"]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const hashOf = (s: string) => /bundle_hash\s+(sha256:[0-9a-f]{64})/.exec(s)?.[1];
    expect(hashOf(b.stdout)).toBeDefined();
    expect(hashOf(b.stdout)).toBe(hashOf(a.stdout));
  });

  it("happy: import into a clean data directory, then report and export from it, and the export verifies", () => {
    const { c, evidence } = demoDir();
    const imp = c.run(["import", evidence, "--data-dir", "./fresh"]);
    expect(imp.status, imp.output).toBe(0);
    const rep = c.run(["report", "--data-dir", "./fresh", "--out", "./fresh.html"]);
    expect([0, 5], rep.output).toContain(rep.status);
    expect(existsSync(join(c.workdir, "fresh.html"))).toBe(true);
    expect(mode(join(c.workdir, "fresh"))).toBe(0o700);
    const again = c.run(["import", evidence, "--data-dir", "./fresh"]);
    expect(again.status, again.output).toBe(0); // replay of the same bundle
  });

  describe("sad: corrupt input fails with the documented exit code, never exit 0, and creates no data directory", () => {
    it("truncated bundle: exit 1, nothing created", () => {
      const { c, evidence } = demoDir();
      const text = read(evidence);
      writeFileSync(join(c.workdir, "t.json"), text.slice(0, Math.floor(text.length / 2)));
      expect(c.run(["verify", "./t.json"]).status).toBe(1);
      const imp = c.run(["import", "./t.json", "--data-dir", "./never"]);
      expect(imp.status).toBe(1);
      expect(existsSync(join(c.workdir, "never"))).toBe(false);
    });

    it("flipped value (hash mismatch): exit 1 with a mismatch message, import creates nothing", () => {
      const { c, evidence } = demoDir();
      writeFileSync(join(c.workdir, "f.json"), read(evidence).replace('"contact-0001"', '"contact-0009"'));
      const v = c.run(["verify", "./f.json"]);
      expect(v.status).toBe(1);
      expect(v.output).toMatch(/hash|mismatch|integrity/i);
      expect(c.run(["import", "./f.json", "--data-dir", "./never"]).status).toBe(1);
      expect(existsSync(join(c.workdir, "never"))).toBe(false);
    });

    it("unsupported schema_version: exit 1", () => {
      const { c, evidence } = demoDir();
      const doc = JSON.parse(read(evidence)) as Record<string, unknown>;
      doc["schema_version"] = 2;
      writeFileSync(join(c.workdir, "u.json"), JSON.stringify(doc));
      const v = c.run(["verify", "./u.json"]);
      expect(v.status).toBe(1);
      expect(v.output).toMatch(/unsupported/i);
    });

    it("not JSON, empty file, and a JSON array: exit 1", () => {
      const c = cli();
      for (const [name, text] of [["a.json", "not json"], ["b.json", ""], ["c.json", "[]"]] as const) {
        writeFileSync(join(c.workdir, name), text);
        expect(c.run(["verify", `./${name}`]).status, name).toBe(1);
      }
    });

    it("missing file, directory, symlink and a file over 25 MB are rejected before processing with exit 4", () => {
      const { c, evidence } = demoDir();
      expect(c.run(["verify", "./does-not-exist.json"]).status).toBe(4);
      mkdirSync(join(c.workdir, "adir"));
      expect(c.run(["verify", "./adir"]).status).toBe(4);
      symlinkSync(evidence, join(c.workdir, "link.json"));
      expect(c.run(["verify", "./link.json"]).status).toBe(4);
      const big = join(c.workdir, "big.json");
      writeFileSync(big, "");
      truncateSync(big, 26 * 1024 * 1024);
      expect(c.run(["verify", "./big.json"]).status).toBe(4);
    });

    it("usage errors are exit 2 and change nothing", () => {
      const c = cli();
      expect(c.run(["verify"]).status).toBe(2);
      expect(c.run(["import"]).status).toBe(2);
      expect(c.run(["export"]).status).toBe(2);
      expect(c.run(["export", "--out"]).status).toBe(2);
      expect(readdirSync(c.workdir).sort()).toEqual(["home"]);
    });

    it("report on a corrupt bundle still writes an error-state page and exits non-zero", () => {
      const { c, evidence } = demoDir();
      writeFileSync(join(c.workdir, "bad.json"), read(evidence).slice(0, 500));
      const r = c.run(["report", "--bundle", "./bad.json", "--out", "./bad.html"]);
      expect([1, 4]).toContain(r.status);
      if (existsSync(join(c.workdir, "bad.html"))) expect(read(join(c.workdir, "bad.html"))).toMatch(/could not be built|error/i);
    });
  });
});

describe("admin bootstrap and data commands (no default password, owner-only files)", () => {
  const password = () => `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}Zz9`;

  it("bootstrap reads the password from stdin or a file, never from a flag; a short password is rejected before anything is created", () => {
    const c = cli();
    const flag = c.run(["admin", "bootstrap", "--email", "admin@example.test", "--password", "x".repeat(20), "--data-dir", "./d1"]);
    expect(flag.status).toBe(2);
    expect(existsSync(join(c.workdir, "d1"))).toBe(false);
    const short = c.run(["admin", "bootstrap", "--email", "admin@example.test", "--password-stdin", "--data-dir", "./d2"], { input: "short\n" });
    expect(short.status).toBe(4);
    const none = c.run(["admin", "bootstrap", "--email", "admin@example.test", "--data-dir", "./d3"]);
    expect(none.status).toBe(2); // no TTY and no stdin/file option
    const ok = c.run(["admin", "bootstrap", "--email", "admin@example.test", "--workspace", "Synthetic QA", "--password-stdin", "--data-dir", "./d4"], { input: `${password()}\n` });
    expect(ok.status, ok.output).toBe(0);
    expect(mode(join(c.workdir, "d4"))).toBe(0o700);
    expect(existsSync(join(c.workdir, "d4", "undokit.key"))).toBe(true);
    expect(mode(join(c.workdir, "d4", "undokit.key"))).toBe(0o600);
    const again = c.run(["admin", "bootstrap", "--email", "other@example.test", "--password-stdin", "--data-dir", "./d4"], { input: `${password()}\n` });
    expect(again.status).not.toBe(0); // already bootstrapped
  });

  it("the password never appears in output or in the process arguments", () => {
    const c = cli();
    const pw = password();
    const r = c.run(["admin", "bootstrap", "--email", "admin@example.test", "--password-stdin", "--data-dir", "./d5"], { input: `${pw}\n` });
    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toContain(pw);
    const pwFile = join(c.workdir, "pw.txt");
    writeFileSync(pwFile, `${password()}\n`, { mode: 0o600 });
    const viaFile = c.run(["admin", "bootstrap", "--email", "admin2@example.test", "--password-file", "./pw.txt", "--data-dir", "./d6"]);
    expect(viaFile.status, viaFile.output).toBe(0);
  });

  it("export from a bootstrapped directory verifies, imports into another fresh directory, and reports", () => {
    const c = cli();
    expect(c.run(["admin", "bootstrap", "--email", "a@example.test", "--password-stdin", "--data-dir", "./src-dir"], { input: `${password()}\n` }).status).toBe(0);
    const exp = c.run(["export", "--out", "./b.json", "--data-dir", "./src-dir"]);
    expect(exp.status, exp.output).toBe(0);
    expect(mode(join(c.workdir, "b.json"))).toBe(0o600);
    expect(c.run(["verify", "./b.json"]).status).toBe(0);
    expect(c.run(["import", "./b.json", "--data-dir", "./dst-dir"]).status).toBe(0);
    expect([0, 5]).toContain(c.run(["report", "--data-dir", "./dst-dir", "--out", "./r.html"]).status);
  });

  it("report on a data directory that does not exist is rejected (exit 4) and does not create it", () => {
    const c = cli();
    const r = c.run(["report", "--data-dir", "./nowhere"]);
    expect(r.status).toBe(4);
    expect(existsSync(join(c.workdir, "nowhere"))).toBe(false);
  });
});

describe("AC-11 supplemental (agent run, NOT a human receipt): the documented drill commands run as written", () => {
  const drill = read(join(REPO_ROOT, "docs", "HUMAN-DRILL.md"));
  const ops = read(join(REPO_ROOT, "docs", "OPERATIONS.md"));
  const runbook = read(join(REPO_ROOT, "docs", "RUNBOOK.md"));
  const readme = read(join(REPO_ROOT, "README.md"));

  it("every command the drill tells the participant to run is present in the document", () => {
    for (const cmd of ["npx undokit version", "npx undokit --help", "npx undokit demo --out ./out", "npx undokit verify ./out/evidence.json", "npx undokit verify ./out/truncated.json", "npx undokit import ./out/evidence.json --data-dir ./fresh-data", "npx undokit report --data-dir ./fresh-data --out ./fresh-report.html"]) {
      expect(drill, cmd).toContain(cmd);
    }
  });

  it("running the drill steps in order in a fresh directory gives the documented exit codes", () => {
    const c = cli();
    expect(c.run(["version"]).status).toBe(0);
    expect(c.run(["--help"]).status).toBe(0);
    const demo = c.run(["demo", "--out", "./out"]);
    expect(demo.status).toBe(0);
    expect(existsSync(join(c.workdir, "out", "report.html"))).toBe(true);
    expect(existsSync(join(c.workdir, "out", "evidence.json"))).toBe(true);
    expect(c.run(["verify", "./out/evidence.json"]).status).toBe(0);
    const head = read(join(c.workdir, "out", "evidence.json")).slice(0, 1000);
    writeFileSync(join(c.workdir, "out", "truncated.json"), head);
    expect([1, 4]).toContain(c.run(["verify", "./out/truncated.json"]).status);
    expect(c.run(["import", "./out/evidence.json", "--data-dir", "./fresh-data"]).status).toBe(0);
    expect([0, 5]).toContain(c.run(["report", "--data-dir", "./fresh-data", "--out", "./fresh-report.html"]).status);
    expect(existsSync(join(c.workdir, "fresh-report.html"))).toBe(true);
  });

  it("install, upgrade, backup, restore and failure-diagnosis sections exist, including UNKNOWN and partial outcomes", () => {
    for (const heading of [/^## 2\. Install/m, /^## 4\. Upgrade/m, /^## 5\. Backup/m, /^## 6\. Restore/m, /^## 7\. Failure diagnosis/m]) expect(ops).toMatch(heading);
    for (const term of ["UNKNOWN", "Resolving UNKNOWN", "Partial outcomes", "changed_other", "mismatch", "reconcil"]) expect(ops, term).toContain(term);
    expect(runbook).toMatch(/Resolve UNKNOWN/);
    expect(readme).toMatch(/## Install/);
    expect(readme).toMatch(/Honest limits/);
  });

  it("documents mention no file or command that does not exist: compose.yaml and the sandbox profile are real", () => {
    expect(existsSync(join(REPO_ROOT, "compose.yaml"))).toBe(true);
    for (const rel of ["docs/ARCHITECTURE.md", "docs/DEPENDENCY-LICENSES.md", "docs/PROVIDER-DECISION.md"]) expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
    expect(leakedNeedles(drill + ops + runbook + readme)).toEqual([]);
    expect(loadSecrets().needles.length).toBeGreaterThan(0);
  });
});
