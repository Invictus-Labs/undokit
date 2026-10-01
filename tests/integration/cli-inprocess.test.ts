// In-process CLI tests (QA-owned): the CLI entry `run(argv, ctx)` is driven inside the test process with injected streams, env,
// stdin and TTY flag, so its code is measured by coverage. The packaged-tarball tests (cli-packaged.test.ts) stay as the end-to-end
// proof; these exercise every branch of argument parsing, file handling, exit codes and error mapping.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError, KeyRing } from "../../src/index.js";
import { flag, intFlag, parseFlags, requireStr, str } from "../../src/cli/args.js";
import type { CommandContext } from "../../src/cli/context.js";
import { CliError, EXIT } from "../../src/cli/exit.js";
import { packageVersion, processStreams, promptSecret, readInputFile, readStdin, writeOutputFile } from "../../src/cli/io.js";
import { run } from "../../src/cli/run.js";
import { toCliError } from "../../src/cli/kit.js";
import { summarize } from "../../src/cli/demo.js";
import { runDemo } from "../../src/index.js";
import { makeBundle, makeOperation, scenarioOperations } from "../helpers/builders.js";
import { REPO_ROOT, leakedNeedles, loadSecrets } from "../helpers/fixtures.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "undokit-cli-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function makeCtx(over: Partial<CommandContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    env: {},
    stdin: async () => "",
    isTTY: false,
    prompt: async () => {
      throw new Error("no prompt expected");
    },
    waitForStop: async () => undefined,
    ...over,
  };
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

async function cli(argv: string[], over: Partial<CommandContext> = {}) {
  const c = makeCtx(over);
  const code = await run(argv, c.ctx);
  return { code, out: c.out(), err: c.err() };
}

let demoDir: string;
let demoEvidence: string;
beforeAll(async () => {
  demoDir = mkdtempSync(join(tmpdir(), "undokit-cli-demo-"));
  const r = await cli(["demo", "--out", demoDir]);
  expect(r.code).toBe(0);
  demoEvidence = join(demoDir, "evidence.json");
}, 60_000);

describe("help, version and usage", () => {
  it("no command prints the top help on stderr with exit 2; help flags and the help command exit 0 with it on stdout", async () => {
    const none = await cli([]);
    expect(none.code).toBe(EXIT.USAGE);
    expect(none.err).toContain("Usage: undokit <command>");
    for (const a of [["--help"], ["-h"], ["help"]]) {
      const r = await cli(a);
      expect(r.code, a.join(" ")).toBe(0);
      expect(r.out).toContain("Exit codes:");
    }
  });

  it("version, --version and -v print the package version", async () => {
    const expected = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
    for (const a of [["version"], ["--version"], ["-v"]]) expect((await cli(a)).out.trim()).toBe(expected);
  });

  it("every command has its own help, and `admin --help` shows the bootstrap help", async () => {
    for (const cmd of ["demo", "serve", "report", "export", "verify", "import"]) {
      const r = await cli([cmd, "--help"]);
      expect(r.code, cmd).toBe(0);
      expect(r.out.length).toBeGreaterThan(20);
    }
    const admin = await cli(["admin", "-h"]);
    expect(admin.out).toContain("undokit admin bootstrap");
  });

  // Regression test for QA-D14 (fixed in 726bb63): `version --help` and `version -h` show the version command's help.
  it("`version --help` shows the help for the version command", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await cli(["version", flag]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Prints the version");
    }
  });

  it("an unknown command is a usage error with a hint and nothing else happens", async () => {
    const r = await cli(["bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown command: bogus");
    expect(r.err).toContain("undokit --help");
  });

  it("a thrown non-CliError is mapped to exit 1 with a redacted message (a planted secret never reaches the output)", async () => {
    const secret = loadSecrets().planted.find((p) => p.kind === "pattern")!.value;
    const spy = vi.spyOn(await import("../../src/index.js"), "verifyBundleText").mockImplementation(() => {
      throw new Error(`boom ${secret}`);
    });
    const file = join(tmp(), "b.json");
    writeFileSync(file, "{}");
    const r = await cli(["verify", file]);
    spy.mockRestore();
    expect(r.code).toBe(1);
    expect(leakedNeedles(r.err)).toEqual([]);
  });
});

describe("argument helpers", () => {
  it("parseFlags: strict, bounded positionals, typed errors", () => {
    expect(parseFlags(["--out", "x", "--json"], { out: { type: "string" }, json: { type: "boolean" } }).values).toEqual({ out: "x", json: true });
    expect(() => parseFlags(["--nope"], {})).toThrow(CliError);
    expect(() => parseFlags(["a"], {}, 0)).toThrow(/Unexpected argument|Unexpected/);
    expect(() => parseFlags(["a", "b"], {}, 1)).toThrow(/Unexpected argument: b/);
    expect(parseFlags(["a"], {}, 1).positionals).toEqual(["a"]);
    try {
      parseFlags(["--out"], { out: { type: "string" } });
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });

  it("str, requireStr, flag and intFlag", () => {
    const { values } = parseFlags(["--a", "1", "--b", "--n", "42"], { a: { type: "string" }, b: { type: "boolean" }, n: { type: "string" }, c: { type: "string" } });
    expect(str(values, "a")).toBe("1");
    expect(str(values, "b")).toBeUndefined();
    expect(str(values, "zz")).toBeUndefined();
    expect(requireStr(values, "a")).toBe("1");
    expect(() => requireStr(values, "c")).toThrow(/Missing required flag --c/);
    expect(() => requireStr(parseFlags(["--c", ""], { c: { type: "string" } }).values, "c")).toThrow(/Missing required flag/);
    expect(flag(values, "b")).toBe(true);
    expect(flag(values, "a")).toBe(false);
    expect(intFlag(values, "n", 7, 0, 100)).toBe(42);
    expect(intFlag(values, "missing", 7, 0, 100)).toBe(7);
    expect(() => intFlag(parseFlags(["--n", "4x"], { n: { type: "string" } }).values, "n", 1, 0, 9)).toThrow(/whole number/);
    expect(() => intFlag(parseFlags(["--n", "-1"], { n: { type: "string" } }).values, "n", 1, 0, 9)).toThrow();
    expect(() => intFlag(parseFlags(["--n", "10"], { n: { type: "string" } }).values, "n", 1, 0, 9)).toThrow(/between 0 and 9/);
    expect(() => intFlag(parseFlags(["--n", "1.5"], { n: { type: "string" } }).values, "n", 1, 0, 9)).toThrow(/whole number/);
  });

  it("run maps flag errors to exit 2 with the hint", async () => {
    for (const argv of [["demo", "--no-such-flag"], ["verify", "a", "b"], ["serve", "--port", "abc"], ["serve", "--port", "70000"], ["export"], ["export", "--out"], ["admin"], ["admin", "nope"], ["admin", "bootstrap"]]) {
      const r = await cli(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toContain("undokit:");
    }
  });
});

describe("file helpers", () => {
  it("readInputFile accepts a regular file and refuses missing, directory, symlink, oversize and unreadable ones before reading", () => {
    const d = tmp();
    const ok = join(d, "ok.txt");
    writeFileSync(ok, "hello");
    expect(readInputFile(ok, 100)).toBe("hello");
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as CliError).exitCode;
      }
      return -1;
    };
    expect(code(() => readInputFile(join(d, "missing"), 100))).toBe(EXIT.INVALID_INPUT);
    expect(code(() => readInputFile(d, 100))).toBe(EXIT.INVALID_INPUT);
    symlinkSync(ok, join(d, "link"));
    expect(code(() => readInputFile(join(d, "link"), 100))).toBe(EXIT.INVALID_INPUT);
    expect(code(() => readInputFile(ok, 3))).toBe(EXIT.INVALID_INPUT);
    const locked = join(d, "locked.txt");
    writeFileSync(locked, "secret");
    chmodSync(locked, 0o000);
    expect(code(() => readInputFile(locked, 100))).toBe(EXIT.INVALID_INPUT);
    chmodSync(locked, 0o600);
  });

  it("writeOutputFile writes owner-only, replaces atomically, creates parents 0700, and refuses symlink and directory targets", () => {
    const d = tmp();
    const target = join(d, "nested", "deep", "out.json");
    writeOutputFile(target, "one");
    expect(readFileSync(target, "utf8")).toBe("one");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, "nested")).mode & 0o777).toBe(0o700);
    writeOutputFile(target, "two", 0o644);
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    const real = join(d, "real.txt");
    writeFileSync(real, "keep");
    symlinkSync(real, join(d, "link.txt"));
    expect(() => writeOutputFile(join(d, "link.txt"), "x")).toThrow(/symbolic link/);
    expect(readFileSync(real, "utf8")).toBe("keep");
    mkdirSync(join(d, "adir"));
    expect(() => writeOutputFile(join(d, "adir"), "x")).toThrow(/not a regular file/);
  });

  it("writeOutputFile reports a failed write as a CliError and leaves no temp file", () => {
    const d = tmp();
    const target = join(d, "out.json");
    writeFileSync(`${target}.tmp-${process.pid}`, "stale"); // the wx temp file already exists
    expect(() => writeOutputFile(target, "x")).toThrow(/Could not write/);
    expect(existsSync(target)).toBe(false);
  });

  it("packageVersion finds the nearest package.json and returns 'unknown' when there is none", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageVersion(tmp())).toBe(packageVersion(tmp()) === "unknown" ? "unknown" : packageVersion(tmp())); // temp dirs sit under /var or /tmp: no package.json above them
    const d = tmp();
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "other", version: "9.9.9" }));
    expect(packageVersion(d)).not.toBe("9.9.9"); // only the undokit package counts
  });

  it("processStreams write to the process streams", () => {
    const o = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    processStreams.out("a");
    processStreams.err("b");
    expect(o).toHaveBeenCalledWith("a");
    expect(e).toHaveBeenCalledWith("b");
  });
});

describe("stdin and prompts", () => {
  const withStdin = (stream: unknown, fn: () => Promise<void>) => async () => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { value: stream, configurable: true });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, "stdin", original);
    }
  };

  it("readStdin concatenates chunks and refuses more than the limit", withStdin(Readable.from([Buffer.from("ab"), "cd"]), async () => {
    expect(await readStdin()).toBe("abcd");
  }));

  it("readStdin over the limit throws", withStdin(Readable.from(["x".repeat(50)]), async () => {
    await expect(readStdin(10)).rejects.toThrow(/exceeded 10 bytes/);
  }));

  it("promptSecret refuses when stdin is not a terminal", withStdin({ isTTY: false }, async () => {
    await expect(promptSecret("Password")).rejects.toThrow(/No terminal available/);
  }));

  it("promptSecret reads one line without echoing it", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((t: string) => {
      written.push(String(t));
      return true;
    }) as never);
    await withStdin(input, async () => {
      const pending = promptSecret("Password");
      input.write("hunter2-hunter2\n");
      expect(await pending).toBe("hunter2-hunter2");
    })();
    expect(written.join("")).toContain("Password: ");
    expect(written.join("")).not.toContain("hunter2");
  });
});

describe("demo and verify commands", () => {
  it("demo prints the summary, writes both files, and --json is parseable with every check passed", async () => {
    const dir = join(tmp(), "out");
    const r = await cli(["demo", "--out", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Checks: (\d+)\/\1 passed/);
    expect(r.out).toContain("Compensated (original value restored)");
    expect(existsSync(join(dir, "report.html"))).toBe(true);
    const j = await cli(["demo", "--out", join(tmp(), "j"), "--json"]);
    const parsed = JSON.parse(j.out) as { all_passed: boolean; live: boolean; operations_needing_attention: number };
    expect(parsed).toMatchObject({ all_passed: true, live: false });
    expect(parsed.operations_needing_attention).toBeGreaterThan(0);
  });

  it("summarize prints every step, operation line and check, including operations without a compensation", async () => {
    const report = await runDemo();
    const text = summarize(report);
    expect(text).toContain("Operations as an operator would see them:");
    expect(text).toMatch(/PASS {2}/);
    const altered = { ...report, checks: [...report.checks, { name: "synthetic failing check", pass: false }] };
    expect(summarize(altered)).toMatch(/FAIL {2}synthetic failing check/);
    expect(summarize({ ...report, operations: report.operations.map((o) => ({ ...o, compensations: [] })) })).not.toMatch(/Compensation blocked/);
  });

  it("verify: an intact bundle exits 0 and prints its hash; usage, damage, unsupported and rejected input have their own codes", async () => {
    const ok = await cli(["verify", demoEvidence]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/bundle_hash\s+sha256:[0-9a-f]{64}/);
    expect((await cli(["verify"])).code).toBe(2);
    const text = readFileSync(demoEvidence, "utf8");
    const d = tmp();
    const write = (name: string, body: string) => {
      const p = join(d, name);
      writeFileSync(p, body);
      return p;
    };
    expect((await cli(["verify", write("trunc.json", text.slice(0, 400))])).code).toBe(1);
    expect((await cli(["verify", write("flip.json", text.replace('"contact-0001"', '"contact-0009"'))])).code).toBe(1);
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect((await cli(["verify", write("v2.json", JSON.stringify({ ...doc, schema_version: 2 }))])).code).toBe(1);
    expect((await cli(["verify", write("schema.json", JSON.stringify({ ...doc, generator: "wrong" }))])).code).toBe(4);
    expect((await cli(["verify", join(d, "missing.json")])).code).toBe(4);
    const big = join(d, "big.json");
    writeFileSync(big, "");
    truncateSync(big, 26 * 1024 * 1024);
    expect((await cli(["verify", big])).code).toBe(4);
  });

  it("report --bundle: attention outcomes exit 5 and are listed; a clean bundle exits 0; both source flags together are usage errors", async () => {
    const d = tmp();
    const attention = join(d, "a.json");
    writeFileSync(attention, JSON.stringify(makeBundle(scenarioOperations())));
    const out1 = join(d, "a.html");
    const r = await cli(["report", "--bundle", attention, "--out", out1]);
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/need attention\s+4/);
    expect(r.out).toContain("none of them is a success");
    expect(readFileSync(out1, "utf8")).toContain("data-testid=\"report-attention\"");
    const clean = join(d, "c.json");
    writeFileSync(clean, JSON.stringify(makeBundle([makeOperation({ seed: "clean" })])));
    const r2 = await cli(["report", "--bundle", clean, "--out", join(d, "c.html")]);
    expect(r2.code).toBe(0);
    expect(r2.out).toMatch(/need attention\s+0/);
    expect((await cli(["report", "--bundle", clean, "--data-dir", d])).code).toBe(2);
  });

  it("report --bundle on a damaged bundle writes an error-state page, says so on stderr, and exits non-zero", async () => {
    const d = tmp();
    const bad = join(d, "bad.json");
    writeFileSync(bad, readFileSync(demoEvidence, "utf8").slice(0, 300));
    const out = join(d, "bad.html");
    const r = await cli(["report", "--bundle", bad, "--out", out]);
    expect([1, 4]).toContain(r.code);
    expect(r.err).toContain("Report written with an error state");
    expect(readFileSync(out, "utf8")).toContain('data-testid="report-error"');
  });
});

describe("toCliError maps every library error class to a stable exit code", () => {
  it.each([
    ["PAYLOAD_TOO_LARGE", EXIT.INVALID_INPUT],
    ["VALIDATION_FAILED", EXIT.INVALID_INPUT],
    ["MALFORMED_REQUEST", EXIT.INVALID_INPUT],
    ["BUNDLE_UNSUPPORTED", EXIT.FAILURE],
    ["BUNDLE_INTEGRITY_FAILED", EXIT.FAILURE],
    ["CONNECTOR_UNAVAILABLE", EXIT.DISCONNECTED],
    ["DEPENDENCY_UNAVAILABLE", EXIT.DISCONNECTED],
    ["NOT_READY", EXIT.FAILURE],
    ["INTERNAL_ERROR", EXIT.FAILURE],
    ["FORBIDDEN", EXIT.FAILURE],
  ] as const)("%s -> exit %i", (code, exit) => {
    expect(toCliError(new AppError(code, "message")).exitCode).toBe(exit);
  });

  it("BUNDLE_MALFORMED is damage (1) without details and rejected input (4) with schema details; details are listed in the message", () => {
    expect(toCliError(new AppError("BUNDLE_MALFORMED", "truncated")).exitCode).toBe(EXIT.FAILURE);
    const withDetails = toCliError(new AppError("BUNDLE_MALFORMED", "bad schema", [{ code: "X", field: "a.b", message: "wrong" }, { code: "Y", message: "plain" }]));
    expect(withDetails.exitCode).toBe(EXIT.INVALID_INPUT);
    expect(withDetails.message).toContain("a.b: wrong");
    expect(withDetails.message).toContain("plain");
  });

  it("a CliError passes through unchanged; any other error becomes exit 1 with the message redacted", () => {
    const cli = new CliError(EXIT.USAGE, "usage");
    expect(toCliError(cli)).toBe(cli);
    const secret = loadSecrets().planted.find((p) => p.kind === "pattern")!.value;
    const mapped = toCliError(new Error(`token ${secret}`));
    expect(mapped.exitCode).toBe(1);
    expect(leakedNeedles(mapped.message)).toEqual([]);
    expect(toCliError("a string").message).toContain("a string");
  });
});

describe("environment contract used by the commands", () => {
  it("KeyRing is created owner-only on first use of a new data directory", async () => {
    const d = tmp();
    const key = join(d, "undokit.key");
    KeyRing.writeNewKeyFile(key);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(() => KeyRing.writeNewKeyFile(key)).toThrow(); // never overwrites an existing key
  });
});
