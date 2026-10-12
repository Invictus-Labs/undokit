import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execScript, type Db } from "./client.js";

export interface MigrationStatus {
  ok: boolean;
  /** Versions recorded as applied in schema_version. */
  applied: number[];
  /** Versions present on disk but not applied (empty when ok). */
  pending: number[];
  /** Highest version available on disk. */
  latest: number;
  error?: string;
}

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

/** Locate the shipped migrations directory from either src/ (tsx, vitest) or dist/src/ (compiled). */
export function defaultMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "migrations");
    if (existsSync(join(candidate, "001_initial.sql"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("migrations directory not found");
}

function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  return files.map((file) => {
    const sql = readFileSync(join(dir, file), "utf8");
    return {
      version: Number.parseInt(file.slice(0, 3), 10),
      name: file.slice(4, -4),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_version (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
)`;

/** Keep driver error text out of operator-facing status beyond its first line. */
function safeMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split("\n")[0] ?? "unknown error").slice(0, 300);
}

/**
 * Apply pending migrations, each in its own transaction. Any failure rolls that migration back
 * entirely and returns ok=false; callers must keep the service not-ready (AC-13). Applied migrations
 * whose checksum no longer matches the file on disk are treated as tampering and also fail.
 */
export async function runMigrations(db: Db, opts: { dir?: string; now?: () => Date } = {}): Promise<MigrationStatus> {
  let migrations: MigrationFile[];
  try {
    migrations = loadMigrations(opts.dir ?? defaultMigrationsDir());
  } catch (err) {
    return { ok: false, applied: [], pending: [], latest: 0, error: `cannot load migrations: ${safeMessage(err)}` };
  }
  const latest = migrations.at(-1)?.version ?? 0;
  try {
    await db.query(LEDGER_DDL);
    const ledger = await db.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_version ORDER BY version");
    const applied = new Map(ledger.rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const recorded = applied.get(m.version);
      if (recorded !== undefined && recorded !== m.checksum) {
        return { ok: false, applied: [...applied.keys()], pending: [], latest, error: `migration ${m.version} (${m.name}) was modified after being applied` };
      }
    }
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      try {
        await db.transaction(async (tx) => {
          await execScript(tx, m.sql);
          await tx.query("INSERT INTO schema_version (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4::timestamptz)", [
            m.version,
            m.name,
            m.checksum,
            (opts.now?.() ?? new Date()).toISOString(),
          ]);
        });
        applied.set(m.version, m.checksum);
      } catch (err) {
        return {
          ok: false,
          applied: [...applied.keys()],
          pending: migrations.filter((x) => !applied.has(x.version)).map((x) => x.version),
          latest,
          error: `migration ${m.version} (${m.name}) failed: ${safeMessage(err)}`,
        };
      }
    }
    return { ok: true, applied: [...applied.keys()], pending: [], latest };
  } catch (err) {
    return { ok: false, applied: [], pending: [], latest, error: `database error: ${safeMessage(err)}` };
  }
}

/** Read-only readiness probe: reachable, ledger complete, checksums intact. Never changes the schema. */
export async function checkSchema(db: Db, opts: { dir?: string } = {}): Promise<MigrationStatus> {
  let migrations: MigrationFile[];
  try {
    migrations = loadMigrations(opts.dir ?? defaultMigrationsDir());
  } catch (err) {
    return { ok: false, applied: [], pending: [], latest: 0, error: `cannot load migrations: ${safeMessage(err)}` };
  }
  const latest = migrations.at(-1)?.version ?? 0;
  try {
    const ledger = await db.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_version ORDER BY version");
    const applied = new Map(ledger.rows.map((r) => [r.version, r.checksum]));
    const pending = migrations.filter((m) => !applied.has(m.version)).map((m) => m.version);
    const tampered = migrations.find((m) => applied.has(m.version) && applied.get(m.version) !== m.checksum);
    if (tampered) return { ok: false, applied: [...applied.keys()], pending, latest, error: `migration ${tampered.version} was modified after being applied` };
    if (pending.length > 0) return { ok: false, applied: [...applied.keys()], pending, latest, error: `pending migrations: ${pending.join(",")}` };
    return { ok: true, applied: [...applied.keys()], pending: [], latest };
  } catch (err) {
    return { ok: false, applied: [], pending: [], latest, error: `database unavailable or not initialised: ${safeMessage(err)}` };
  }
}

/** Alias used by callers that only want "make the schema current". */
export const initializeDatabase = runMigrations;
