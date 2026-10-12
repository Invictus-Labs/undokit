// Connector policy built from the demo fixture (QA-owned). Mirrors src/domain/types.ts ConnectorPolicy.
import { loadDemo } from "./fixtures.js";

export interface TestFieldConfig {
  name: string;
  type: "string" | "number" | "boolean";
  max_length: number;
  nullable: boolean;
  sensitive: boolean;
  enum?: string[];
}

export interface TestPolicy {
  allowed_fields: TestFieldConfig[];
  record_prefixes: string[];
}

/** Policy used by the default tests: three scalar fields, one record-ref prefix. */
export function demoPolicy(): TestPolicy {
  const demo = loadDemo();
  const byName: Record<string, TestFieldConfig> = {
    lifecycle_stage: {
      name: "lifecycle_stage",
      type: "string",
      max_length: 32,
      nullable: false,
      sensitive: false,
      enum: ["lead", "customer", "churned", "partner"],
    },
    lead_score: { name: "lead_score", type: "number", max_length: 1024, nullable: false, sensitive: false },
    owner_label: { name: "owner_label", type: "string", max_length: 64, nullable: true, sensitive: false },
  };
  return {
    allowed_fields: demo.connector.allowlist.map((name) => {
      const cfg = byName[name];
      if (!cfg) throw new Error(`fixture allowlist field has no test config: ${name}`);
      return cfg;
    }),
    record_prefixes: [demo.connector.scope_prefix],
  };
}
