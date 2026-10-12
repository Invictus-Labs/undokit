/**
 * Opening the library for a CLI command: data directory resolution, a
 * single-process lock for the embedded database, and the actor the local OS
 * user acts as. The CLI trusts the local OS user and exposes no network port;
 * multi-user authorization is the daemon's job.
 */

import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { AppError, loadConfig, redactText, resolveKeyRingChecked, createUndoKit, type Actor, type ServerConfig, type UndoKit } from "../index.js";
import { CliError, EXIT } from "./exit.js";

export function configFor(dataDir: string | undefined, env: Record<string, string | undefined> = process.env): ServerConfig {
  const config = loadConfig(env);
  if (dataDir === undefined) return config;
  const dir = resolve(dataDir);
  return { ...config, databaseUrl: `pglite://${dir}/db`, keyFile: config.keyBase64 ? config.keyFile : (config.keyFile ?? `${dir}/undokit.key`) };
}

/**
 * An explicitly configured key file (UNDOKIT_KEY_FILE) may live outside the data directory so the key
 * is kept apart from the database. A first run may create a key inside the data directory, but a missing
 * key at an explicit outside path is an error: silently minting a new key there would make existing data
 * unreadable and hide a misconfigured path.
 */
export function assertKeyLocation(config: ServerConfig): void {
  if (config.keyBase64 || config.keyFile === undefined) return;
  const key = resolve(config.keyFile);
  if (existsSync(key)) return;
  const dbDir = pgliteDir(config.databaseUrl);
  const dataDir = dbDir === null ? null : dirname(dbDir);
  if (dataDir !== null && key.startsWith(`${dataDir}/`)) return;
  throw new CliError(EXIT.FAILURE, `Encryption key file not found: ${key}`, "Point UNDOKIT_KEY_FILE at the existing key, or create the key file yourself (owner-only, 0600) before the first run.");
}

function pgliteDir(url: string): string | null {
  return url.startsWith("pglite://") && url !== "pglite://memory" ? resolve(url.slice("pglite://".length)) : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The embedded database allows one process at a time; two writers would corrupt it.
 * A pid lock file refuses a second opener and recovers from a crashed holder.
 */
/** Lock files this process currently holds. A lock file with our own pid that is not in here is a leftover (container pid 1, pid reuse). */
const heldLocks = new Set<string>();

/** The holder touches the lock file this often; a lock nobody has touched for LOCK_STALE_MS has no live holder. */
export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_STALE_MS = 30_000;

interface LockInfo {
  pid: number;
  /** Absent in a lock written by an older version; treated as this machine. */
  host: string | undefined;
}

function readLock(lockPath: string): LockInfo {
  const [pidText, host] = readFileSync(lockPath, "utf8").trim().split(/\s+/);
  return { pid: /^\d+$/.test(pidText ?? "") ? Number(pidText) : Number.NaN, host };
}

/**
 * Is the lock held by a live other holder?
 * - Same host name (this machine or container): decided by the process table. Our own pid in a lock this
 *   process does not hold is stale (unclean stop in a container, pid 1 again, or pid reuse).
 * - Different host name (another container or machine sharing the volume): pids are not comparable, so the
 *   holder's heartbeat decides: a lock touched within LOCK_STALE_MS is live.
 * Known limit: two containers configured with the SAME host name and the same pid that share one volume look
 * like one container restarting; give each its own hostname. Heartbeat freshness also assumes the clocks of
 * machines sharing a network volume agree to within LOCK_STALE_MS.
 */
function holderIsLive(lockPath: string, info: LockInfo): { live: boolean; description: string } {
  // A lock whose first token is not a pid is unreadable, so nothing provably holds it: stale.
  if (!Number.isInteger(info.pid)) return { live: false, description: "an unreadable lock" };
  const sameHost = info.host === undefined || info.host === hostname();
  if (sameHost) {
    const live = info.pid === process.pid ? heldLocks.has(lockPath) : Number.isInteger(info.pid) && isAlive(info.pid);
    return { live, description: `process ${info.pid}` };
  }
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    /* vanished: no holder */
  }
  return { live: ageMs < LOCK_STALE_MS, description: `process ${info.pid} on host ${info.host ?? "unknown"} (last heartbeat ${Math.max(0, Math.round(ageMs / 1000))}s ago)` };
}

/**
 * Create the lock file with its content already in place, failing with EEXIST if it exists. The content is
 * written to a private temp file and then hard-linked into place (link never replaces), so a competitor can
 * never read a created-but-empty lock and mistake it for a stale one. Filesystems without hard links fall back
 * to an exclusive create, which has that small window.
 */
function createLockFile(lockPath: string, content: string): void {
  const temp = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    if (code !== "EPERM" && code !== "ENOSYS" && code !== "EXDEV" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    const direct = openSync(lockPath, "wx", 0o600);
    try {
      writeSync(direct, content);
    } finally {
      closeSync(direct);
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
  }
}

function acquireLock(dbDir: string): () => void {
  const lockPath = `${dbDir}.lock`;
  // A first run has no data directory yet; create it owner-only, as the help text promises.
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const content = `${process.pid} ${hostname()}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      createLockFile(lockPath, content);
      heldLocks.add(lockPath);
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(lockPath, now, now);
        } catch {
          /* the lock was removed; release will notice */
        }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        heldLocks.delete(lockPath);
        process.removeListener("exit", release);
        try {
          // Only remove a lock that is still ours; a takeover after a long stall owns the file now.
          if (readFileSync(lockPath, "utf8") === content) unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CliError(EXIT.FAILURE, `Could not lock the data directory: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
      let state: { live: boolean; description: string };
      try {
        state = holderIsLive(lockPath, readLock(lockPath));
      } catch {
        continue; // removed between the failed create and the read: retry
      }
      if (state.live) {
        throw new CliError(EXIT.FAILURE, `The data directory is in use by ${state.description}`, "Stop 'undokit serve' (or the other command) before opening the same data directory.");
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* raced with another cleaner; retry */
      }
    }
  }
  throw new CliError(EXIT.FAILURE, "Could not lock the data directory", "Remove a stale lock file next to the database directory if no undokit process is running.");
}

/** Lock the embedded database directory for this process; a no-op for in-memory and PostgreSQL URLs. */
export function acquireDataLock(databaseUrl: string): () => void {
  const dir = pgliteDir(databaseUrl);
  return dir === null ? (): void => undefined : acquireLock(dir);
}

export interface OpenedKit {
  kit: UndoKit;
  config: ServerConfig;
  close(): Promise<void>;
}

/** `create: false` refuses to create a data directory or key: read-only commands must not invent state. */
export async function openKit(config: ServerConfig, opts: { create: boolean }): Promise<OpenedKit> {
  const dir = pgliteDir(config.databaseUrl);
  if (dir !== null && !opts.create && !existsSync(dir)) {
    throw new CliError(EXIT.INVALID_INPUT, `Data directory not found: ${basename(dir) === "db" ? dirname(dir) : dir}`, "Check --data-dir, or run 'undokit admin bootstrap' to create one.");
  }
  assertKeyLocation(config);
  // The lock comes first: checking whether the database already holds data opens it, and only one process may.
  const release = acquireDataLock(config.databaseUrl);
  const unreachable = (): CliError => new CliError(EXIT.DISCONNECTED, "The database is not reachable. Nothing was written.", "Check UNDOKIT_DATABASE_URL and that the database is running.");
  let keyring;
  try {
    keyring = await resolveKeyRingChecked(config, { create: opts.create });
  } catch (error) {
    release();
    if (/encryption key/i.test((error as Error).message)) {
      throw new CliError(EXIT.FAILURE, redactText((error as Error).message), "The encryption key is operator-managed and stored outside the database; restore it from your separate backup.");
    }
    if (config.databaseUrl.startsWith("postgres")) throw unreachable();
    throw error;
  }
  try {
    const kit = await createUndoKit({ databaseUrl: config.databaseUrl, keyring, config: config.service });
    return {
      kit,
      config,
      async close() {
        try {
          await kit.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    if (config.databaseUrl.startsWith("postgres")) throw unreachable();
    throw error;
  }
}

/**
 * The workspace member the local OS user acts as: the first admin, else the first operator (the
 * non-loginable system actor of a clean-install import is an operator). Null when nothing is set up yet.
 */
export async function localActor(kit: UndoKit, workspaceId?: string): Promise<Actor | null> {
  const where = workspaceId ? "AND workspace_id = $1::uuid" : "";
  const result = await kit.db.query<{ workspace_id: string; user_id: string; role: "admin" | "operator" }>(
    `SELECT workspace_id, user_id, role FROM memberships WHERE role IN ('admin', 'operator') ${where}
      ORDER BY (role = 'admin') DESC, created_at, workspace_id, user_id LIMIT 1`,
    workspaceId ? [workspaceId] : [],
  );
  const row = result.rows[0];
  return row ? { workspace_id: row.workspace_id, user_id: row.user_id, role: row.role } : null;
}

/** Map library and runtime errors to a CliError with a stable exit code and a redacted message. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof AppError) {
    const detail = error.details?.length ? ` (${error.details.slice(0, 5).map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join("; ")})` : "";
    const message = `${redactText(error.message)}${detail}`;
    switch (error.code) {
      case "PAYLOAD_TOO_LARGE":
      case "VALIDATION_FAILED":
      case "MALFORMED_REQUEST":
        return new CliError(EXIT.INVALID_INPUT, message, "Nothing was written.");
      case "BUNDLE_MALFORMED":
        // Invalid JSON or a missing completion marker is damage (1); a document that parses but breaks the schema is rejected input (4).
        return new CliError(error.details?.length ? EXIT.INVALID_INPUT : EXIT.FAILURE, message, "Nothing was changed.");
      case "BUNDLE_UNSUPPORTED":
      case "BUNDLE_INTEGRITY_FAILED":
        return new CliError(EXIT.FAILURE, message, "Nothing was changed.");
      case "CONNECTOR_UNAVAILABLE":
      case "DEPENDENCY_UNAVAILABLE":
        return new CliError(EXIT.DISCONNECTED, message, "Nothing was written.");
      case "NOT_READY":
        return new CliError(EXIT.FAILURE, message, "A migration did not complete. Restore the last verified snapshot; do not start workers.");
      default:
        return new CliError(EXIT.FAILURE, message);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(EXIT.FAILURE, redactText(message));
}
