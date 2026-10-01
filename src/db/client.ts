import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export type Row = Record<string, unknown>;

export interface QueryResult<T = Row> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  readonly kind: "pglite" | "pg";
  /** Run `fn` in one transaction. Inside `fn` ONLY use the provided `tx`; never the outer Db (PGlite would deadlock). */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Normalize driver values: timestamps become UTC ISO strings, so callers never see `Date`. */
function normalize<T>(rows: unknown[]): T[] {
  return rows.map((row) => {
    const out: Row = {};
    for (const [key, value] of Object.entries(row as Row)) {
      out[key] = value instanceof Date ? value.toISOString() : typeof value === "bigint" ? Number(value) : value;
    }
    return out as T;
  });
}

interface ExecTx extends Queryable {
  exec: (sql: string) => Promise<unknown>;
}

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  constructor(private readonly pg: PGlite) {}

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query(sql, params as unknown[]);
    return { rows: normalize<T>(res.rows), rowCount: res.affectedRows ?? res.rows.length };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const wrapped: ExecTx = {
        query: async <R = Row>(sql: string, params: readonly unknown[] = []) => {
          const res = await tx.query(sql, params as unknown[]);
          return { rows: normalize<R>(res.rows), rowCount: res.affectedRows ?? res.rows.length };
        },
        exec: async (sql: string) => tx.exec(sql),
      };
      return fn(wrapped);
    });
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

class PgDb implements Db {
  readonly kind = "pg" as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: normalize<T>(res.rows), rowCount: res.rowCount ?? res.rows.length };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const wrapped: ExecTx = {
        query: async <R = Row>(sql: string, params: readonly unknown[] = []) => {
          const res = await client.query(sql, params as unknown[]);
          return { rows: normalize<R>(res.rows), rowCount: res.rowCount ?? res.rows.length };
        },
        exec: async (sql: string) => client.query(sql),
      };
      const result = await fn(wrapped);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* connection already broken; surface the original error */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Run a script inside the transaction handed out by `Db.transaction` (both drivers support it). */
export async function execScript(tx: Queryable, sql: string): Promise<void> {
  await (tx as ExecTx).exec(sql);
}

/**
 * True when the database at `url` already holds workspaces. Opens and closes its own connection and never
 * creates anything (a missing or uninitialised PGlite directory is reported as empty without being opened); `memory://` is always empty. Used to refuse minting a new encryption key over existing data.
 */
export async function databaseHasData(url: string): Promise<boolean> {
  if (url === "memory://" || url === "pglite://memory") return false;
  if (url.startsWith("pglite://")) {
    // Opening would create the directory and initialise a cluster in it; an absent or uninitialised directory holds no data.
    if (!existsSync(join(resolve(url.slice("pglite://".length)), "PG_VERSION"))) return false;
  }
  const db = await openDatabase(url);
  try {
    const table = await db.query<{ t: string | null }>("SELECT to_regclass('public.workspaces')::text AS t");
    if (table.rows[0]?.t == null) return false;
    const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspaces");
    return (count.rows[0]?.n ?? 0) > 0;
  } finally {
    await db.close();
  }
}

/**
 * Open a database from a URL:
 *   memory://                 in-memory PGlite (tests, demo)
 *   pglite://<directory>      persistent PGlite data directory
 *   postgres://...            PostgreSQL via `pg`
 */
export async function openDatabase(url: string): Promise<Db> {
  if (url === "memory://" || url === "pglite://memory") {
    const db = new PGlite();
    await db.waitReady;
    return new PgliteDb(db);
  }
  if (url.startsWith("pglite://")) {
    const dir = resolve(url.slice("pglite://".length));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new PGlite(dir);
    await db.waitReady;
    return new PgliteDb(db);
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
    // An idle client can fail (server restart, network drop). Without a listener that is an unhandled 'error'
    // event and kills the process; the pool discards the client and the next query reconnects.
    pool.on("error", () => undefined);
    // Fail fast with a clear message instead of a hang when the server is unreachable.
    await pool.query("SELECT 1");
    return new PgDb(pool);
  }
  throw new Error("unsupported database url scheme (use memory://, pglite://<dir> or postgres://)");
}
