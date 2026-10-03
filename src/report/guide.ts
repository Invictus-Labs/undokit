/**
 * Operator-facing wording for every operation and compensation state. Shared by
 * the static report and the web UI so both always show the same reason and next
 * step. Uncertain, conflicting and partial states are never worded as success.
 * This module has no imports so it can be bundled into the browser.
 */

export type Tone = "ok" | "info" | "warn" | "bad";

export interface StateGuide {
  label: string;
  tone: Tone;
  /** True when the state needs a human decision or read-only reconciliation. */
  needsAttention: boolean;
  reason: string;
  nextStep: string;
}

/** Operation states (apply machine), lowercase as served by the API. */
export const OPERATION_GUIDE: Record<string, StateGuide> = {
  planned: {
    label: "Planned",
    tone: "info",
    needsAttention: false,
    reason: "A change plan is recorded. Nothing has been written to the provider.",
    nextStep: "Review the field diff and approve the plan hash, or leave it to expire.",
  },
  approved: {
    label: "Approved",
    tone: "info",
    needsAttention: false,
    reason: "The plan hash is approved. The write has not been dispatched yet.",
    nextStep: "Wait for the worker to apply it. A changed plan or an expired approval invalidates authorization.",
  },
  applying: {
    label: "Applying",
    tone: "info",
    needsAttention: false,
    reason: "The conditional write is in flight.",
    nextStep: "Wait. If the outcome is not confirmed it becomes Unknown and needs read-only reconciliation.",
  },
  applied: {
    label: "Applied",
    tone: "ok",
    needsAttention: false,
    reason: "The provider accepted the conditional write and the observed after state matches the plan.",
    nextStep: "Nothing required. A compensation can be previewed later; it needs its own approval.",
  },
  failed: {
    label: "Failed",
    tone: "bad",
    needsAttention: true,
    reason: "The write was refused or could not complete. No change is assumed on the provider.",
    nextStep: "Read the attempt details, fix the cause, then create a new plan. The failed attempt stays in the history.",
  },
  conflict: {
    label: "Conflict",
    tone: "warn",
    needsAttention: true,
    reason: "The record changed on the provider after the plan was read, so the conditional write was refused and nothing was overwritten.",
    nextStep: "Re-read the record, review the intervening edit, then create a new plan or decide manually.",
  },
  unknown: {
    label: "Unknown outcome",
    tone: "warn",
    needsAttention: true,
    reason: "It is not known whether the remote write happened. The result is not treated as success or failure.",
    nextStep: "Run read-only reconciliation. Do not retry the write until the provider state is observed.",
  },
};

/** Compensation states (restore machine), lowercase as served by the API. */
export const COMPENSATION_GUIDE: Record<string, StateGuide> = {
  planned: {
    label: "Compensation planned",
    tone: "info",
    needsAttention: false,
    reason: "A compensation preview exists. No restore has been written.",
    nextStep: "Review the exact fields, then approve the compensation separately.",
  },
  approved: {
    label: "Compensation approved",
    tone: "info",
    needsAttention: false,
    reason: "The compensation plan hash is approved but not yet dispatched.",
    nextStep: "Wait for the worker. A changed current value or version blocks it.",
  },
  compensating: {
    label: "Compensating",
    tone: "info",
    needsAttention: false,
    reason: "The conditional restore is in flight.",
    nextStep: "Wait. An unconfirmed restore becomes Unknown and needs read-only reconciliation.",
  },
  compensated: {
    label: "Compensated",
    tone: "ok",
    needsAttention: false,
    reason: "The recorded before values were restored with conditional writes and the observed result matches.",
    nextStep: "Nothing required.",
  },
  conflict: {
    label: "Compensation blocked",
    tone: "warn",
    needsAttention: true,
    reason: "Current provider values or versions no longer match the recorded post-write state, so the restore was blocked and later edits were left untouched.",
    nextStep: "Review the later edits and decide manually; UndoKit will not overwrite them.",
  },
  failed: {
    label: "Compensation failed",
    tone: "bad",
    needsAttention: true,
    reason: "The restore was confirmed not to have been applied.",
    nextStep: "Read the attempt details and create a new compensation plan if a restore is still wanted.",
  },
  unknown: {
    label: "Compensation unknown",
    tone: "warn",
    needsAttention: true,
    reason: "It is not known whether the restore reached the provider.",
    nextStep: "Run read-only reconciliation before any further action.",
  },
};

function unrecognised(state: string): StateGuide {
  return {
    label: state,
    tone: "warn",
    needsAttention: true,
    reason: "This state is not recognised by this version of the viewer.",
    nextStep: "Treat the outcome as unresolved, check the raw evidence, or upgrade UndoKit.",
  };
}

/** Unknown states are shown as needing attention, never as success. */
export function operationGuide(state: string, failureCode?: string | null): StateGuide {
  if (state === "failed" && failureCode === OPERATOR_RESOLVED) return OPERATOR_RESOLVED_GUIDE;
  return OPERATION_GUIDE[state] ?? unrecognised(state);
}

export function compensationGuide(state: string, failureCode?: string | null): StateGuide {
  if (state === "failed" && failureCode === OPERATOR_RESOLVED) return { ...OPERATOR_RESOLVED_GUIDE, label: "Compensation closed by administrator" };
  return COMPENSATION_GUIDE[state] ?? unrecognised(state);
}

/** Per-field outcomes for the apply and compensate phases. */
const FIELD_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "info" },
  applied: { label: "Applied", tone: "ok" },
  restored: { label: "Restored", tone: "ok" },
  not_applied: { label: "Not applied", tone: "warn" },
  not_restored: { label: "Not restored", tone: "warn" },
  changed_other: { label: "Changed by someone else", tone: "warn" },
  mismatch: { label: "Value mismatch", tone: "bad" },
};

export function fieldOutcome(outcome: string): { label: string; tone: Tone } {
  return FIELD_OUTCOME[outcome] ?? { label: outcome, tone: "warn" };
}

const CONFLICT_CODE: Record<string, string> = {
  VALUE_CHANGED: "The field value changed after the post-write state was recorded.",
  VERSION_CHANGED: "The record version changed after the post-write state was recorded.",
  RECORD_MISSING: "The record no longer exists on the provider.",
};

export function conflictText(code: string): string {
  return CONFLICT_CODE[code] ?? `Conflict: ${code}`;
}

const ATTEMPT_OUTCOME: Record<string, string> = {
  started: "Started (outcome not yet recorded)",
  succeeded: "Succeeded",
  conflict: "Refused: record changed",
  failed: "Failed",
  unknown: "Unknown (not confirmed)",
  reconciled_applied: "Reconciled: change is present",
  reconciled_not_applied: "Reconciled: change is not present",
  reconciled_indeterminate: "Reconciled: still indeterminate",
};

export function attemptOutcomeLabel(outcome: string): string {
  return ATTEMPT_OUTCOME[outcome] ?? outcome;
}

/** Field outcomes that mean the field did not end in the planned or restored state; they are never a success. */
const FIELD_PROBLEMS = new Set(["not_applied", "not_restored", "changed_other", "mismatch"]);

export function fieldNeedsAttention(outcome: string): boolean {
  if (outcome === "pending" || outcome === "applied" || outcome === "restored") return false;
  return FIELD_PROBLEMS.has(outcome) || !(outcome in FIELD_OUTCOME);
}

/** Failure code recorded when an administrator closed an UNKNOWN outcome without proof from the provider. */
export const OPERATOR_RESOLVED = "OPERATOR_RESOLVED";

const OPERATOR_RESOLVED_GUIDE: StateGuide = {
  label: "Closed by administrator",
  tone: "warn",
  needsAttention: true,
  reason:
    "An administrator closed this without confirmation from the provider, so what is actually on the provider is not verified. The provider was not contacted. If it later reports that the write happened, this reopens as Unknown.",
  nextStep: "Check the record on the provider directly if the outcome matters, then plan a new change if one is still wanted.",
};
