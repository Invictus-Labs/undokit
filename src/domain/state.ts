import { AppError } from "./errors.js";
import type { CompensationState, OperationState } from "./types.js";

/**
 * Apply machine: PLANNED -> APPROVED -> APPLYING -> APPLIED | FAILED | UNKNOWN (+ CONFLICT when the
 * provider rejected the version precondition and nothing was written). UNKNOWN only leaves through
 * read-only reconciliation. Back edge APPROVED -> PLANNED is the invalidation of an expired or
 * tampered approval. APPROVED -> FAILED is a pre-dispatch refusal (no remote write attempted).
 *
 * One deliberate exception lives outside this table (services/ledger.ts reopenAfterLateResult): a FAILED operation
 * whose failure_code is NOT_APPLIED (concluded by reconciliation) returns to UNKNOWN with code LATE_RESULT when a
 * definitive WRITTEN result for the same attempt arrives late, because the remote value may have changed.
 */
export const OPERATION_TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  planned: ["approved"],
  approved: ["applying", "planned", "failed"],
  applying: ["applied", "failed", "unknown", "conflict"],
  unknown: ["applied", "failed", "unknown"],
  applied: [],
  failed: [],
  conflict: [],
};

/**
 * Compensation machine: PLAN -> APPROVED -> COMPENSATING -> COMPENSATED | CONFLICT | UNKNOWN
 * (+ FAILED for a confirmed non-effect). A plan whose preview already shows conflicts starts blocked
 * (planned -> conflict). UNKNOWN only leaves through read-only reconciliation.
 */
export const COMPENSATION_TRANSITIONS: Record<CompensationState, readonly CompensationState[]> = {
  planned: ["approved", "conflict"],
  approved: ["compensating", "planned", "conflict", "failed"],
  compensating: ["compensated", "conflict", "failed", "unknown"],
  unknown: ["compensated", "failed", "unknown"],
  compensated: [],
  conflict: [],
  failed: [],
};

export function canTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): boolean {
  return table[from].includes(to);
}

export function assertTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
  what: "operation" | "compensation",
): void {
  if (!canTransition(table, from, to)) {
    throw new AppError("INVALID_STATE", `illegal ${what} transition ${from} -> ${to}`);
  }
}

export const OPERATION_TERMINAL: readonly OperationState[] = ["applied", "failed", "conflict"];
export const COMPENSATION_TERMINAL: readonly CompensationState[] = ["compensated", "conflict", "failed"];
