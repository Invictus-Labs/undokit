import type { ZodType } from "zod";
import type { UndoKit } from "../context.js";
import { AppError, type ErrorDetail } from "../domain/errors.js";
import type { Role } from "../domain/types.js";
import type { Queryable } from "../db/client.js";

export interface Actor {
  user_id: string;
  workspace_id: string;
  role: Role;
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function requireRole(actor: Actor, min: Role): void {
  if (RANK[actor.role] < RANK[min]) throw new AppError("FORBIDDEN", `this action requires the ${min} role`);
}

export function assertReady(kit: UndoKit): void {
  if (!kit.readiness.ok) throw new AppError("NOT_READY", "service is not ready: database schema is not current");
}

/** Parse with zod; error details name the failing path and rule but never echo submitted values. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const res = schema.safeParse(body);
  if (res.success) return res.data;
  const details: ErrorDetail[] = res.error.issues.slice(0, 20).map((issue) => ({
    code: issue.code === "unrecognized_keys" ? "UNKNOWN_KEY" : "INVALID",
    field: issue.path.join(".").slice(0, 128) || "(body)",
    message: issue.code === "unrecognized_keys" ? "unknown request key" : issue.message.slice(0, 200),
  }));
  throw new AppError("VALIDATION_FAILED", "request body failed validation", details);
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export interface OperationRow {
  id: string;
  workspace_id: string;
  connector_id: string;
  record_ref: string;
  intent_hash: string;
  idempotency_key: string;
  state: string;
  expected_version: string;
  observed_version: string | null;
  plan_hash: string;
  failure_code: string | null;
  failure_message: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Workspace-scoped operation lookup; cross-workspace and missing ids are indistinguishable (404). */
export async function loadOperationRow(tx: Queryable, workspaceId: string, id: string, lock = false): Promise<OperationRow> {
  const res = await tx.query<OperationRow>(
    `SELECT * FROM operations WHERE id = $1::uuid AND workspace_id = $2::uuid${lock ? " FOR UPDATE" : ""}`,
    [id, workspaceId],
  );
  const row = res.rows[0];
  if (!row) throw new AppError("NOT_FOUND", "operation not found");
  return row;
}

export function assertUuid(value: string, what: string): void {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new AppError("NOT_FOUND", `${what} not found`);
  }
}
