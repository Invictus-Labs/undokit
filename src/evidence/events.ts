import { contentHash } from "../domain/canonical.js";
import type { IdGenerator } from "../domain/clock.js";
import { redactDeep, type SecretRegistry } from "../domain/redact.js";
import { SCHEMA_VERSION, type EventView } from "../domain/types.js";
import type { Queryable } from "../db/client.js";

export const GENESIS_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export interface AppendEventInput {
  workspaceId: string;
  operationId: string;
  type: string;
  /** Never put plaintext field values here; use hashes and codes. Payload is redacted again defensively. */
  payload: Record<string, unknown>;
  now: Date;
}

interface EventRow {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  event_hash: string;
  created_at: string;
}

/**
 * Append a hash-chained evidence event and the matching transactional-outbox envelope in the caller's
 * transaction. Callers must already hold the operation row lock (every state transition does) so the
 * per-operation sequence cannot race.
 */
export async function appendEvent(
  tx: Queryable,
  ids: IdGenerator,
  secrets: SecretRegistry | undefined,
  input: AppendEventInput,
): Promise<{ seq: number; hash: string }> {
  const last = await tx.query<{ seq: number; event_hash: string }>(
    "SELECT seq, event_hash FROM evidence_events WHERE operation_id = $1 ORDER BY seq DESC LIMIT 1",
    [input.operationId],
  );
  const seq = (last.rows[0]?.seq ?? 0) + 1;
  const prevHash = last.rows[0]?.event_hash ?? GENESIS_HASH;
  const createdAt = input.now.toISOString();
  const payload = redactDeep(input.payload, secrets);
  const hash = contentHash({ operation_id: input.operationId, seq, event_type: input.type, payload, prev_hash: prevHash, created_at: createdAt });
  await tx.query(
    `INSERT INTO evidence_events (id, workspace_id, operation_id, seq, event_type, payload, prev_hash, event_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz)`,
    [ids.next(), input.workspaceId, input.operationId, seq, input.type, JSON.stringify(payload), prevHash, hash, createdAt],
  );
  const eventId = ids.next();
  const envelope = {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    source: "undokit",
    resource_id: input.operationId,
    event_type: input.type,
    occurred_at: createdAt,
    revision: seq,
    evidence_ref: `operations/${input.operationId}.json#event-${seq}`,
  };
  await tx.query(
    `INSERT INTO outbox (id, workspace_id, event_id, event_type, resource_id, revision, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)`,
    [ids.next(), input.workspaceId, eventId, input.type, input.operationId, seq, JSON.stringify(envelope), createdAt],
  );
  return { seq, hash };
}

export async function listEvents(tx: Queryable, operationId: string): Promise<EventView[]> {
  const res = await tx.query<EventRow>(
    "SELECT seq, event_type, payload, prev_hash, event_hash, created_at FROM evidence_events WHERE operation_id = $1 ORDER BY seq",
    [operationId],
  );
  return res.rows.map((r) => ({
    seq: r.seq,
    event_type: r.event_type,
    payload: r.payload,
    prev_hash: r.prev_hash,
    event_hash: r.event_hash,
    created_at: r.created_at.replace(/\.(\d{3})\d*Z$/, ".$1Z"),
  }));
}

/** Recompute the chain; returns the first broken seq or null when intact. */
export function verifyEventChain(operationId: string, events: readonly EventView[]): number | null {
  let prev = GENESIS_HASH;
  for (const e of events) {
    const expected = contentHash({ operation_id: operationId, seq: e.seq, event_type: e.event_type, payload: e.payload, prev_hash: prev, created_at: e.created_at });
    if (e.prev_hash !== prev || e.event_hash !== expected) return e.seq;
    prev = e.event_hash;
  }
  return null;
}

/** Outbox consumers (optional adapters): at-least-once delivery, marked published after the handler resolves. */
export async function dispatchOutbox(
  db: { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> },
  handler: (envelope: Record<string, unknown>) => Promise<void>,
  now: Date,
  limit = 100,
): Promise<number> {
  const pending = await db.transaction((tx) =>
    tx.query<{ id: string; payload: Record<string, unknown> }>(
      "SELECT id, payload FROM outbox WHERE published_at IS NULL ORDER BY occurred_at, id LIMIT $1",
      [limit],
    ),
  );
  let delivered = 0;
  for (const row of pending.rows) {
    try {
      await handler(row.payload);
      await db.transaction((tx) => tx.query("UPDATE outbox SET published_at = $2::timestamptz, publish_attempts = publish_attempts + 1 WHERE id = $1", [row.id, now.toISOString()]));
      delivered += 1;
    } catch {
      await db.transaction((tx) => tx.query("UPDATE outbox SET publish_attempts = publish_attempts + 1 WHERE id = $1", [row.id]));
    }
  }
  return delivered;
}
