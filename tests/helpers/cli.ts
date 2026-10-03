// Packaged-CLI harness (QA-owned).
//
// Builds the npm tarball from the current tree, extracts it into a fresh temp directory and runs the
// packaged executable (package.json "bin") from a second fresh temp working directory. This is what the
// CLI e2e tests invoke, so they exercise what a user would install, not the TypeScript sources.
//
// Requires `npm run build` to have produced dist/. If dist/ is missing the harness throws: a missing build
// is a failure, never a skip.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./fixtures.js";

export interface CliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for leak scans */
  output: string;
}

export interface PackagedCli {
  /** Fresh empty working directory for this harness instance. */
  workdir: string;
  /** Absolute path of the packaged executable inside the extracted tarball. */
  executable: string;
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number }): CliResult;
}

let cachedPackage: { root: string; executable: string } | undefined;

function packOnce(): { root: string; executable: string } {
  if (cachedPackage) return cachedPackage;
  if (!existsSync(join(REPO_ROOT, "dist"))) {
    throw new Error("dist/ is missing: run `npm run build` before the packaged-CLI tests");
  }
  const base = mkdtempSync(join(tmpdir(), "undokit-pack-"));
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", base], { cwd: REPO_ROOT, encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const tarball = readdirSync(base).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");
  const extract = join(base, "x");
  mkdirSync(extract);
  const tar = spawnSync("tar", ["-xzf", join(base, tarball), "-C", extract], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const pkgRoot = join(extract, "package");
  // Production dependencies come from the repo's installed node_modules (no network, no install).
  symlinkSync(join(REPO_ROOT, "node_modules"), join(pkgRoot, "node_modules"), "dir");
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.undokit;
  if (!bin) throw new Error("package.json has no bin.undokit entry");
  const executable = join(pkgRoot, bin);
  if (!existsSync(executable)) throw new Error(`packaged executable missing from tarball: ${bin}`);
  cachedPackage = { root: pkgRoot, executable };
  return cachedPackage;
}

export function createPackagedCli(): PackagedCli {
  const pkg = packOnce();
  const workdir = mkdtempSync(join(tmpdir(), "undokit-e2e-"));
  const home = join(workdir, "home");
  mkdirSync(home);
  return {
    workdir,
    executable: pkg.executable,
    run(args, opts = {}) {
      const r = spawnSync(process.execPath, [pkg.executable, ...args], {
        cwd: opts.cwd ?? workdir,
        encoding: "utf8",
        input: opts.input,
        timeout: opts.timeoutMs ?? 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TMPDIR: workdir,
          NO_COLOR: "1",
          ...opts.env,
        },
      });
      return {
        status: r.status,
        signal: r.signal,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      };
    },
  };
}
