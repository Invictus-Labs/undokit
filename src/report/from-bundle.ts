/**
 * Build report input from an evidence bundle that the caller has already
 * verified (hashes, version, completeness). The renderer never trusts the
 * bundle for markup: every value is redacted and escaped at render time.
 */

import type { EvidenceBundle, OperationView } from "../domain/types.js";
import type { ReportInput } from "./render.js";

export function reportInputFromBundle(bundle: EvidenceBundle, dataSource: string): ReportInput {
  const operations: OperationView[] = Object.keys(bundle.files)
    .sort()
    .map((path) => bundle.files[path]!.operation);
  // Oldest first, ties broken by id, so the report is deterministic.
  operations.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  return {
    generated_at: bundle.created_at,
    data_source: dataSource,
    schema_version: bundle.schema_version,
    bundle_id: bundle.bundle_id,
    bundle_hash: bundle.bundle_hash,
    operations,
  };
}

/** True when any operation or compensation in the report is unresolved, blocked, failed or unknown. */
export { needsAttention } from "./render.js";
