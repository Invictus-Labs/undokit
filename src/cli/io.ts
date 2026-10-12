import { closeSync, fchmodSync, openSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { CliError, EXIT } from "./exit.js";

export interface Streams {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const processStreams: Streams = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** Package version read from the nearest package.json (works from src/ and dist/src/). */
export function packageVersion(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "undokit" && typeof parsed.version === "string") return parsed.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

/**
 * Prompt for a secret on a TTY without echo. Refuses when stdin is not a TTY so
 * a password is never read from an accidental pipe; scripts must pass
 * --password-file or --password-stdin explicitly.
 */
export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("No terminal available to prompt for a password; use --password-stdin or --password-file");
  }
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const writable = rl as unknown as { _writeToOutput: (text: string) => void };
    process.stderr.write(`${label}: `);
    writable._writeToOutput = () => undefined;
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    rl.on("error", reject);
  });
}

/** Read all of stdin (for --password-stdin). Bounded so a runaway pipe cannot exhaust memory. */
export async function readStdin(limitBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limitBytes) throw new Error(`stdin exceeded ${limitBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a user-supplied file: regular files only (no symlinks, devices or directories) and bounded in size, checked before reading. */
export function readInputFile(path: string, maxBytes: number): string {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw new CliError(EXIT.INVALID_INPUT, `Cannot read ${path}: file not found`);
  }
  if (info.isSymbolicLink()) throw new CliError(EXIT.INVALID_INPUT, `Refusing to read ${path}: symbolic links are not followed`);
  if (!info.isFile()) throw new CliError(EXIT.INVALID_INPUT, `Refusing to read ${path}: not a regular file`);
  if (info.size > maxBytes) throw new CliError(EXIT.INVALID_INPUT, `${path} is ${info.size} bytes, over the ${maxBytes} byte limit; nothing was read`);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new CliError(EXIT.INVALID_INPUT, `Cannot read ${path}: permission denied or unreadable`);
  }
}

/**
 * Write a file all-or-nothing: temp file in the same directory, then rename. A
 * pre-existing symlink or directory at the target is refused so an output path
 * can never be redirected. New directories and files are owner-only.
 */
export function writeOutputFile(path: string, data: string, mode = 0o600): void {
  const target = resolve(path);
  try {
    const existing = lstatSync(target);
    if (existing.isSymbolicLink()) throw new CliError(EXIT.INVALID_INPUT, `Refusing to write ${path}: it is a symbolic link`);
    if (!existing.isFile()) throw new CliError(EXIT.INVALID_INPUT, `Refusing to write ${path}: not a regular file`);
  } catch (error) {
    if (error instanceof CliError) throw error;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeFileSync(fd, data);
      // The explicit output mode also applies under a restrictive inherited umask.
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* nothing to clean up */
    }
    throw new CliError(EXIT.FAILURE, `Could not write ${path}: ${(error as NodeJS.ErrnoException).code ?? "write failed"}`);
  }
}
