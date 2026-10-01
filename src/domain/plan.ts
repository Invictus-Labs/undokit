import { contentHash } from "./canonical.js";
import { SCHEMA_VERSION, type Scalar } from "./types.js";

export interface PlanFieldInput {
  field: string;
  before: Scalar;
  intended: Scalar;
}

export interface ApplyPlanInput {
  operation_id: string;
  workspace_id: string;
  connector_id: string;
  record_ref: string;
  expected_version: string;
  fields: PlanFieldInput[];
}

/** Exact document the approver authorizes. Any change to it changes the hash (AC-02). */
export function applyPlanDocument(input: ApplyPlanInput) {
  return {
    schema_version: SCHEMA_VERSION,
    kind: "apply-plan",
    operation_id: input.operation_id,
    workspace_id: input.workspace_id,
    connector_id: input.connector_id,
    record_ref: input.record_ref,
    expected_version: input.expected_version,
    fields: [...input.fields]
      .sort((a, b) => (a.field < b.field ? -1 : 1))
      .map((f) => ({ field: f.field, before: f.before, intended: f.intended })),
  };
}

export function computeApplyPlanHash(input: ApplyPlanInput): string {
  return contentHash(applyPlanDocument(input));
}

/** Idempotency intent: what the caller asked for, independent of server-side reads. */
export function computeIntentHash(input: {
  workspace_id: string;
  connector_id: string;
  record_ref: string;
  patch: Record<string, unknown>;
  expected_version: string;
}): string {
  return contentHash({
    schema_version: SCHEMA_VERSION,
    kind: "operation-intent",
    workspace_id: input.workspace_id,
    connector_id: input.connector_id,
    record_ref: input.record_ref,
    patch: input.patch,
    expected_version: input.expected_version,
  });
}

export interface CompensationPlanInput {
  operation_id: string;
  workspace_id: string;
  connector_id: string;
  record_ref: string;
  /** Provider version observed after the apply; the restore is conditional on it. */
  expected_version: string;
  fields: { field: string; expected_current: Scalar; restore_to: Scalar }[];
}

export function computeCompensationPlanHash(input: CompensationPlanInput): string {
  return contentHash({
    schema_version: SCHEMA_VERSION,
    kind: "compensation-plan",
    operation_id: input.operation_id,
    workspace_id: input.workspace_id,
    connector_id: input.connector_id,
    record_ref: input.record_ref,
    expected_version: input.expected_version,
    fields: [...input.fields]
      .sort((a, b) => (a.field < b.field ? -1 : 1))
      .map((f) => ({ field: f.field, expected_current: f.expected_current, restore_to: f.restore_to })),
  });
}

/** Per-field value hash, bound to the operation so identical values do not collide across operations. */
export function fieldValueHash(
  operationId: string,
  field: string,
  role: "before" | "intended" | "observed_after",
  value: Scalar,
): string {
  return contentHash({ operation_id: operationId, field, role, value });
}
