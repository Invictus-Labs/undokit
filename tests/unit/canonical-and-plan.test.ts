import { describe, expect, it } from "vitest";
import { HASH_PATTERN, canonicalJson, contentHash, sha256Hex } from "../../src/domain/canonical.js";
import {
  applyPlanDocument,
  computeApplyPlanHash,
  computeCompensationPlanHash,
  computeIntentHash,
  fieldValueHash,
  type ApplyPlanInput,
  type CompensationPlanInput,
} from "../../src/domain/plan.js";
import { actorId, connectorId, syntheticUuid, workspaceId } from "../helpers/fixtures.js";

const base: ApplyPlanInput = {
  operation_id: syntheticUuid("operation-1"),
  workspace_id: workspaceId("A"),
  connector_id: connectorId(),
  record_ref: "contact-0001",
  expected_version: "v1",
  fields: [
    { field: "lifecycle_stage", before: "lead", intended: "customer" },
    { field: "lead_score", before: 40, intended: 41 },
  ],
};

describe("canonical JSON and content hashes", () => {
  it("sorts keys, drops whitespace and normalizes negative zero", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,2]},"b":1}');
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });

  it("preserves array order (order is meaningful) and string escapes", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson('quote " and \n newline')).toBe(JSON.stringify('quote " and \n newline'));
  });

  it("orders keys by UTF-16 code units, independent of insertion order", () => {
    expect(canonicalJson({ "é": 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"é":1}');
  });

  it("rejects values that could make two documents hash alike", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
  });

  it("accepts null-prototype objects", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.k = 1;
    expect(canonicalJson(o)).toBe('{"k":1}');
  });

  it("contentHash has the documented shape, is deterministic and matches a known vector", () => {
    const h = contentHash({ a: 1 });
    expect(h).toMatch(HASH_PATTERN);
    expect(h).toBe(contentHash({ a: 1 }));
    // sha256 of the UTF-8 bytes {"a":1}
    expect(h).toBe(`sha256:${sha256Hex('{"a":1}')}`);
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("AC-02 approval binding (unit): plan hash covers exactly what the approver authorizes", () => {
  it("plan hash is stable over canonical JSON key order and field order", () => {
    const reordered: ApplyPlanInput = { ...base, fields: [...base.fields].reverse() };
    expect(computeApplyPlanHash(reordered)).toBe(computeApplyPlanHash(base));
    expect(computeApplyPlanHash(base)).toMatch(HASH_PATTERN);
    const doc = applyPlanDocument(base);
    expect(doc.fields.map((f) => f.field)).toEqual(["lead_score", "lifecycle_stage"]);
  });

  it("changed patch changes the hash and invalidates the approval (every authorized input is bound)", () => {
    const original = computeApplyPlanHash(base);
    const variants: Record<string, ApplyPlanInput> = {
      "intended value": { ...base, fields: [{ field: "lifecycle_stage", before: "lead", intended: "churned" }, base.fields[1]!] },
      "before value": { ...base, fields: [{ field: "lifecycle_stage", before: "customer", intended: "customer" }, base.fields[1]!] },
      "field name": { ...base, fields: [{ field: "owner_label", before: "lead", intended: "customer" }, base.fields[1]!] },
      "extra field": { ...base, fields: [...base.fields, { field: "owner_label", before: "a", intended: "b" }] },
      "removed field": { ...base, fields: [base.fields[0]!] },
      "expected version": { ...base, expected_version: "v2" },
      "record": { ...base, record_ref: "contact-0002" },
      "connector": { ...base, connector_id: syntheticUuid("other-connector") },
      "workspace": { ...base, workspace_id: workspaceId("B") },
      "operation": { ...base, operation_id: syntheticUuid("operation-2") },
    };
    for (const [name, input] of Object.entries(variants)) {
      expect(computeApplyPlanHash(input), name).not.toBe(original);
    }
  });

  it("type confusion cannot collide: the number 1 and the string \"1\" hash differently", () => {
    const a = computeApplyPlanHash({ ...base, fields: [{ field: "lead_score", before: 0, intended: 1 }] });
    const b = computeApplyPlanHash({ ...base, fields: [{ field: "lead_score", before: 0, intended: "1" }] });
    expect(a).not.toBe(b);
  });

  it("intent hash ignores nothing the caller asked for and nothing the server read", () => {
    const intent = {
      workspace_id: workspaceId("A"),
      connector_id: connectorId(),
      record_ref: "contact-0001",
      patch: { lifecycle_stage: "customer", lead_score: 41 },
      expected_version: "v1",
    };
    expect(computeIntentHash({ ...intent, patch: { lead_score: 41, lifecycle_stage: "customer" } })).toBe(computeIntentHash(intent));
    expect(computeIntentHash({ ...intent, patch: { lifecycle_stage: "churned", lead_score: 41 } })).not.toBe(computeIntentHash(intent));
    expect(computeIntentHash({ ...intent, expected_version: "v2" })).not.toBe(computeIntentHash(intent));
    expect(computeIntentHash({ ...intent, workspace_id: workspaceId("B") })).not.toBe(computeIntentHash(intent));
  });

  const comp: CompensationPlanInput = {
    operation_id: base.operation_id,
    workspace_id: base.workspace_id,
    connector_id: base.connector_id,
    record_ref: base.record_ref,
    expected_version: "v2",
    fields: [{ field: "lifecycle_stage", expected_current: "customer", restore_to: "lead" }],
  };

  it("a compensation plan hash differs from the apply plan hash and binds the expected version and values", () => {
    const h = computeCompensationPlanHash(comp);
    expect(h).toMatch(HASH_PATTERN);
    expect(h).not.toBe(computeApplyPlanHash(base));
    expect(computeCompensationPlanHash({ ...comp, expected_version: "v3" })).not.toBe(h);
    expect(computeCompensationPlanHash({ ...comp, fields: [{ ...comp.fields[0]!, expected_current: "partner" }] })).not.toBe(h);
    expect(computeCompensationPlanHash({ ...comp, fields: [{ ...comp.fields[0]!, restore_to: "churned" }] })).not.toBe(h);
  });

  it("field value hashes are bound to the operation and role", () => {
    const a = fieldValueHash(base.operation_id, "lifecycle_stage", "before", "lead");
    expect(fieldValueHash(syntheticUuid("operation-2"), "lifecycle_stage", "before", "lead")).not.toBe(a);
    expect(fieldValueHash(base.operation_id, "lifecycle_stage", "intended", "lead")).not.toBe(a);
    expect(fieldValueHash(base.operation_id, "lifecycle_stage", "before", "lead")).toBe(a);
  });

  it("synthetic fixture ids are deterministic, UUID-shaped and distinct per seed", () => {
    expect(syntheticUuid("x")).toBe(syntheticUuid("x"));
    expect(syntheticUuid("x")).not.toBe(syntheticUuid("y"));
    expect(syntheticUuid("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(["admin-a", "operator-a", "viewer-a", "admin-b", "operator-b"].map(actorId)).size).toBe(5);
  });
});
