/**
 * Generates schemas/operation.json and schemas/evidence-bundle.json from the zod schemas in
 * types.ts so the shipped JSON Schema can never drift from runtime validation.
 *   node --import tsx src/domain/schema-gen.ts [outDir]     (default: ./schemas)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as t from "./types.js";

function toSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

export function buildOperationSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://undokit.local/schemas/operation.json",
    title: "UndoKit operation API and document schemas",
    description: `schema_version ${t.SCHEMA_VERSION}. Generated from src/domain/types.ts; do not edit by hand.`,
    schema_version: t.SCHEMA_VERSION,
    $defs: {
      CreateOperationRequest: toSchema(t.createOperationRequestSchema),
      PlanResponse: toSchema(t.planResponseSchema),
      ApproveRequest: toSchema(t.approveRequestSchema),
      ApproveResponse: toSchema(t.approveResponseSchema),
      CompensationPlanResponse: toSchema(t.compensationPlanResponseSchema),
      CompensateRequest: toSchema(t.compensateRequestSchema),
      CompensateResponse: toSchema(t.compensateResponseSchema),
      ReconcileResponse: toSchema(t.reconcileResponseSchema),
      ResolveRequest: toSchema(t.resolveRequestSchema),
      ResolveResponse: toSchema(t.resolveResponseSchema),
      OperationView: toSchema(t.operationViewSchema),
      CompensationView: toSchema(t.compensationViewSchema),
      EventView: toSchema(t.eventViewSchema),
      JobView: toSchema(t.jobViewSchema),
      StatusView: toSchema(t.statusViewSchema),
      SessionListItem: toSchema(t.sessionListItemSchema),
      ConnectorView: toSchema(t.connectorViewSchema),
      CreateConnectorRequest: toSchema(t.createConnectorRequestSchema),
      LoginRequest: toSchema(t.loginRequestSchema),
      SessionView: toSchema(t.sessionViewSchema),
      CreateMemberRequest: toSchema(t.createMemberRequestSchema),
      MemberView: toSchema(t.memberViewSchema),
      ExportRequest: toSchema(t.exportRequestSchema),
      ImportResult: toSchema(t.importResultSchema),
      ErrorEnvelope: toSchema(t.errorEnvelopeSchema),
    },
  };
}

export function buildEvidenceBundleSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://undokit.local/schemas/evidence-bundle.json",
    title: "UndoKit evidence bundle",
    description: `schema_version ${t.SCHEMA_VERSION}. Generated from src/domain/types.ts; do not edit by hand.`,
    ...toSchema(t.evidenceBundleSchema),
  };
}

export function writeSchemas(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const files: [string, Record<string, unknown>][] = [
    ["operation.json", buildOperationSchema()],
    ["evidence-bundle.json", buildEvidenceBundleSchema()],
  ];
  return files.map(([name, doc]) => {
    const path = join(outDir, name);
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    return path;
  });
}

if (import.meta.main) {
  for (const path of writeSchemas(process.argv[2] ?? "schemas")) process.stdout.write(`${path}\n`);
}
