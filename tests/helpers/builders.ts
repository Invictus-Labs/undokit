// Typed builders for operation views and evidence bundles (QA-owned). Everything is synthetic.
// Outputs are validated against the frozen zod schemas in tests, so a contract change breaks loudly.
import { canonicalJson, contentHash } from "../../src/domain/canonical.js";
import {
  BUNDLE_KIND,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  SCHEMA_VERSION,
  type CompensationView,
  type EvidenceBundle,
  type FieldView,
  type OperationView,
} from "../../src/domain/types.js";
import { FIXED_NOW_ISO, connectorId, syntheticUuid, workspaceId } from "./fixtures.js";

export const hashOf = (seed: string): string => contentHash({ seed });

export function makeField(over: Partial<FieldView> & { field: string }): FieldView {
  return {
    field: over.field,
    sensitive: false,
    redacted: false,
    before: "lead",
    intended: "customer",
    observed_after: "customer",
    provider_version: "v2",
    apply_outcome: "applied",
    compensation_outcome: "pending",
    before_hash: hashOf(`${over.field}:before`),
    intended_hash: hashOf(`${over.field}:intended`),
    ...over,
  };
}

export interface OpOptions {
  seed: string;
  state?: OperationView["state"];
  record_ref?: string;
  created_at?: string;
  fields?: FieldView[];
  compensations?: CompensationView[];
  failure?: OperationView["failure"];
  attempts?: OperationView["attempts"];
  observed_version?: string | null;
}

export function makeOperation(o: OpOptions): OperationView {
  const id = syntheticUuid(`op:${o.seed}`);
  const created = o.created_at ?? FIXED_NOW_ISO;
  const state = o.state ?? "applied";
  return {
    schema_version: SCHEMA_VERSION,
    id,
    workspace_id: workspaceId("A"),
    connector_id: connectorId(),
    connector: { id: connectorId(), name: "synthetic-crm", kind: "simulator", live: false, label: "Simulator (not a live provider)" },
    record_ref: o.record_ref ?? `contact-${o.seed}`,
    state,
    plan_hash: hashOf(`plan:${o.seed}`),
    intent_hash: hashOf(`intent:${o.seed}`),
    idempotency_key: `idem-${o.seed}`,
    expected_version: "v1",
    observed_version: o.observed_version === undefined ? (state === "applied" ? "v2" : null) : o.observed_version,
    created_by: syntheticUuid("actor-operator-a"),
    created_at: created,
    updated_at: created,
    failure: o.failure ?? null,
    fields: o.fields ?? [makeField({ field: "lifecycle_stage" })],
    approvals: [
      {
        id: syntheticUuid(`approval:${o.seed}`),
        phase: "apply",
        compensation_id: null,
        plan_hash: hashOf(`plan:${o.seed}`),
        actor_id: syntheticUuid("actor-operator-a"),
        created_at: created,
        expires_at: "2026-01-15T12:15:00.000Z",
      },
    ],
    attempts: o.attempts ?? [
      {
        id: syntheticUuid(`attempt:${o.seed}`),
        phase: "apply",
        outcome: state === "unknown" ? "unknown" : state === "conflict" ? "conflict" : state === "failed" ? "failed" : "succeeded",
        compensation_id: null,
        started_attempt_id: null,
        provider_request_id: `req-${o.seed}`,
        observed_version: o.observed_version === undefined ? null : o.observed_version,
        error_code: null,
        detail: {},
        created_at: created,
      },
    ],
    compensations: o.compensations ?? [],
  };
}

export function makeCompensation(opts: {
  seed: string;
  operation_id: string;
  state: CompensationView["state"];
  conflicts?: CompensationView["conflicts"];
  fields?: CompensationView["fields"];
}): CompensationView {
  return {
    id: syntheticUuid(`comp:${opts.seed}`),
    operation_id: opts.operation_id,
    state: opts.state,
    plan_hash: hashOf(`comp-plan:${opts.seed}`),
    expected_version: "v2",
    fields: opts.fields ?? [
      { field: "lifecycle_stage", expected_current: "customer", restore_to: "lead", redacted: false, outcome: opts.state === "compensated" ? "restored" : "pending" },
    ],
    conflicts: opts.conflicts ?? [],
    created_by: syntheticUuid("actor-operator-a"),
    created_at: FIXED_NOW_ISO,
    expires_at: "2026-01-15T12:15:00.000Z",
    failure: null,
  };
}

/** The five representative outcomes of the PRD scenario, one operation each. */
export function scenarioOperations(): OperationView[] {
  const restored = makeOperation({ seed: "restored", created_at: "2026-01-15T12:00:00.000Z", record_ref: "contact-0001" });
  restored.compensations = [makeCompensation({ seed: "restored", operation_id: restored.id, state: "compensated" })];
  restored.fields = [makeField({ field: "lifecycle_stage", compensation_outcome: "restored" })];

  const blocked = makeOperation({ seed: "blocked", created_at: "2026-01-15T12:01:00.000Z", record_ref: "contact-0002" });
  blocked.compensations = [
    makeCompensation({
      seed: "blocked",
      operation_id: blocked.id,
      state: "conflict",
      conflicts: [{ field: "lifecycle_stage", code: "VALUE_CHANGED", expected: "customer", actual: "partner" }],
    }),
  ];

  const unknown = makeOperation({ seed: "unknown", state: "unknown", created_at: "2026-01-15T12:02:00.000Z", record_ref: "contact-0003", observed_version: null });
  unknown.fields = [makeField({ field: "lifecycle_stage", observed_after: null, apply_outcome: "pending", provider_version: "v1" })];

  const failed = makeOperation({
    seed: "failed",
    state: "failed",
    created_at: "2026-01-15T12:03:00.000Z",
    record_ref: "contact-0004",
    failure: { code: "CONNECTOR_UNAVAILABLE", message: "provider refused the connection before the request was sent" },
  });
  failed.fields = [makeField({ field: "lifecycle_stage", observed_after: null, apply_outcome: "not_applied" })];

  const partial = makeOperation({ seed: "partial", state: "applied", created_at: "2026-01-15T12:04:00.000Z", record_ref: "contact-0005" });
  partial.fields = [
    makeField({ field: "lead_score", before: 40, intended: 41, observed_after: 41 }),
    makeField({ field: "owner_label", before: "ops-a", intended: "ops-b", observed_after: "ops-c", apply_outcome: "changed_other" }),
  ];

  return [restored, blocked, unknown, failed, partial];
}

/** Build a structurally valid, correctly hashed evidence bundle for the given operations. */
export function makeBundle(operations: OperationView[], created_at = FIXED_NOW_ISO): EvidenceBundle {
  const files: EvidenceBundle["files"] = {};
  const manifestFiles: EvidenceBundle["manifest"]["files"] = [];
  let total = 0;
  for (const operation of operations) {
    const path = `operations/${operation.id}.json`;
    const doc = { schema_version: SCHEMA_VERSION, kind: "operation-evidence" as const, operation, events: [] };
    files[path] = doc;
    const bytes = Buffer.byteLength(canonicalJson(doc));
    total += bytes;
    manifestFiles.push({ path, sha256: contentHash(doc), bytes });
  }
  const header = {
    schema_version: SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    bundle_id: syntheticUuid("bundle-1"),
    created_at,
    workspace_id: workspaceId("A"),
    generator: { name: PRODUCT_NAME, version: PRODUCT_VERSION },
    redacted: true as const,
    manifest: { files: manifestFiles, file_count: manifestFiles.length, total_bytes: total },
  };
  return { ...header, bundle_hash: contentHash(header), files, complete: true };
}
