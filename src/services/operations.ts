import { assertWritable, readWithRetry, type ConnectorRecord, type CrmConnector } from "../connectors/crm.js";
import type { UndoKit } from "../context.js";
import { validateIntent, classifyUnknownBodyKeys } from "../domain/allowlist.js";
import { AppError } from "../domain/errors.js";
import { redactText } from "../domain/redact.js";
import { computeApplyPlanHash, computeCompensationPlanHash, computeIntentHash, type ApplyPlanInput, type CompensationPlanInput } from "../domain/plan.js";
import {
  approveRequestSchema,
  compensateRequestSchema,
  connectorPolicySchema,
  createOperationRequestSchema,
  resolveRequestSchema,
  type ApproveResponse,
  type CompensateResponse,
  type CompensationPlanResponse,
  type ConnectorPolicy,
  type EventView,
  type JobView,
  type OperationView,
  type PlanResponse,
  type ReconcileResponse,
  type ResolveResponse,
} from "../domain/types.js";
import type { Queryable } from "../db/client.js";
import { listEvents as listEventRows } from "../evidence/events.js";
import {
  addMs,
  assertReady,
  assertUuid,
  isUniqueViolation,
  loadOperationRow,
  parseBody,
  requireRole,
  type Actor,
  type OperationRow,
} from "./common.js";
import { loadConnectorRow, type ConnectorDbRow } from "./connectors.js";
import { emit, enqueueJob, markInterrupted, recordAttempt, setCompensationState, setOperationState } from "./ledger.js";
import {
  buildOperationView,
  compensationView,
  computeConflicts,
  encryptValue,
  expectedCurrent,
  loadCompensationRows,
  loadSnapshots,
  planValue,
  valueHash,
  viewFromRow,
  type Snapshot,
  type StoredConflict,
} from "./views.js";

const IDEMPOTENCY_ROUTE = "POST /operations";

/* ---------- plan documents ---------- */

export function applyPlanInput(kit: UndoKit, op: Pick<OperationRow, "id" | "workspace_id" | "connector_id" | "record_ref" | "expected_version">, snaps: readonly Snapshot[]): ApplyPlanInput {
  return {
    operation_id: op.id,
    workspace_id: op.workspace_id,
    connector_id: op.connector_id,
    record_ref: op.record_ref,
    expected_version: op.expected_version,
    fields: snaps.map((s) => ({
      field: s.field,
      before: planValue(kit, s.sensitive, op.id, s.field, "before", s.before),
      intended: planValue(kit, s.sensitive, op.id, s.field, "intended", s.intended),
    })),
  };
}

export function compensationPlanInput(
  kit: UndoKit,
  op: Pick<OperationRow, "id" | "workspace_id" | "connector_id" | "record_ref">,
  observedVersion: string,
  snaps: readonly Snapshot[],
): CompensationPlanInput {
  return {
    operation_id: op.id,
    workspace_id: op.workspace_id,
    connector_id: op.connector_id,
    record_ref: op.record_ref,
    expected_version: observedVersion,
    fields: snaps.map((s) => ({
      field: s.field,
      expected_current: planValue(kit, s.sensitive, op.id, s.field, "observed_after", expectedCurrent(s)),
      restore_to: planValue(kit, s.sensitive, op.id, s.field, "before", s.before),
    })),
  };
}

export function connectorPolicyOf(row: ConnectorDbRow): ConnectorPolicy {
  return connectorPolicySchema.parse(row.policy);
}

async function liveRead(connector: CrmConnector, recordRef: string): Promise<ConnectorRecord | null> {
  try {
    return await readWithRetry(connector, recordRef);
  } catch {
    throw new AppError("CONNECTOR_UNAVAILABLE", "connector is not reachable");
  }
}

/* ---------- plan ---------- */

export interface PlanResult {
  status: 201;
  body: PlanResponse;
  replayed: boolean;
}

function validateIdempotencyKey(key: string | undefined): string {
  if (key === undefined || key.length === 0) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  if (key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key must be 1-255 printable ASCII characters");
  }
  return key;
}

interface IdemRow {
  intent_hash: string;
  response_status: number;
  response_body: PlanResponse;
}

async function findIdempotent(kit: UndoKit, q: Queryable, actor: Actor, key: string): Promise<IdemRow | undefined> {
  const res = await q.query<IdemRow & { expires_at: string }>(
    "SELECT intent_hash, response_status, response_body, expires_at FROM idempotency_keys WHERE workspace_id = $1::uuid AND actor_id = $2::uuid AND route = $3 AND key = $4",
    [actor.workspace_id, actor.user_id, IDEMPOTENCY_ROUTE, key],
  );
  const row = res.rows[0];
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= kit.clock.now().getTime()) return undefined;
  return row;
}

/**
 * An operation (or its compensation) that is UNKNOWN or still in flight on the same record. Planning or approving
 * another change there could make a later reconciliation of the old operation mistake the newer write for its own.
 */
async function assertNoUnresolvedOperation(q: Queryable, workspaceId: string, connectorId: string, recordRef: string, excludeId: string | null): Promise<void> {
  const res = await q.query<{ id: string }>(
    `SELECT o.id FROM operations o
      WHERE o.workspace_id = $1::uuid AND o.connector_id = $2::uuid AND o.record_ref = $3 AND ($4::uuid IS NULL OR o.id <> $4::uuid)
        AND (o.state IN ('unknown','applying')
             OR EXISTS (SELECT 1 FROM compensations c WHERE c.operation_id = o.id AND c.state IN ('unknown','compensating')))
      ORDER BY o.created_at, o.id LIMIT 1`,
    [workspaceId, connectorId, recordRef, excludeId],
  );
  const blocker = res.rows[0];
  if (blocker) {
    throw new AppError("UNRESOLVED_OPERATION", `operation ${blocker.id} on this record is unresolved (unknown or in flight); reconcile it first`, [
      { code: "UNRESOLVED_OPERATION", field: "record_ref", message: `blocking operation ${blocker.id}` },
    ]);
  }
}

export async function planOperation(kit: UndoKit, actor: Actor, body: unknown, idempotencyKey: string | undefined): Promise<PlanResult> {
  requireRole(actor, "operator");
  assertReady(kit);
  const key = validateIdempotencyKey(idempotencyKey);
  const forbidden = classifyUnknownBodyKeys(body);
  if (forbidden) throw forbidden;
  const req = parseBody(createOperationRequestSchema, body);
  let intentHash: string;
  try {
    intentHash = computeIntentHash({ workspace_id: actor.workspace_id, connector_id: req.connector_id, record_ref: req.record_ref, patch: req.patch, expected_version: req.expected_version });
  } catch {
    throw new AppError("VALIDATION_FAILED", "patch contains values that cannot be represented");
  }

  const replay = await findIdempotent(kit, kit.db, actor, key);
  if (replay) {
    if (replay.intent_hash !== intentHash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request");
    return { status: 201, body: replay.response_body, replayed: true };
  }

  const connectorRow = await loadConnectorRow(kit, actor.workspace_id, req.connector_id);
  if (connectorRow.disabled_at) throw new AppError("VALIDATION_FAILED", "connector is disabled");
  const policy = connectorPolicyOf(connectorRow);
  // AC-01: every policy check runs before the provider is touched.
  const validated = validateIntent(policy, req.record_ref, req.patch);
  const connector = kit.connectors.get(connectorRow);
  assertWritable(connector);
  await assertNoUnresolvedOperation(kit.db, actor.workspace_id, req.connector_id, req.record_ref, null);

  const current = await liveRead(connector, req.record_ref);
  if (!current) throw new AppError("RECORD_NOT_FOUND", "record does not exist in the connector");
  if (current.version !== req.expected_version) {
    throw new AppError("VERSION_CONFLICT", "the record changed since expected_version was read; re-read and plan again");
  }
  const changed = validated.filter((f) => (current.fields[f.field] ?? null) !== f.value);
  if (changed.length === 0) throw new AppError("VALIDATION_FAILED", "patch does not change any field");

  const opId = kit.ids.next();
  const now = kit.clock.now();
  const fieldRows = changed.map((f) => {
    const before = current.fields[f.field] ?? null;
    return { f, before };
  });
  const snaps: Snapshot[] = fieldRows.map(({ f, before }) => ({
    field: f.field,
    sensitive: f.config.sensitive,
    before,
    intended: f.value,
    observed_after: null,
    observed_recorded: false,
    before_hash: valueHash(kit, f.config.sensitive, opId, f.field, "before", before),
    intended_hash: valueHash(kit, f.config.sensitive, opId, f.field, "intended", f.value),
    observed_after_hash: null,
    provider_version: current.version,
    apply_outcome: "pending",
    compensation_outcome: "pending",
  }));
  const opHead = { id: opId, workspace_id: actor.workspace_id, connector_id: req.connector_id, record_ref: req.record_ref, expected_version: req.expected_version };
  const planHash = computeApplyPlanHash(applyPlanInput(kit, opHead, snaps));
  const response: PlanResponse = { id: opId, state: "planned", plan_hash: planHash };

  try {
    await kit.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO operations (id, workspace_id, connector_id, record_ref, intent_hash, idempotency_key, state, expected_version, plan_hash, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7, $8, $9, $10::timestamptz, $10::timestamptz)`,
        [opId, actor.workspace_id, req.connector_id, req.record_ref, intentHash, key, req.expected_version, planHash, actor.user_id, now.toISOString()],
      );
      for (const s of snaps) {
        await tx.query(
          `INSERT INTO field_snapshots (operation_id, workspace_id, field, sensitive, before, intended, before_hash, intended_hash, provider_version)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
          [
            opId,
            actor.workspace_id,
            s.field,
            s.sensitive,
            JSON.stringify(encryptValue(kit, opId, s.field, "before", s.before)),
            JSON.stringify(encryptValue(kit, opId, s.field, "intended", s.intended)),
            s.before_hash,
            s.intended_hash,
            s.provider_version,
          ],
        );
      }
      await emit(kit, tx, { id: opId, workspace_id: actor.workspace_id }, "operation.planned", {
        record_ref: req.record_ref,
        connector_id: req.connector_id,
        expected_version: req.expected_version,
        plan_hash: planHash,
        fields: snaps.map((s) => ({ field: s.field, sensitive: s.sensitive, before_hash: s.before_hash, intended_hash: s.intended_hash })),
        actor_id: actor.user_id,
      });
      await tx.query(
        `INSERT INTO idempotency_keys (workspace_id, actor_id, route, key, intent_hash, operation_id, response_status, response_body, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 201, $7::jsonb, $8::timestamptz, $9::timestamptz)
         ON CONFLICT (workspace_id, actor_id, route, key) DO UPDATE
           SET intent_hash = EXCLUDED.intent_hash, operation_id = EXCLUDED.operation_id, response_status = 201,
               response_body = EXCLUDED.response_body, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
           WHERE idempotency_keys.expires_at <= EXCLUDED.created_at`,
        [actor.workspace_id, actor.user_id, IDEMPOTENCY_ROUTE, key, intentHash, opId, JSON.stringify(response), now.toISOString(), addMs(now, kit.config.idempotencyRetentionMs).toISOString()],
      );
      // An unexpired key written by a concurrent request leaves the row untouched; detect that and abort.
      const check = await tx.query<{ operation_id: string }>(
        "SELECT operation_id FROM idempotency_keys WHERE workspace_id = $1::uuid AND actor_id = $2::uuid AND route = $3 AND key = $4",
        [actor.workspace_id, actor.user_id, IDEMPOTENCY_ROUTE, key],
      );
      if (check.rows[0]?.operation_id !== opId) throw Object.assign(new Error("idempotency race"), { code: "23505" });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await findIdempotent(kit, kit.db, actor, key);
      if (winner) {
        if (winner.intent_hash !== intentHash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request");
        return { status: 201, body: winner.response_body, replayed: true };
      }
    }
    throw err;
  }
  return { status: 201, body: response, replayed: false };
}

/* ---------- read ---------- */

export async function getOperation(kit: UndoKit, actor: Actor, id: string): Promise<OperationView> {
  assertUuid(id, "operation");
  return buildOperationView(kit, kit.db, actor.workspace_id, id, actor.role);
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ListOptions {
  limit?: number;
  cursor?: string | undefined;
  state?: string | undefined;
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error("bad");
    return { at, id };
  } catch {
    throw new AppError("MALFORMED_REQUEST", "invalid cursor");
  }
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString("base64url");
}

export function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 25), 1), 100);
}

export async function listOperations(kit: UndoKit, actor: Actor, opts: ListOptions = {}): Promise<Page<OperationView>> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const res = await kit.db.query<OperationRow>(
    `SELECT * FROM operations
      WHERE workspace_id = $1::uuid
        AND ($2::text IS NULL OR state = $2::text)
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $5`,
    [actor.workspace_id, opts.state ?? null, cursor?.at ?? null, cursor?.id ?? "00000000-0000-0000-0000-000000000000", limit + 1],
  );
  const rows = res.rows.slice(0, limit);
  const items: OperationView[] = [];
  for (const row of rows) items.push(await viewFromRow(kit, kit.db, row, actor.role));
  const last = rows.at(-1);
  return { items, next_cursor: res.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function listOperationEvents(kit: UndoKit, actor: Actor, id: string): Promise<EventView[]> {
  assertUuid(id, "operation");
  await loadOperationRow(kit.db, actor.workspace_id, id);
  return listEventRows(kit.db, id);
}

/* ---------- approve (apply) ---------- */

export async function approveOperation(kit: UndoKit, actor: Actor, id: string, body: unknown): Promise<ApproveResponse> {
  requireRole(actor, "operator");
  assertReady(kit);
  assertUuid(id, "operation");
  const req = parseBody(approveRequestSchema, body);
  return kit.db.transaction(async (tx) => {
    const op = await loadOperationRow(tx, actor.workspace_id, id, true);
    if (op.state !== "planned") throw new AppError("INVALID_STATE", `operation is ${op.state}; only a planned operation can be approved`);
    const snaps = await loadSnapshots(kit, tx, op.id);
    // Tamper check: the stored plan must still hash to the stored plan_hash.
    const recomputed = computeApplyPlanHash(applyPlanInput(kit, op, snaps));
    if (recomputed !== op.plan_hash) throw new AppError("PLAN_HASH_MISMATCH", "the stored plan no longer matches its hash; approval refused");
    if (req.plan_hash !== op.plan_hash) throw new AppError("PLAN_HASH_MISMATCH", "plan_hash does not match the plan being approved");
    if (req.expected_version !== op.expected_version) throw new AppError("VERSION_CONFLICT", "expected_version does not match the plan");
    await assertNoUnresolvedOperation(tx, op.workspace_id, op.connector_id, op.record_ref, op.id);
    const connectorRow = await tx.query<ConnectorDbRow>("SELECT * FROM connectors WHERE id = $1::uuid", [op.connector_id]);
    const conn = connectorRow.rows[0];
    if (!conn || conn.disabled_at) throw new AppError("VALIDATION_FAILED", "connector is unavailable or disabled");
    assertWritable(kit.connectors.get(conn));

    const now = kit.clock.now();
    const expires = addMs(now, kit.config.approvalTtlMs);
    const approvalId = kit.ids.next();
    await tx.query(
      `INSERT INTO approvals (id, workspace_id, operation_id, compensation_id, phase, plan_hash, actor_id, created_at, expires_at)
       VALUES ($1, $2, $3, NULL, 'apply', $4, $5, $6::timestamptz, $7::timestamptz)`,
      [approvalId, op.workspace_id, op.id, op.plan_hash, actor.user_id, now.toISOString(), expires.toISOString()],
    );
    await setOperationState(kit, tx, op, "approved");
    const job = await enqueueJob(kit, tx, { workspace_id: op.workspace_id, operation_id: op.id, kind: "apply", dedupe_key: `apply:${op.id}:${approvalId}` });
    await emit(kit, tx, op, "operation.approved", { approval_id: approvalId, plan_hash: op.plan_hash, expires_at: expires.toISOString(), actor_id: actor.user_id, job_id: job.id });
    return { id: op.id, state: "approved" as const, approval_id: approvalId, plan_hash: op.plan_hash, expires_at: expires.toISOString(), job_id: job.id };
  });
}

/* ---------- compensation ---------- */

interface CompRow {
  id: string;
  workspace_id: string;
  operation_id: string;
  state: string;
  plan_hash: string;
  expected_version: string;
  conflicts_enc: unknown;
  created_by: string;
  created_at: string;
  expires_at: string;
}

export async function createCompensationPlan(kit: UndoKit, actor: Actor, opId: string): Promise<CompensationPlanResponse> {
  requireRole(actor, "operator");
  assertReady(kit);
  assertUuid(opId, "operation");
  const head = await loadOperationRow(kit.db, actor.workspace_id, opId);
  if (head.state !== "applied") throw new AppError("INVALID_STATE", `operation is ${head.state}; only an applied operation can be compensated`);
  const connectorRow = await loadConnectorRow(kit, actor.workspace_id, head.connector_id);
  const connector = kit.connectors.get(connectorRow);
  assertWritable(connector);
  const live = await liveRead(connector, head.record_ref);

  return kit.db.transaction(async (tx) => {
    const op = await loadOperationRow(tx, actor.workspace_id, opId, true);
    if (op.state !== "applied" || !op.observed_version) throw new AppError("INVALID_STATE", "operation is not in an applied state");
    const existing = await loadCompensationRows(tx, op.id);
    if (existing.some((c) => c.state === "compensated")) throw new AppError("INVALID_STATE", "operation was already compensated");
    if (existing.some((c) => c.state === "approved" || c.state === "compensating" || c.state === "unknown")) {
      throw new AppError("INVALID_STATE", "a compensation for this operation is already in progress");
    }
    const snaps = await loadSnapshots(kit, tx, op.id);
    const conflicts = computeConflicts(op.observed_version, snaps, live);
    const planHash = computeCompensationPlanHash(compensationPlanInput(kit, op, op.observed_version, snaps));
    const now = kit.clock.now();
    const compId = kit.ids.next();
    const state = conflicts.length > 0 ? "conflict" : "planned";
    const expires = addMs(now, kit.config.compensationPlanTtlMs);
    await tx.query(
      `INSERT INTO compensations (id, workspace_id, operation_id, state, plan_hash, expected_version, conflicts_enc, created_by, created_at, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz, $10::timestamptz, $9::timestamptz)`,
      [
        compId,
        op.workspace_id,
        op.id,
        state,
        planHash,
        op.observed_version,
        JSON.stringify(kit.keyring.encryptJson("conflicts", conflicts, `compensation:${compId}`)),
        actor.user_id,
        now.toISOString(),
        expires.toISOString(),
      ],
    );
    await emit(kit, tx, op, state === "conflict" ? "compensation.blocked" : "compensation.planned", {
      compensation_id: compId,
      plan_hash: planHash,
      expected_version: op.observed_version,
      conflicts: conflicts.map((c) => ({ field: c.field, code: c.code })),
      actor_id: actor.user_id,
    });
    const view = (await loadCompensationRows(tx, op.id)).find((c) => c.id === compId);
    if (!view) throw new AppError("INTERNAL_ERROR", "compensation plan was not stored");
    const full = compensationView(kit, view, snaps, "operator");
    return {
      id: compId,
      operation_id: op.id,
      state: full.state,
      plan_hash: planHash,
      conflicts: full.conflicts,
      fields: full.fields,
      expires_at: expires.toISOString(),
    };
  });
}

export async function listCompensations(kit: UndoKit, actor: Actor, opId: string) {
  assertUuid(opId, "operation");
  await loadOperationRow(kit.db, actor.workspace_id, opId);
  const rows = await loadCompensationRows(kit.db, opId);
  const snaps = await loadSnapshots(kit, kit.db, opId);
  return rows.map((r) => compensationView(kit, r, snaps, actor.role));
}

export async function compensateOperation(kit: UndoKit, actor: Actor, opId: string, body: unknown): Promise<CompensateResponse> {
  requireRole(actor, "operator");
  assertReady(kit);
  assertUuid(opId, "operation");
  const req = parseBody(compensateRequestSchema, body);
  const head = await loadOperationRow(kit.db, actor.workspace_id, opId);
  const connectorRow = await loadConnectorRow(kit, actor.workspace_id, head.connector_id);
  const connector = kit.connectors.get(connectorRow);
  assertWritable(connector);
  // Fresh live check outside the transaction: a conflict found now blocks the approval outright.
  const live = head.state === "applied" ? await liveRead(connector, head.record_ref) : null;

  type Outcome = { blocked: StoredConflict[] } | { ok: CompensateResponse };
  const outcome = await kit.db.transaction<Outcome>(async (tx) => {
    const op = await loadOperationRow(tx, actor.workspace_id, opId, true);
    if (op.state !== "applied" || !op.observed_version) throw new AppError("INVALID_STATE", `operation is ${op.state}; only an applied operation can be compensated`);
    const all = await tx.query<CompRow>("SELECT * FROM compensations WHERE operation_id = $1::uuid AND plan_hash = $2 ORDER BY created_at DESC, id DESC", [op.id, req.plan_hash]);
    const planned = all.rows.find((c) => c.state === "planned");
    if (!planned) {
      if (all.rows.length === 0) throw new AppError("PLAN_HASH_MISMATCH", "no compensation plan matches this plan_hash");
      if (all.rows.some((c) => c.state === "conflict")) throw new AppError("COMPENSATION_BLOCKED", "this compensation plan is blocked by conflicts; create a new plan after resolving them");
      throw new AppError("INVALID_STATE", `compensation is ${all.rows[0]?.state}`);
    }
    const siblings = await loadCompensationRows(tx, op.id);
    if (siblings.some((c) => c.state === "approved" || c.state === "compensating" || c.state === "unknown" || c.state === "compensated")) {
      throw new AppError("INVALID_STATE", "a compensation for this operation is already in progress or complete");
    }
    const now = kit.clock.now();
    if (Date.parse(planned.expires_at) <= now.getTime()) throw new AppError("PLAN_EXPIRED", "the compensation plan expired; create a new plan");
    const snaps = await loadSnapshots(kit, tx, op.id);
    const recomputed = computeCompensationPlanHash(compensationPlanInput(kit, op, planned.expected_version, snaps));
    if (recomputed !== planned.plan_hash) throw new AppError("PLAN_HASH_MISMATCH", "the stored compensation plan no longer matches its hash; approval refused");
    if (planned.expected_version !== op.observed_version) throw new AppError("COMPENSATION_BLOCKED", "the operation version changed since the plan was made");
    const conflicts = computeConflicts(op.observed_version, snaps, live);
    if (conflicts.length > 0) {
      // Persist the block so the evidence shows why nothing was written, then refuse (the throw below must not roll it back).
      await tx.query("UPDATE compensations SET conflicts_enc = $2::jsonb WHERE id = $1::uuid", [
        planned.id,
        JSON.stringify(kit.keyring.encryptJson("conflicts", conflicts, `compensation:${planned.id}`)),
      ]);
      await setCompensationState(kit, tx, planned, "conflict");
      await emit(kit, tx, op, "compensation.blocked", { compensation_id: planned.id, conflicts: conflicts.map((c: StoredConflict) => ({ field: c.field, code: c.code })), actor_id: actor.user_id });
      return { blocked: conflicts };
    }
    const approvalId = kit.ids.next();
    await tx.query(
      `INSERT INTO approvals (id, workspace_id, operation_id, compensation_id, phase, plan_hash, actor_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'compensate', $5, $6, $7::timestamptz, $8::timestamptz)`,
      [approvalId, op.workspace_id, op.id, planned.id, planned.plan_hash, actor.user_id, now.toISOString(), addMs(now, kit.config.approvalTtlMs).toISOString()],
    );
    await setCompensationState(kit, tx, planned, "approved");
    const job = await enqueueJob(kit, tx, { workspace_id: op.workspace_id, operation_id: op.id, compensation_id: planned.id, kind: "compensate", dedupe_key: `compensate:${planned.id}:${approvalId}` });
    await emit(kit, tx, op, "compensation.approved", { compensation_id: planned.id, approval_id: approvalId, plan_hash: planned.plan_hash, actor_id: actor.user_id, job_id: job.id });
    return { ok: { id: op.id, compensation_id: planned.id, state: "approved" as const, approval_id: approvalId, job_id: job.id } };
  });
  if ("blocked" in outcome) {
    throw new AppError(
      "COMPENSATION_BLOCKED",
      "compensation blocked: the record changed since the operation was applied; nothing was written",
      outcome.blocked.map((c) => ({
        code: c.code,
        ...(c.field ? { field: c.field } : {}),
        message: c.field ? "value changed since the apply" : c.code === "RECORD_MISSING" ? "record no longer exists" : "record version changed",
      })),
    );
  }
  return outcome.ok;
}

/* ---------- reconcile request ---------- */

async function hasActiveJob(tx: Queryable, opId: string, kind: "apply" | "compensate", compensationId: string | null): Promise<boolean> {
  const res = await tx.query(
    "SELECT 1 FROM jobs WHERE operation_id = $1::uuid AND kind = $2 AND state IN ('queued','leased') AND compensation_id IS NOT DISTINCT FROM $3::uuid LIMIT 1",
    [opId, kind, compensationId],
  );
  return res.rows.length > 0;
}

export async function requestReconcile(kit: UndoKit, actor: Actor, opId: string): Promise<ReconcileResponse> {
  requireRole(actor, "operator");
  assertReady(kit);
  assertUuid(opId, "operation");
  return kit.db.transaction(async (tx) => {
    const op = await loadOperationRow(tx, actor.workspace_id, opId, true);
    // An attempt that is in flight but has no queued or leased job has no live worker (it failed and could not be
    // recovered): treat it as UNKNOWN so it can be reconciled. A job that is still queued or leased is left alone.
    if (op.state === "applying" && !(await hasActiveJob(tx, op.id, "apply", null))) {
      await markInterrupted(kit, tx, op, null, "ABANDONED", "no worker holds this attempt; the remote write may have happened");
    }
    if (op.state !== "unknown") {
      for (const c of await loadCompensationRows(tx, op.id)) {
        if (c.state === "compensating" && !(await hasActiveJob(tx, op.id, "compensate", c.id))) {
          await markInterrupted(kit, tx, op, c, "ABANDONED", "no worker holds this attempt; the remote write may have happened");
        }
      }
    }
    let target: { compensation_id: string | null; ref: string } | undefined;
    if (op.state === "unknown") {
      const last = await tx.query<{ id: string }>(
        "SELECT id FROM attempts WHERE operation_id = $1::uuid AND compensation_id IS NULL AND outcome IN ('unknown','reconciled_indeterminate') ORDER BY created_at DESC, id DESC LIMIT 1",
        [op.id],
      );
      target = { compensation_id: null, ref: last.rows[0]?.id ?? "none" };
    } else {
      const unknown = (await loadCompensationRows(tx, op.id)).find((c) => c.state === "unknown");
      if (unknown) {
        const last = await tx.query<{ id: string }>(
          "SELECT id FROM attempts WHERE compensation_id = $1::uuid AND outcome IN ('unknown','reconciled_indeterminate') ORDER BY created_at DESC, id DESC LIMIT 1",
          [unknown.id],
        );
        target = { compensation_id: unknown.id, ref: last.rows[0]?.id ?? "none" };
      }
    }
    if (!target) throw new AppError("INVALID_STATE", "nothing to reconcile: no operation or compensation is in an unknown state");
    const job = await enqueueJob(kit, tx, {
      workspace_id: op.workspace_id,
      operation_id: op.id,
      compensation_id: target.compensation_id,
      kind: "reconcile",
      dedupe_key: `reconcile:${target.compensation_id ?? op.id}:${target.ref}`,
    });
    if (job.created) await emit(kit, tx, op, "reconcile.requested", { job_id: job.id, compensation_id: target.compensation_id, actor_id: actor.user_id });
    return { id: op.id, job_id: job.id, state: op.state as ReconcileResponse["state"] };
  });
}

/**
 * Admin escape hatch for an UNKNOWN operation (or compensation) that reconciliation can never settle (ambiguous
 * state, record gone). It NEVER calls the provider: it records an operator-attributed attempt and event, moves the
 * target to `failed` with code OPERATOR_RESOLVED and releases the one-unresolved-change-per-record guard. There is
 * deliberately no "applied" outcome (use reconcile). A later definitive WRITTEN result for the same attempt still
 * reopens it to UNKNOWN (LATE_RESULT), so the claim "not applied" is never final against a late write.
 */
export async function resolveUnknown(kit: UndoKit, actor: Actor, opId: string, body: unknown): Promise<ResolveResponse> {
  requireRole(actor, "admin");
  assertReady(kit);
  assertUuid(opId, "operation");
  const req = parseBody(resolveRequestSchema, body);
  return kit.db.transaction(async (tx) => {
    const op = await loadOperationRow(tx, actor.workspace_id, opId, true);
    if (req.expected_version !== undefined && req.expected_version !== op.expected_version) {
      throw new AppError("VERSION_CONFLICT", "expected_version does not match the operation");
    }
    const comp = op.state === "unknown" ? null : (await loadCompensationRows(tx, op.id)).find((c) => c.state === "unknown") ?? null;
    if (op.state !== "unknown" && !comp) throw new AppError("INVALID_STATE", "nothing to resolve: no operation or compensation is in an unknown state");
    const latest = await tx.query<{ id: string; outcome: string; error_code: string | null }>(
      comp
        ? "SELECT id, outcome, error_code FROM attempts WHERE compensation_id = $1::uuid AND outcome IN ('unknown','reconciled_indeterminate') ORDER BY created_at DESC, id DESC LIMIT 1"
        : "SELECT id, outcome, error_code FROM attempts WHERE operation_id = $1::uuid AND compensation_id IS NULL AND outcome IN ('unknown','reconciled_indeterminate') ORDER BY created_at DESC, id DESC LIMIT 1",
      [comp ? comp.id : op.id],
    );
    // The provider may already hold the write (a lost response). Closing it as "not applied" is only defensible after a
    // reconcile run actually read the provider and could not settle it: the state did not match either side
    // (STATE_AMBIGUOUS) or the record is gone (RECORD_MISSING). An unreadable provider, a deferred (QUIET_PERIOD)
    // reconcile, or no reconcile at all is not enough.
    const last = latest.rows[0];
    if (!last || last.outcome !== "reconciled_indeterminate" || (last.error_code !== "STATE_AMBIGUOUS" && last.error_code !== "RECORD_MISSING")) {
      throw new AppError(
        "INVALID_STATE",
        `resolve is only allowed after a reconcile run ended with STATE_AMBIGUOUS or RECORD_MISSING (latest: ${last ? (last.error_code ?? last.outcome) : "none"}); run reconcile first and retry once the provider is readable and the quiet period has passed`,
      );
    }
    const reason = redactText(req.reason, kit.secrets);
    const attemptId = await recordAttempt(kit, tx, {
      workspace_id: op.workspace_id,
      operation_id: op.id,
      compensation_id: comp?.id ?? null,
      phase: "reconcile",
      outcome: "failed",
      started_attempt_id: last.id,
      error_code: "OPERATOR_RESOLVED",
      detail: { operator: true, resolved_by: actor.user_id, resolution: req.outcome, reason },
    });
    const failure = { code: "OPERATOR_RESOLVED", message: `resolved by an operator as ${req.outcome}; the provider was not consulted` };
    if (comp) {
      if (req.outcome === "not_applied") await tx.query("UPDATE field_snapshots SET compensation_outcome = 'not_restored' WHERE operation_id = $1::uuid", [op.id]);
      await setCompensationState(kit, tx, comp, "failed", { failure });
    } else {
      if (req.outcome === "not_applied") await tx.query("UPDATE field_snapshots SET apply_outcome = 'not_applied' WHERE operation_id = $1::uuid", [op.id]);
      await setOperationState(kit, tx, op, "failed", { failure });
    }
    await emit(kit, tx, op, comp ? "compensation.operator_resolved" : "apply.operator_resolved", {
      attempt_id: attemptId,
      outcome: req.outcome,
      reason,
      actor_id: actor.user_id,
      compensation_id: comp?.id ?? null,
    });
    return {
      id: op.id,
      target: comp ? ("compensation" as const) : ("operation" as const),
      compensation_id: comp?.id ?? null,
      state: "failed" as const,
      outcome: req.outcome,
      failure_code: "OPERATOR_RESOLVED" as const,
      resolved_by: actor.user_id,
      attempt_id: attemptId,
    };
  });
}

/* ---------- jobs ---------- */

interface JobRow {
  id: string;
  kind: JobView["kind"];
  state: JobView["state"];
  operation_id: string;
  compensation_id: string | null;
  attempts_count: number;
  available_at: string;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
}

function jobView(r: JobRow): JobView {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    operation_id: r.operation_id,
    compensation_id: r.compensation_id,
    attempts_count: r.attempts_count,
    available_at: r.available_at,
    lease_expires_at: r.lease_expires_at,
    last_error: r.last_error,
    created_at: r.created_at,
  };
}

export async function listJobs(kit: UndoKit, actor: Actor, opts: ListOptions = {}): Promise<Page<JobView>> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const res = await kit.db.query<JobRow>(
    `SELECT * FROM jobs WHERE workspace_id = $1::uuid
        AND ($2::text IS NULL OR state = $2::text)
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $5`,
    [actor.workspace_id, opts.state ?? null, cursor?.at ?? null, cursor?.id ?? "00000000-0000-0000-0000-000000000000", limit + 1],
  );
  const rows = res.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(jobView), next_cursor: res.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function getJob(kit: UndoKit, actor: Actor, id: string): Promise<JobView> {
  assertUuid(id, "job");
  const res = await kit.db.query<JobRow>("SELECT * FROM jobs WHERE id = $1::uuid AND workspace_id = $2::uuid", [id, actor.workspace_id]);
  const row = res.rows[0];
  if (!row) throw new AppError("NOT_FOUND", "job not found");
  return jobView(row);
}
