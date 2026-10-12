import { describe, expect, it } from "vitest";
import { FixedClock, SequentialIds, iso, randomIds, systemClock } from "../../src/domain/clock.js";
import { ERROR_CODES, ERROR_STATUS, AppError, errorEnvelope } from "../../src/domain/errors.js";
import {
  approveRequestSchema,
  compensateRequestSchema,
  createConnectorRequestSchema,
  createMemberRequestSchema,
  createOperationRequestSchema,
  evidenceBundleSchema,
} from "../../src/domain/types.js";
import { FIXED_NOW_ISO, connectorId, syntheticUuid } from "../helpers/fixtures.js";
import { demoPolicy } from "../helpers/policy.js";

describe("clock and ids (determinism for tests)", () => {
  it("FixedClock returns the fixed UTC instant and advances by exact milliseconds", () => {
    const c = new FixedClock(FIXED_NOW_ISO);
    expect(iso(c.now())).toBe(FIXED_NOW_ISO);
    c.advance(900_000);
    expect(iso(c.now())).toBe("2026-01-15T12:15:00.000Z");
    c.set("2026-02-01T00:00:00.000Z");
    expect(iso(c.now())).toBe("2026-02-01T00:00:00.000Z");
  });

  it("FixedClock rejects an invalid timestamp instead of producing NaN time", () => {
    expect(() => new FixedClock("not a date")).toThrow(TypeError);
  });

  it("SequentialIds are deterministic, unique, UUID-shaped; a bad prefix is rejected", () => {
    const ids = new SequentialIds("0000abcd");
    const a = ids.next();
    const b = ids.next();
    expect(a).toBe(["0000abcd", "0000", "4000", "8000", "000000000001"].join("-"));
    expect(b).not.toBe(a);
    expect(() => new SequentialIds("xyz")).toThrow(TypeError);
  });

  it("system clock and random ids work and differ from the fixed clock", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(5000);
    expect(randomIds.next()).not.toBe(randomIds.next());
  });
});

describe("error contract", () => {
  it("every error code maps to a documented HTTP status class", () => {
    const allowed = new Set([400, 401, 403, 404, 409, 413, 422, 429, 500, 503]);
    for (const code of ERROR_CODES) expect(allowed.has(ERROR_STATUS[code]), code).toBe(true);
  });

  it("PRD-mandated mappings hold: conflict 409, forbidden field 422, oversize 413, inaccessible 404", () => {
    expect(ERROR_STATUS.VERSION_CONFLICT).toBe(409);
    expect(ERROR_STATUS.IDEMPOTENCY_CONFLICT).toBe(409);
    expect(ERROR_STATUS.FIELD_NOT_ALLOWED).toBe(422);
    expect(ERROR_STATUS.DELETION_FORBIDDEN).toBe(422);
    expect(ERROR_STATUS.FORBIDDEN_ACTION).toBe(422);
    expect(ERROR_STATUS.RECORD_OUT_OF_SCOPE).toBe(422);
    expect(ERROR_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.DEPENDENCY_UNAVAILABLE).toBe(503);
  });

  it("the envelope carries code, message and request_id; details only when present", () => {
    const bare = errorEnvelope(new AppError("NOT_FOUND", "nope"), "req-1");
    expect(bare).toEqual({ error: { code: "NOT_FOUND", message: "nope", request_id: "req-1" } });
    const detailed = errorEnvelope(new AppError("VALIDATION_FAILED", "bad", [{ code: "X", message: "m" }]), "req-2");
    expect(detailed.error.details).toHaveLength(1);
  });
});

describe("frozen request schemas reject anything outside the contract", () => {
  const op = {
    connector_id: connectorId(),
    record_ref: "contact-0001",
    patch: { lifecycle_stage: "customer" },
    expected_version: "v1",
  };

  it("accepts the contract body and rejects extra keys, bad uuid, bad record_ref, missing version", () => {
    expect(createOperationRequestSchema.safeParse(op).success).toBe(true);
    expect(createOperationRequestSchema.safeParse({ ...op, send_email: "x" }).success).toBe(false);
    expect(createOperationRequestSchema.safeParse({ ...op, connector_id: "not-a-uuid" }).success).toBe(false);
    expect(createOperationRequestSchema.safeParse({ ...op, record_ref: "../etc" }).success).toBe(false);
    expect(createOperationRequestSchema.safeParse({ ...op, record_ref: "a".repeat(129) }).success).toBe(false);
    expect(createOperationRequestSchema.safeParse({ ...op, expected_version: "" }).success).toBe(false);
    const { expected_version: _omit, ...missing } = op;
    expect(createOperationRequestSchema.safeParse(missing).success).toBe(false);
  });

  it("approve and compensate require a well-formed plan hash", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    expect(approveRequestSchema.safeParse({ plan_hash: hash, expected_version: "v1" }).success).toBe(true);
    expect(approveRequestSchema.safeParse({ plan_hash: "sha256:xyz", expected_version: "v1" }).success).toBe(false);
    expect(approveRequestSchema.safeParse({ plan_hash: hash }).success).toBe(false);
    expect(compensateRequestSchema.safeParse({ plan_hash: hash }).success).toBe(true);
    expect(compensateRequestSchema.safeParse({ plan_hash: hash, extra: 1 }).success).toBe(false);
  });

  it("members need a 12+ character password and a known role; connectors need a policy", () => {
    const m = { email: "viewer@example.test", password: "x".repeat(12), role: "viewer" };
    expect(createMemberRequestSchema.safeParse(m).success).toBe(true);
    expect(createMemberRequestSchema.safeParse({ ...m, password: "short" }).success).toBe(false);
    expect(createMemberRequestSchema.safeParse({ ...m, role: "owner" }).success).toBe(false);
    const c = { kind: "simulator", name: "synthetic-crm", policy: demoPolicy() };
    expect(createConnectorRequestSchema.safeParse(c).success).toBe(true);
    expect(createConnectorRequestSchema.safeParse({ ...c, policy: { allowed_fields: [], record_prefixes: ["x"] } }).success).toBe(false);
    expect(createConnectorRequestSchema.safeParse({ kind: "couchdb", name: "x", policy: demoPolicy(), config: { base_url: "http://localhost:5984", database: "crm" } }).success).toBe(false);
  });

  it("an evidence bundle must be strict and carry the trailing complete marker", () => {
    expect(evidenceBundleSchema.safeParse({ schema_version: 1 }).success).toBe(false);
    expect(evidenceBundleSchema.safeParse({ schema_version: 2, kind: "undokit.evidence-bundle" }).success).toBe(false);
    expect(syntheticUuid("bundle")).toMatch(/-/);
  });
});
