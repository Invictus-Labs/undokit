import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import {
  COMPENSATION_TERMINAL,
  COMPENSATION_TRANSITIONS,
  OPERATION_TERMINAL,
  OPERATION_TRANSITIONS,
  assertTransition,
  canTransition,
} from "../../src/domain/state.js";
import { COMPENSATION_STATES, OPERATION_STATES, type CompensationState, type OperationState } from "../../src/domain/types.js";

// Independent oracle written from the PRD state contract (not copied from the implementation table):
// PLANNED -> APPROVED -> APPLYING -> APPLIED | FAILED | UNKNOWN (+ CONFLICT when the provider refused the
// precondition). UNKNOWN leaves only through read-only reconciliation. Invalidation returns APPROVED -> PLANNED.
const OP_ALLOWED = new Set([
  "planned>approved",
  "approved>applying",
  "approved>planned",
  "approved>failed",
  "applying>applied",
  "applying>failed",
  "applying>unknown",
  "applying>conflict",
  "unknown>applied",
  "unknown>failed",
  "unknown>unknown",
]);
const COMP_ALLOWED = new Set([
  "planned>approved",
  "planned>conflict",
  "approved>compensating",
  "approved>planned",
  "approved>conflict",
  "approved>failed",
  "compensating>compensated",
  "compensating>conflict",
  "compensating>failed",
  "compensating>unknown",
  "unknown>compensated",
  "unknown>failed",
  "unknown>unknown",
]);

describe("state machines: every ordered pair is checked against the PRD oracle", () => {
  it("operation transitions match the oracle for all state pairs", () => {
    for (const from of OPERATION_STATES) {
      for (const to of OPERATION_STATES) {
        expect(canTransition(OPERATION_TRANSITIONS, from, to), `${from}>${to}`).toBe(OP_ALLOWED.has(`${from}>${to}`));
      }
    }
  });

  it("compensation transitions match the oracle for all state pairs", () => {
    for (const from of COMPENSATION_STATES) {
      for (const to of COMPENSATION_STATES) {
        expect(canTransition(COMPENSATION_TRANSITIONS, from, to), `${from}>${to}`).toBe(COMP_ALLOWED.has(`${from}>${to}`));
      }
    }
  });

  it("uncertainty never becomes success by shortcut: unknown cannot jump straight to approved, applying or planned", () => {
    for (const to of ["planned", "approved", "applying", "conflict"] as OperationState[]) {
      expect(canTransition(OPERATION_TRANSITIONS, "unknown", to)).toBe(false);
    }
    for (const to of ["planned", "approved", "compensating", "conflict"] as CompensationState[]) {
      expect(canTransition(COMPENSATION_TRANSITIONS, "unknown", to)).toBe(false);
    }
  });

  it("success cannot be reached without passing through applying or compensating", () => {
    for (const from of OPERATION_STATES) {
      if (from === "applying" || from === "unknown") continue;
      expect(canTransition(OPERATION_TRANSITIONS, from, "applied"), from).toBe(false);
    }
    for (const from of COMPENSATION_STATES) {
      if (from === "compensating" || from === "unknown") continue;
      expect(canTransition(COMPENSATION_TRANSITIONS, from, "compensated"), from).toBe(false);
    }
  });

  it("terminal states have no outgoing transitions", () => {
    for (const s of OPERATION_TERMINAL) expect(OPERATION_TRANSITIONS[s]).toEqual([]);
    for (const s of COMPENSATION_TERMINAL) expect(COMPENSATION_TRANSITIONS[s]).toEqual([]);
    expect([...OPERATION_TERMINAL].sort()).toEqual(["applied", "conflict", "failed"]);
    expect([...COMPENSATION_TERMINAL].sort()).toEqual(["compensated", "conflict", "failed"]);
  });

  it("unknown is not terminal: it must be resolvable", () => {
    expect(OPERATION_TERMINAL).not.toContain("unknown");
    expect(COMPENSATION_TERMINAL).not.toContain("unknown");
  });

  it("assertTransition throws INVALID_STATE (HTTP 409) for an illegal edge and is silent for a legal one", () => {
    expect(() => assertTransition(OPERATION_TRANSITIONS, "planned", "approved", "operation")).not.toThrow();
    try {
      assertTransition(OPERATION_TRANSITIONS, "applied", "planned", "operation");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("INVALID_STATE");
      expect((err as AppError).status).toBe(409);
    }
    expect(() => assertTransition(COMPENSATION_TRANSITIONS, "compensated", "planned", "compensation")).toThrow(AppError);
  });
});
