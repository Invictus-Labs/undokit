import { contentHash } from "../domain/canonical.js";
import { AppError } from "../domain/errors.js";
import { verifyEventChain } from "../evidence/events.js";
import type { EventView } from "../domain/types.js";
import type { Db } from "./client.js";

/**
 * Tables in dependency order (parents first). `sessions` is deliberately excluded: a backup never
 * carries live sign-ins. Ciphertext columns are included as-is, so restoring needs the same
 * operator-managed encryption key; the key itself is never part of a backup.
 */
export const BACKUP_TABLES = [
  "workspaces",
  "users",
  "memberships",
  "connectors",
  "operations",
  "field_snapshots",
  "compensations",
  "approvals",
  "attempts",
  "evidence_events",
  "jobs",
  "outbox",
  "idempotency_keys",
  "evidence_imports",
] as const;

export interface BackupDocument {
  format: "undokit-backup";
  format_version: 1;
  created_at: string;
  tables: Record<string, Record<string, unknown>[]>;
  /** contentHash of `tables`, so a damaged backup is detected before any row is written. */
  tables_hash: string;
}

const ORDER_BY: Record<string, string> = {
  attempts: "created_at, id",
  evidence_events: "operation_id, seq",
  field_snapshots: "operation_id, field",
  memberships: "workspace_id, user_id",
  idempotency_keys: "workspace_id, actor_id, route, key",
};

/**
 * Logical dump (ids, foreign keys and hashes preserved) readable by `restoreDatabase`. All tables are read in ONE
 * read-only REPEATABLE READ transaction, so the dump is a single consistent snapshot even while the API and workers
 * keep writing (PostgreSQL); PGlite serializes the transaction against every other statement.
 */
export async function backupDatabase(db: Db, now: Date = new Date()): Promise<BackupDocument> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  await db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); // must be the first statement
    for (const table of BACKUP_TABLES) {
      const order = ORDER_BY[table] ?? "id";
      const res = await tx.query<{ doc: Record<string, unknown>[] }>(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY ${order.split(",").map((c) => `t.${c.trim()}`).join(", ")}), '[]'::jsonb) AS doc FROM ${table} t`);
      tables[table] = res.rows[0]!.doc; // an aggregate without GROUP BY always returns exactly one row
    }
  });
  return { format: "undokit-backup", format_version: 1, created_at: now.toISOString(), tables, tables_hash: contentHash(tables) };
}

export interface RestoreReport {
  tables: Record<string, number>;
  chains_verified: number;
}

/** Restore into an empty, migrated database inside one transaction; re-verifies every evidence chain. */
export async function restoreDatabase(db: Db, doc: unknown): Promise<RestoreReport> {
  if (!doc || typeof doc !== "object") throw new AppError("MALFORMED_REQUEST", "backup is not a JSON object");
  const backup = doc as BackupDocument;
  if (backup.format !== "undokit-backup" || backup.format_version !== 1) throw new AppError("BUNDLE_UNSUPPORTED", "unsupported backup format");
  if (!backup.tables || contentHash(backup.tables) !== backup.tables_hash) throw new AppError("BUNDLE_INTEGRITY_FAILED", "backup content does not match its hash");
  const existing = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspaces");
  if ((existing.rows[0]?.n ?? 0) > 0) throw new AppError("INVALID_STATE", "restore target is not empty");
  const counts: Record<string, number> = {};
  let verified = 0;
  try {
  await db.transaction(async (tx) => {
    for (const table of BACKUP_TABLES) {
      const rows = backup.tables[table] ?? [];
      counts[table] = rows.length;
      if (rows.length === 0) continue;
      await tx.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(rows)]);
    }
    // Verified inside the transaction: a broken chain rolls the whole restore back.
    const ops = await tx.query<{ id: string }>("SELECT id FROM operations");
    for (const { id } of ops.rows) {
      const events = await tx.query<EventView>("SELECT seq, event_type, payload, prev_hash, event_hash, created_at FROM evidence_events WHERE operation_id = $1::uuid ORDER BY seq", [id]);
      const broken = verifyEventChain(id, events.rows);
      if (broken !== null) throw new AppError("BUNDLE_INTEGRITY_FAILED", `restored evidence chain for an operation breaks at sequence ${broken}`);
      verified += 1;
    }
  });
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Driver messages name tables and constraints; keep them out of API responses.
    throw new AppError("BUNDLE_INTEGRITY_FAILED", "backup content is inconsistent and was not restored");
  }
  return { tables: counts, chains_verified: verified };
}
