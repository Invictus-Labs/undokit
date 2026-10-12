/**
 * UndoKit domain types and zod schemas. SCHEMA FREEZE v1: everything exported here is the contract
 * shared with the CLI/UI and QA. Additive changes only after the freeze, announced by the backend owner.
 * schemas/*.json are generated from these zod schemas (see src/domain/schema-gen.ts).
 */
import { z } from "zod";
import { HASH_PATTERN } from "./canonical.js";

export const SCHEMA_VERSION = 1 as const;
export const PRODUCT_NAME = "undokit";
export const PRODUCT_VERSION = "0.1.0";

/* ---------- primitives ---------- */

export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
export const RECORD_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const uuidSchema = z.string().regex(UUID_PATTERN, "must be a UUID");
export const timestampSchema = z.string().regex(TIMESTAMP_PATTERN, "must be a UTC ISO-8601 timestamp");
export const hashSchema = z.string().regex(HASH_PATTERN, "must be sha256:<64 hex>");
export const recordRefSchema = z.string().regex(RECORD_REF_PATTERN, "invalid record_ref");
export const versionTokenSchema = z.string().min(1).max(256);

/** A scalar CRM field value. Arrays and objects are never accepted. */
export const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalarSchema>;

/* ---------- enums ---------- */

export const ROLES = ["admin", "operator", "viewer"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const OPERATION_STATES = ["planned", "approved", "applying", "applied", "failed", "unknown", "conflict"] as const;
export const operationStateSchema = z.enum(OPERATION_STATES);
export type OperationState = z.infer<typeof operationStateSchema>;

export const COMPENSATION_STATES = ["planned", "approved", "compensating", "compensated", "conflict", "failed", "unknown"] as const;
export const compensationStateSchema = z.enum(COMPENSATION_STATES);
export type CompensationState = z.infer<typeof compensationStateSchema>;

export const APPLY_FIELD_OUTCOMES = ["pending", "applied", "not_applied", "changed_other", "mismatch"] as const;
export const applyFieldOutcomeSchema = z.enum(APPLY_FIELD_OUTCOMES);
export type ApplyFieldOutcome = z.infer<typeof applyFieldOutcomeSchema>;

export const COMPENSATION_FIELD_OUTCOMES = ["pending", "restored", "not_restored", "changed_other", "mismatch"] as const;
export const compensationFieldOutcomeSchema = z.enum(COMPENSATION_FIELD_OUTCOMES);
export type CompensationFieldOutcome = z.infer<typeof compensationFieldOutcomeSchema>;

export const ATTEMPT_PHASES = ["apply", "compensate", "reconcile"] as const;
export const attemptPhaseSchema = z.enum(ATTEMPT_PHASES);
export type AttemptPhase = z.infer<typeof attemptPhaseSchema>;

export const ATTEMPT_OUTCOMES = [
  "started",
  "succeeded",
  "conflict",
  "failed",
  "unknown",
  "reconciled_applied",
  "reconciled_not_applied",
  "reconciled_indeterminate",
] as const;
export const attemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES);
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

export const JOB_KINDS = ["apply", "compensate", "reconcile"] as const;
export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof jobKindSchema>;

export const JOB_STATES = ["queued", "leased", "done", "failed"] as const;
export const jobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof jobStateSchema>;

export const CONNECTOR_KINDS = ["simulator", "couchdb"] as const;
export const connectorKindSchema = z.enum(CONNECTOR_KINDS);
export type ConnectorKind = z.infer<typeof connectorKindSchema>;

/* ---------- connector policy (the allowlist) ---------- */

export const fieldConfigSchema = z
  .object({
    name: z.string().regex(FIELD_NAME_PATTERN),
    type: z.enum(["string", "number", "boolean"]),
    max_length: z.number().int().min(1).max(65536).default(1024),
    nullable: z.boolean().default(false),
    sensitive: z.boolean().default(false),
    enum: z.array(z.string().max(1024)).max(256).optional(),
  })
  .strict();
export type FieldConfig = z.infer<typeof fieldConfigSchema>;

export const connectorPolicySchema = z
  .object({
    allowed_fields: z.array(fieldConfigSchema).min(1).max(100),
    /** A record_ref must start with one of these prefixes to be in scope. */
    record_prefixes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)).min(1).max(100),
  })
  .strict();
export type ConnectorPolicy = z.infer<typeof connectorPolicySchema>;

const simulatorConfigSchema = z
  .object({
    /** false makes the simulator behave like a provider without atomic conditional writes (read-only connector). */
    supports_atomic_conditional_write: z.boolean().default(true),
    seed_records: z
      .array(z.object({ record_ref: recordRefSchema, fields: z.record(z.string(), scalarSchema) }).strict())
      .max(1000)
      .default([]),
  })
  .strict();

const couchdbConfigSchema = z
  .object({
    base_url: z.string().url().max(512),
    database: z.string().regex(/^[a-z][a-z0-9_$()+/-]{0,63}$/),
    timeout_ms: z.number().int().min(100).max(60000).default(10000),
  })
  .strict();

const credentialsSchema = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).strict();

export const createConnectorRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("simulator"),
      name: z.string().min(1).max(128),
      policy: connectorPolicySchema,
      config: simulatorConfigSchema.default({ supports_atomic_conditional_write: true, seed_records: [] }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("couchdb"),
      name: z.string().min(1).max(128),
      policy: connectorPolicySchema,
      config: couchdbConfigSchema,
      credentials: credentialsSchema,
    })
    .strict(),
]);
export type CreateConnectorRequest = z.infer<typeof createConnectorRequestSchema>;

export const connectorViewSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  name: z.string(),
  kind: connectorKindSchema,
  /** Honest labelling: true only for a real provider; the simulator is never live. */
  live: z.boolean(),
  label: z.string(),
  supports_atomic_conditional_write: z.boolean(),
  /** A connector without atomic conditional writes is read-only in the MVP. */
  read_only: z.boolean(),
  policy: connectorPolicySchema,
  config: z.record(z.string(), z.unknown()),
  disabled: z.boolean(),
  created_at: timestampSchema,
});
export type ConnectorView = z.infer<typeof connectorViewSchema>;

/* ---------- requests ---------- */

export const createOperationRequestSchema = z
  .object({
    connector_id: uuidSchema,
    record_ref: recordRefSchema,
    patch: z.record(z.string(), z.unknown()),
    expected_version: versionTokenSchema,
  })
  .strict();
export type CreateOperationRequest = z.infer<typeof createOperationRequestSchema>;

export const approveRequestSchema = z.object({ plan_hash: hashSchema, expected_version: versionTokenSchema }).strict();
export type ApproveRequest = z.infer<typeof approveRequestSchema>;

export const compensateRequestSchema = z.object({ plan_hash: hashSchema }).strict();
export type CompensateRequest = z.infer<typeof compensateRequestSchema>;

export const loginRequestSchema = z
  .object({ email: z.string().email().max(320), password: z.string().min(1).max(1024), workspace_id: uuidSchema.optional() })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const createMemberRequestSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(12).max(1024),
    role: roleSchema,
    display_name: z.string().min(1).max(128).optional(),
  })
  .strict();
export type CreateMemberRequest = z.infer<typeof createMemberRequestSchema>;

export const exportRequestSchema = z.object({ operation_ids: z.array(uuidSchema).max(1000).optional() }).strict();
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/* ---------- views ---------- */

export const fieldViewSchema = z.object({
  field: z.string(),
  sensitive: z.boolean(),
  /** True when the value was replaced by the redaction marker for this reader. */
  redacted: z.boolean(),
  before: scalarSchema,
  intended: scalarSchema,
  observed_after: scalarSchema.nullable(),
  provider_version: z.string(),
  apply_outcome: applyFieldOutcomeSchema,
  compensation_outcome: compensationFieldOutcomeSchema,
  before_hash: hashSchema,
  intended_hash: hashSchema,
});
export type FieldView = z.infer<typeof fieldViewSchema>;

export const approvalViewSchema = z.object({
  id: uuidSchema,
  phase: z.enum(["apply", "compensate"]),
  compensation_id: uuidSchema.nullable(),
  plan_hash: hashSchema,
  actor_id: uuidSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema,
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;

export const attemptViewSchema = z.object({
  id: uuidSchema,
  phase: attemptPhaseSchema,
  outcome: attemptOutcomeSchema,
  compensation_id: uuidSchema.nullable(),
  started_attempt_id: uuidSchema.nullable(),
  provider_request_id: z.string().nullable(),
  observed_version: z.string().nullable(),
  error_code: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
  created_at: timestampSchema,
});
export type AttemptView = z.infer<typeof attemptViewSchema>;

export const conflictViewSchema = z.object({
  field: z.string().nullable(),
  code: z.enum(["VALUE_CHANGED", "VERSION_CHANGED", "RECORD_MISSING"]),
  expected: z.union([scalarSchema, z.string()]).nullable(),
  actual: z.union([scalarSchema, z.string()]).nullable(),
});
export type ConflictView = z.infer<typeof conflictViewSchema>;

export const compensationFieldViewSchema = z.object({
  field: z.string(),
  expected_current: scalarSchema,
  restore_to: scalarSchema,
  redacted: z.boolean(),
  outcome: compensationFieldOutcomeSchema,
});
export type CompensationFieldView = z.infer<typeof compensationFieldViewSchema>;

export const compensationViewSchema = z.object({
  id: uuidSchema,
  operation_id: uuidSchema,
  state: compensationStateSchema,
  plan_hash: hashSchema,
  /** Provider version the record must still have for the restore to be allowed. */
  expected_version: z.string(),
  fields: z.array(compensationFieldViewSchema),
  conflicts: z.array(conflictViewSchema),
  created_by: uuidSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema,
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type CompensationView = z.infer<typeof compensationViewSchema>;

export const operationViewSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: uuidSchema,
  workspace_id: uuidSchema,
  connector_id: uuidSchema,
  connector: z.object({ id: uuidSchema, name: z.string(), kind: connectorKindSchema, live: z.boolean(), label: z.string() }),
  record_ref: z.string(),
  state: operationStateSchema,
  plan_hash: hashSchema,
  intent_hash: hashSchema,
  idempotency_key: z.string(),
  /** Provider version the plan was made against (the precondition of the conditional write). */
  expected_version: z.string(),
  /** Provider version observed after a confirmed write; null until applied. */
  observed_version: z.string().nullable(),
  created_by: uuidSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  fields: z.array(fieldViewSchema),
  approvals: z.array(approvalViewSchema),
  attempts: z.array(attemptViewSchema),
  compensations: z.array(compensationViewSchema),
});
export type OperationView = z.infer<typeof operationViewSchema>;

export const planResponseSchema = z.object({ id: uuidSchema, state: z.literal("planned"), plan_hash: hashSchema });
export type PlanResponse = z.infer<typeof planResponseSchema>;

export const approveResponseSchema = z.object({
  id: uuidSchema,
  state: z.literal("approved"),
  approval_id: uuidSchema,
  plan_hash: hashSchema,
  expires_at: timestampSchema,
  job_id: uuidSchema,
});
export type ApproveResponse = z.infer<typeof approveResponseSchema>;

export const compensationPlanResponseSchema = z.object({
  id: uuidSchema,
  operation_id: uuidSchema,
  state: compensationStateSchema,
  plan_hash: hashSchema,
  conflicts: z.array(conflictViewSchema),
  fields: z.array(compensationFieldViewSchema),
  expires_at: timestampSchema,
});
export type CompensationPlanResponse = z.infer<typeof compensationPlanResponseSchema>;

export const compensateResponseSchema = z.object({
  id: uuidSchema,
  compensation_id: uuidSchema,
  state: z.literal("approved"),
  approval_id: uuidSchema,
  job_id: uuidSchema,
});
export type CompensateResponse = z.infer<typeof compensateResponseSchema>;

/** Additive after freeze: admin resolution of an UNKNOWN operation or compensation that reconciliation cannot settle. */
export const RESOLVE_OUTCOMES = ["not_applied", "abandoned"] as const;
export const resolveRequestSchema = z
  .object({
    outcome: z.enum(RESOLVE_OUTCOMES),
    /** Why the operator is closing it; stored in the evidence with the operator's id. */
    reason: z.string().trim().min(1).max(500),
    /** Optional optimistic check against the operation's expected_version. */
    expected_version: versionTokenSchema.optional(),
  })
  .strict();
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

export const resolveResponseSchema = z.object({
  id: uuidSchema,
  target: z.enum(["operation", "compensation"]),
  compensation_id: uuidSchema.nullable(),
  state: z.literal("failed"),
  outcome: z.enum(RESOLVE_OUTCOMES),
  failure_code: z.literal("OPERATOR_RESOLVED"),
  resolved_by: uuidSchema,
  attempt_id: uuidSchema,
});
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;

export const reconcileResponseSchema = z.object({ id: uuidSchema, job_id: uuidSchema, state: operationStateSchema });
export type ReconcileResponse = z.infer<typeof reconcileResponseSchema>;

export const eventViewSchema = z.object({
  seq: z.number().int(),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  prev_hash: z.string(),
  event_hash: hashSchema,
  created_at: timestampSchema,
});
export type EventView = z.infer<typeof eventViewSchema>;

export const jobViewSchema = z.object({
  id: uuidSchema,
  kind: jobKindSchema,
  state: jobStateSchema,
  operation_id: uuidSchema,
  compensation_id: uuidSchema.nullable(),
  attempts_count: z.number().int(),
  available_at: timestampSchema,
  lease_expires_at: timestampSchema.nullable(),
  last_error: z.string().nullable(),
  created_at: timestampSchema,
});
export type JobView = z.infer<typeof jobViewSchema>;

export const statusViewSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  jobs: z.object({ queued: z.number().int(), running: z.number().int(), failed: z.number().int() }),
  operations: z.object({
    planned: z.number().int(),
    approved: z.number().int(),
    applying: z.number().int(),
    applied: z.number().int(),
    failed: z.number().int(),
    unknown: z.number().int(),
    conflict: z.number().int(),
  }),
  compensations_unknown: z.number().int(),
  /** Operator-facing reasons for anything stuck, failed or unknown. */
  attention: z.array(z.object({ operation_id: uuidSchema, state: z.string(), reason: z.string(), next_step: z.string() })),
});
export type StatusView = z.infer<typeof statusViewSchema>;

export const pageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next_cursor: z.string().nullable() });

export const sessionViewSchema = z.object({
  user: z.object({ id: uuidSchema, email: z.string(), display_name: z.string().nullable() }),
  workspace: z.object({ id: uuidSchema, name: z.string() }),
  role: roleSchema,
  csrf_token: z.string(),
  expires_at: timestampSchema,
});
export type SessionView = z.infer<typeof sessionViewSchema>;

/** Additive after freeze: row of GET /sessions. */
export const sessionListItemSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  email: z.string(),
  created_at: timestampSchema,
  expires_at: timestampSchema,
  last_seen_at: timestampSchema.nullable(),
  current: z.boolean(),
});
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

export const memberViewSchema = z.object({
  user_id: uuidSchema,
  email: z.string(),
  display_name: z.string().nullable(),
  role: roleSchema,
  created_at: timestampSchema,
});
export type MemberView = z.infer<typeof memberViewSchema>;

/* ---------- evidence bundle ---------- */

export const BUNDLE_KIND = "undokit.evidence-bundle" as const;
export const BUNDLE_FILE_PATTERN = /^operations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;

export const operationEvidenceDocSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  kind: z.literal("operation-evidence"),
  operation: operationViewSchema,
  events: z.array(eventViewSchema),
});
export type OperationEvidenceDoc = z.infer<typeof operationEvidenceDocSchema>;

export const bundleManifestFileSchema = z.object({
  path: z.string().regex(BUNDLE_FILE_PATTERN),
  sha256: hashSchema,
  bytes: z.number().int().min(0),
});

export const evidenceBundleSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    kind: z.literal(BUNDLE_KIND),
    bundle_id: uuidSchema,
    created_at: timestampSchema,
    workspace_id: uuidSchema,
    generator: z.object({ name: z.literal(PRODUCT_NAME), version: z.string() }),
    /** Sensitive fields and credential-looking strings are redacted before hashing. */
    redacted: z.literal(true),
    manifest: z.object({
      files: z.array(bundleManifestFileSchema).max(1000),
      file_count: z.number().int().min(0),
      total_bytes: z.number().int().min(0),
    }),
    /** contentHash of {schema_version, kind, bundle_id, created_at, workspace_id, generator, redacted, manifest}. */
    bundle_hash: hashSchema,
    files: z.record(z.string(), operationEvidenceDocSchema),
    /** Last key: a truncated file can never contain it. */
    complete: z.literal(true),
  })
  .strict();
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export const importResultSchema = z.object({
  import_id: uuidSchema,
  bundle_id: uuidSchema,
  bundle_hash: hashSchema,
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  imported_at: timestampSchema,
  replayed: z.boolean(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

/* ---------- error envelope ---------- */

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string(),
    details: z.array(z.object({ code: z.string(), field: z.string().optional(), message: z.string() })).optional(),
  }),
});

/* ---------- limits (documented defaults; overridable by operator config) ---------- */

export const DEFAULT_LIMITS = {
  /** Max JSON body for ordinary API routes. */
  maxBodyBytes: 256 * 1024,
  /** Default import limit: 25 MB metadata, 1000 files. */
  maxImportMetadataBytes: 25 * 1024 * 1024,
  maxImportFiles: 1000,
  /** Blob bundle cap with explicit admin override. */
  maxImportBlobBytes: 250 * 1024 * 1024,
  maxPatchFields: 50,
  idempotencyRetentionDays: 7,
} as const;
