/**
 * Browser-side mirror of the frozen API view types (src/domain/types.ts).
 * Kept local so the web bundle never imports server modules. Compatibility is
 * enforced at compile time by src/report/conformance.ts (mutual assignability
 * against the real zod-inferred types), so drift fails the typecheck.
 */

export type Scalar = string | number | boolean | null;
export type Role = "admin" | "operator" | "viewer";
export type OperationState = "planned" | "approved" | "applying" | "applied" | "failed" | "unknown" | "conflict";
export type CompensationState = "planned" | "approved" | "compensating" | "compensated" | "conflict" | "failed" | "unknown";
export type ApplyFieldOutcome = "pending" | "applied" | "not_applied" | "changed_other" | "mismatch";
export type CompensationFieldOutcome = "pending" | "restored" | "not_restored" | "changed_other" | "mismatch";
export type AttemptPhase = "apply" | "compensate" | "reconcile";
export type AttemptOutcome =
  | "started"
  | "succeeded"
  | "conflict"
  | "failed"
  | "unknown"
  | "reconciled_applied"
  | "reconciled_not_applied"
  | "reconciled_indeterminate";
export type ConnectorKind = "simulator" | "couchdb";

export interface FieldConfig {
  name: string;
  type: "string" | "number" | "boolean";
  max_length: number;
  nullable: boolean;
  sensitive: boolean;
  enum?: string[] | undefined;
}
export interface ConnectorPolicy {
  allowed_fields: FieldConfig[];
  record_prefixes: string[];
}
export interface ConnectorView {
  id: string;
  workspace_id: string;
  name: string;
  kind: ConnectorKind;
  live: boolean;
  label: string;
  supports_atomic_conditional_write: boolean;
  read_only: boolean;
  policy: ConnectorPolicy;
  config: Record<string, unknown>;
  disabled: boolean;
  created_at: string;
}

export interface FieldView {
  field: string;
  sensitive: boolean;
  redacted: boolean;
  before: Scalar;
  intended: Scalar;
  observed_after: Scalar | null;
  provider_version: string;
  apply_outcome: ApplyFieldOutcome;
  compensation_outcome: CompensationFieldOutcome;
  before_hash: string;
  intended_hash: string;
}
export interface ApprovalView {
  id: string;
  phase: "apply" | "compensate";
  compensation_id: string | null;
  plan_hash: string;
  actor_id: string;
  created_at: string;
  expires_at: string;
}
export interface AttemptView {
  id: string;
  phase: AttemptPhase;
  outcome: AttemptOutcome;
  compensation_id: string | null;
  started_attempt_id: string | null;
  provider_request_id: string | null;
  observed_version: string | null;
  error_code: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}
export interface ConflictView {
  field: string | null;
  code: "VALUE_CHANGED" | "VERSION_CHANGED" | "RECORD_MISSING";
  expected: Scalar | null;
  actual: Scalar | null;
}
export interface CompensationFieldView {
  field: string;
  expected_current: Scalar;
  restore_to: Scalar;
  redacted: boolean;
  outcome: CompensationFieldOutcome;
}
export interface CompensationView {
  id: string;
  operation_id: string;
  state: CompensationState;
  plan_hash: string;
  expected_version: string;
  fields: CompensationFieldView[];
  conflicts: ConflictView[];
  created_by: string;
  created_at: string;
  expires_at: string;
  failure: { code: string; message: string } | null;
}
export interface OperationView {
  schema_version: 1;
  id: string;
  workspace_id: string;
  connector_id: string;
  connector: { id: string; name: string; kind: ConnectorKind; live: boolean; label: string };
  record_ref: string;
  state: OperationState;
  plan_hash: string;
  intent_hash: string;
  idempotency_key: string;
  expected_version: string;
  observed_version: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  failure: { code: string; message: string } | null;
  fields: FieldView[];
  approvals: ApprovalView[];
  attempts: AttemptView[];
  compensations: CompensationView[];
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface PlanResponse {
  id: string;
  state: "planned";
  plan_hash: string;
}
export interface ApproveResponse {
  id: string;
  state: "approved";
  approval_id: string;
  plan_hash: string;
  expires_at: string;
  job_id: string;
}
export interface CompensationPlanResponse {
  id: string;
  operation_id: string;
  state: CompensationState;
  plan_hash: string;
  conflicts: ConflictView[];
  fields: CompensationFieldView[];
  expires_at: string;
}
export interface CompensateResponse {
  id: string;
  compensation_id: string;
  state: "approved";
  approval_id: string;
  job_id: string;
}
export interface ReconcileResponse {
  id: string;
  job_id: string;
  state: OperationState;
}
export type ResolveOutcome = "not_applied" | "abandoned";
export interface ResolveResponse {
  id: string;
  target: "operation" | "compensation";
  compensation_id: string | null;
  state: "failed";
  outcome: ResolveOutcome;
  failure_code: "OPERATOR_RESOLVED";
  resolved_by: string;
  attempt_id: string;
}
export interface StatusView {
  schema_version: 1;
  jobs: { queued: number; running: number; failed: number };
  operations: Record<OperationState, number>;
  compensations_unknown: number;
  attention: { operation_id: string; state: string; reason: string; next_step: string }[];
}
export interface SessionView {
  user: { id: string; email: string; display_name: string | null };
  workspace: { id: string; name: string };
  role: Role;
  csrf_token: string;
  expires_at: string;
}
export interface MemberView {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Role;
  created_at: string;
}
