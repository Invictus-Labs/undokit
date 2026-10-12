import type { UndoKit } from "../context.js";
import { fieldValueHash } from "../domain/plan.js";
import { REDACTED } from "../domain/redact.js";
import {
  SCHEMA_VERSION,
  type ApplyFieldOutcome,
  type CompensationFieldOutcome,
  type CompensationView,
  type ConflictView,
  type OperationView,
  type Role,
  type Scalar,
} from "../domain/types.js";
import type { Queryable } from "../db/client.js";
import type { Envelope } from "../evidence/crypto.js";
import { loadOperationRow, type OperationRow } from "./common.js";

/** Who is reading: viewers and exports always get sensitive values replaced by the redaction marker. */
export type Audience = Role | "export";

export function redactsSensitive(audience: Audience): boolean {
  return audience === "viewer" || audience === "export";
}

/* ---------- field value encryption / hashing ---------- */

type Column = "before" | "intended" | "observed_after";

export function encryptValue(kit: UndoKit, opId: string, field: string, column: Column, value: Scalar): Envelope {
  return kit.keyring.encryptJson("field-snapshot", { v: value }, `snap:${opId}:${field}:${column}`);
}

export function decryptValue(kit: UndoKit, opId: string, field: string, column: Column, envelope: Envelope): Scalar {
  return kit.keyring.decryptJson<{ v: Scalar }>("field-snapshot", envelope, `snap:${opId}:${field}:${column}`).v;
}

/** Value hash. Sensitive values use a keyed hash so a low-entropy value cannot be brute-forced from it. */
export function valueHash(kit: UndoKit, sensitive: boolean, opId: string, field: string, role: Column, value: Scalar): string {
  if (!sensitive) return fieldValueHash(opId, field, role, value);
  return kit.keyring.keyedHash("field-hash", JSON.stringify([opId, field, role, value]));
}

/** What goes into a plan document: the value itself, or its keyed hash when the field is sensitive. */
export function planValue(kit: UndoKit, sensitive: boolean, opId: string, field: string, role: Column, value: Scalar): Scalar {
  return sensitive ? valueHash(kit, true, opId, field, role, value) : value;
}

/* ---------- snapshots ---------- */

export interface Snapshot {
  field: string;
  sensitive: boolean;
  before: Scalar;
  intended: Scalar;
  /** null when no observation has been recorded (the stored column is NULL). */
  observed_after: Scalar;
  observed_recorded: boolean;
  before_hash: string;
  intended_hash: string;
  observed_after_hash: string | null;
  provider_version: string;
  apply_outcome: ApplyFieldOutcome;
  compensation_outcome: CompensationFieldOutcome;
}

interface SnapshotRow {
  field: string;
  sensitive: boolean;
  before: Envelope;
  intended: Envelope;
  observed_after: Envelope | null;
  before_hash: string;
  intended_hash: string;
  observed_after_hash: string | null;
  provider_version: string;
  apply_outcome: ApplyFieldOutcome;
  compensation_outcome: CompensationFieldOutcome;
}

export async function loadSnapshots(kit: UndoKit, q: Queryable, opId: string): Promise<Snapshot[]> {
  const res = await q.query<SnapshotRow>("SELECT * FROM field_snapshots WHERE operation_id = $1::uuid ORDER BY field", [opId]);
  return res.rows.map((r) => ({
    field: r.field,
    sensitive: r.sensitive,
    before: decryptValue(kit, opId, r.field, "before", r.before),
    intended: decryptValue(kit, opId, r.field, "intended", r.intended),
    observed_after: r.observed_after ? decryptValue(kit, opId, r.field, "observed_after", r.observed_after) : null,
    observed_recorded: r.observed_after !== null,
    before_hash: r.before_hash,
    intended_hash: r.intended_hash,
    observed_after_hash: r.observed_after_hash,
    provider_version: r.provider_version,
    apply_outcome: r.apply_outcome,
    compensation_outcome: r.compensation_outcome,
  }));
}

/** Value the compensation expects to find on the record right now (what the apply left behind). */
export function expectedCurrent(s: Snapshot): Scalar {
  return s.observed_recorded ? s.observed_after : s.intended;
}

/* ---------- conflicts ---------- */

export interface StoredConflict {
  field: string | null;
  code: "VALUE_CHANGED" | "VERSION_CHANGED" | "RECORD_MISSING";
  expected: Scalar;
  actual: Scalar;
}

export function computeConflicts(
  observedVersion: string | null,
  snapshots: readonly Snapshot[],
  live: { version: string; fields: Record<string, Scalar> } | null,
): StoredConflict[] {
  if (!live) return [{ field: null, code: "RECORD_MISSING", expected: observedVersion, actual: null }];
  const out: StoredConflict[] = [];
  if (live.version !== observedVersion) {
    out.push({ field: null, code: "VERSION_CHANGED", expected: observedVersion, actual: live.version });
  }
  for (const s of snapshots) {
    if (s.apply_outcome === "changed_other" || s.apply_outcome === "mismatch") {
      out.push({ field: s.field, code: "VALUE_CHANGED", expected: s.intended, actual: s.observed_after });
      continue;
    }
    const expected = expectedCurrent(s);
    const actual = live.fields[s.field] ?? null;
    if (actual !== expected) out.push({ field: s.field, code: "VALUE_CHANGED", expected, actual });
  }
  return out;
}

/* ---------- views ---------- */

interface CompensationRow {
  id: string;
  operation_id: string;
  state: CompensationView["state"];
  plan_hash: string;
  expected_version: string;
  conflicts_enc: Envelope;
  failure_code: string | null;
  failure_message: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
}

export function decryptConflicts(kit: UndoKit, row: Pick<CompensationRow, "id" | "conflicts_enc">): StoredConflict[] {
  return kit.keyring.decryptJson<StoredConflict[]>("conflicts", row.conflicts_enc, `compensation:${row.id}`);
}

function maskScalar(redact: boolean, value: Scalar): Scalar {
  return redact ? REDACTED : value;
}

export function compensationView(kit: UndoKit, row: CompensationRow, snapshots: readonly Snapshot[], audience: Audience): CompensationView {
  const hide = redactsSensitive(audience);
  const sensitiveFields = new Set(snapshots.filter((s) => s.sensitive).map((s) => s.field));
  const conflicts: ConflictView[] = decryptConflicts(kit, row).map((c) => {
    const redact = hide && c.field !== null && sensitiveFields.has(c.field);
    return { field: c.field, code: c.code, expected: maskScalar(redact, c.expected), actual: maskScalar(redact, c.actual) };
  });
  return {
    id: row.id,
    operation_id: row.operation_id,
    state: row.state,
    plan_hash: row.plan_hash,
    expected_version: row.expected_version,
    fields: snapshots.map((s) => {
      const redact = hide && s.sensitive;
      return {
        field: s.field,
        expected_current: maskScalar(redact, expectedCurrent(s)),
        restore_to: maskScalar(redact, s.before),
        redacted: redact,
        outcome: s.compensation_outcome,
      };
    }),
    conflicts,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    failure: row.failure_code ? { code: row.failure_code, message: row.failure_message ?? "" } : null,
  };
}

export async function loadCompensationRows(q: Queryable, opId: string): Promise<CompensationRow[]> {
  const res = await q.query<CompensationRow>("SELECT * FROM compensations WHERE operation_id = $1::uuid ORDER BY created_at, id", [opId]);
  return res.rows;
}

export async function buildOperationView(kit: UndoKit, q: Queryable, workspaceId: string, opId: string, audience: Audience): Promise<OperationView> {
  const op = await loadOperationRow(q, workspaceId, opId);
  return viewFromRow(kit, q, op, audience);
}

export async function viewFromRow(kit: UndoKit, q: Queryable, op: OperationRow, audience: Audience): Promise<OperationView> {
  const hide = redactsSensitive(audience);
  const snapshots = await loadSnapshots(kit, q, op.id);
  const connector = await q.query<{ id: string; name: string; kind: string; config: Record<string, unknown>; credentials_enc: Envelope | null; workspace_id: string }>(
    "SELECT id, name, kind, config, credentials_enc, workspace_id FROM connectors WHERE id = $1::uuid",
    [op.connector_id],
  );
  const conn = connector.rows[0];
  if (!conn) throw new Error("operation references a missing connector");
  const instance = kit.connectors.get(conn);
  const approvals = await q.query<{
    id: string;
    phase: "apply" | "compensate";
    compensation_id: string | null;
    plan_hash: string;
    actor_id: string;
    created_at: string;
    expires_at: string;
  }>("SELECT id, phase, compensation_id, plan_hash, actor_id, created_at, expires_at FROM approvals WHERE operation_id = $1::uuid ORDER BY created_at, id", [op.id]);
  const attempts = await q.query<{
    id: string;
    phase: "apply" | "compensate" | "reconcile";
    outcome: OperationView["attempts"][number]["outcome"];
    compensation_id: string | null;
    started_attempt_id: string | null;
    provider_request_id: string | null;
    observed_version: string | null;
    error_code: string | null;
    detail: Record<string, unknown>;
    created_at: string;
  }>(
    "SELECT id, phase, outcome, compensation_id, started_attempt_id, provider_request_id, observed_version, error_code, detail, created_at FROM attempts WHERE operation_id = $1::uuid ORDER BY created_at, id",
    [op.id],
  );
  const compRows = await loadCompensationRows(q, op.id);
  return {
    schema_version: SCHEMA_VERSION,
    id: op.id,
    workspace_id: op.workspace_id,
    connector_id: op.connector_id,
    connector: { id: conn.id, name: conn.name, kind: conn.kind as OperationView["connector"]["kind"], live: instance.live, label: instance.label },
    record_ref: op.record_ref,
    state: op.state as OperationView["state"],
    plan_hash: op.plan_hash,
    intent_hash: op.intent_hash,
    idempotency_key: op.idempotency_key,
    expected_version: op.expected_version,
    observed_version: op.observed_version,
    created_by: op.created_by,
    created_at: op.created_at,
    updated_at: op.updated_at,
    failure: op.failure_code ? { code: op.failure_code, message: op.failure_message ?? "" } : null,
    fields: snapshots.map((s) => {
      const redact = hide && s.sensitive;
      return {
        field: s.field,
        sensitive: s.sensitive,
        redacted: redact,
        before: maskScalar(redact, s.before),
        intended: maskScalar(redact, s.intended),
        observed_after: s.observed_recorded ? maskScalar(redact, s.observed_after) : null,
        provider_version: s.provider_version,
        apply_outcome: s.apply_outcome,
        compensation_outcome: s.compensation_outcome,
        before_hash: s.before_hash,
        intended_hash: s.intended_hash,
      };
    }),
    approvals: approvals.rows,
    attempts: attempts.rows,
    compensations: compRows.map((c) => compensationView(kit, c, snapshots, audience)),
  };
}
