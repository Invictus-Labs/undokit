import { describe, expect, it } from "vitest";
import { classifyForbiddenKey, classifyUnknownBodyKeys, isInScope, validateIntent } from "../../src/domain/allowlist.js";
import { AppError, type ErrorCode } from "../../src/domain/errors.js";
import { DEFAULT_LIMITS } from "../../src/domain/types.js";
import { loadDemo, loadSecrets } from "../helpers/fixtures.js";
import { demoPolicy } from "../helpers/policy.js";

function codeOf(fn: () => unknown): ErrorCode {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  throw new Error("expected the call to throw AppError");
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected the call to throw AppError");
}

describe("AC-01 mutation allowlist (unit)", () => {
  const policy = demoPolicy();
  const ok = "contact-0001";

  it("accepts a configured scalar field patch", () => {
    const fields = validateIntent(policy, ok, { lifecycle_stage: "customer", lead_score: 41 });
    expect(fields.map((f) => [f.field, f.value])).toEqual([
      ["lead_score", 41],
      ["lifecycle_stage", "customer"],
    ]);
  });

  it("accepts a nullable field set to null and a string at exactly max_length", () => {
    expect(validateIntent(policy, ok, { owner_label: null })[0]?.value).toBeNull();
    expect(validateIntent(policy, ok, { owner_label: "x".repeat(64) })).toHaveLength(1);
  });

  it("rejects a string one character over max_length and a value outside the enum", () => {
    expect(codeOf(() => validateIntent(policy, ok, { owner_label: "x".repeat(65) }))).toBe("FIELD_VALUE_INVALID");
    expect(codeOf(() => validateIntent(policy, ok, { lifecycle_stage: "prospect" }))).toBe("FIELD_VALUE_INVALID");
  });

  it("rejects wrong scalar types, NUL characters and out-of-range numbers", () => {
    expect(codeOf(() => validateIntent(policy, ok, { lead_score: "40" }))).toBe("FIELD_VALUE_INVALID");
    expect(codeOf(() => validateIntent(policy, ok, { lifecycle_stage: true }))).toBe("FIELD_VALUE_INVALID");
    expect(codeOf(() => validateIntent(policy, ok, { owner_label: "a\u0000b" }))).toBe("FIELD_VALUE_INVALID");
    expect(codeOf(() => validateIntent(policy, ok, { lead_score: Number.POSITIVE_INFINITY }))).toBe("FIELD_VALUE_INVALID");
    expect(codeOf(() => validateIntent(policy, ok, { lead_score: Number.NaN }))).toBe("FIELD_VALUE_INVALID");
    expect(codeOf(() => validateIntent(policy, ok, { lead_score: Number.MAX_SAFE_INTEGER + 2 }))).toBe("FIELD_VALUE_INVALID");
  });

  const expectedCode: Record<string, ErrorCode> = {
    "unknown field": "FIELD_NOT_ALLOWED",
    "deletion via null": "FIELD_VALUE_INVALID",
    "send-style field": "FORBIDDEN_ACTION",
    "nested object": "NON_SCALAR_VALUE",
    "array value": "NON_SCALAR_VALUE",
    "outside connector scope": "RECORD_OUT_OF_SCOPE",
    "empty patch": "VALIDATION_FAILED",
  };

  const rejected = loadDemo().rejected_patches;
  it("fixture covers every rejected-patch class used below", () => {
    expect(rejected.map((r) => r.name).sort()).toEqual(Object.keys(expectedCode).sort());
  });

  it.each(rejected.map((r) => [r.name, r] as const))(
    "rejects unknown field, nested object, array, null deletion and send-style fields: %s",
    (name, entry) => {
      expect(codeOf(() => validateIntent(policy, entry.record_ref, entry.patch))).toBe(expectedCode[name]);
    },
  );

  it("classifies deletion-like and send-like keys precisely", () => {
    for (const key of ["deleted", "delete", "_delete_all", "remove_contact", "destroy", "purge_history", "$unset"]) {
      expect(classifyForbiddenKey(key), key).toBe("DELETION_FORBIDDEN");
    }
    for (const key of ["email", "send_email", "sms", "notify", "message", "dispatch", "welcome_send", "broadcast"]) {
      expect(classifyForbiddenKey(key), key).toBe("FORBIDDEN_ACTION");
    }
    expect(classifyForbiddenKey("favorite_color")).toBe("FIELD_NOT_ALLOWED");
  });

  it("a deletion key wins over other problems in the same patch (most severe code is reported)", () => {
    expect(codeOf(() => validateIntent(policy, ok, { favorite_color: "blue", deleted: true }))).toBe("DELETION_FORBIDDEN");
  });

  it("rejects a record_ref outside connector scope and path-like refs", () => {
    expect(isInScope(policy, "contact-0001")).toBe(true);
    expect(isInScope(policy, "contact-")).toBe(true);
    expect(isInScope(policy, "contact")).toBe(false);
    expect(isInScope(policy, "Contact-0001")).toBe(false);
    expect(isInScope(policy, "outside-0001")).toBe(false);
    expect(isInScope(policy, "contact-0001/../outside-1")).toBe(false);
    expect(codeOf(() => validateIntent(policy, "outside-0001", { lifecycle_stage: "customer" }))).toBe("RECORD_OUT_OF_SCOPE");
  });

  it("rejects non-object patches", () => {
    for (const bad of [null, undefined, "x", 3, [], [{ lifecycle_stage: "customer" }]]) {
      expect(codeOf(() => validateIntent(policy, ok, bad))).toBe("VALIDATION_FAILED");
    }
  });

  it("enforces the patch field-count boundary (maxPatchFields)", () => {
    const wide = {
      allowed_fields: Array.from({ length: DEFAULT_LIMITS.maxPatchFields + 1 }, (_, i) => ({
        name: `f${i}`,
        type: "string" as const,
        max_length: 8,
        nullable: false,
        sensitive: false,
      })),
      record_prefixes: ["contact-"],
    };
    const patchOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, "v"]));
    expect(validateIntent(wide, ok, patchOf(DEFAULT_LIMITS.maxPatchFields))).toHaveLength(DEFAULT_LIMITS.maxPatchFields);
    expect(codeOf(() => validateIntent(wide, ok, patchOf(DEFAULT_LIMITS.maxPatchFields + 1)))).toBe("VALIDATION_FAILED");
  });

  it("error text never echoes submitted values (a planted secret stays out of the message and details)", () => {
    const secret = loadSecrets().needles[0] as string;
    const err = errorOf(() => validateIntent(policy, ok, { lifecycle_stage: secret, favorite_color: secret }));
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(secret);
  });

  it("long hostile key names are truncated in details, not echoed whole", () => {
    const key = "k".repeat(5000);
    const err = errorOf(() => validateIntent(policy, ok, { [key]: "v" }));
    expect(JSON.stringify(err.details).length).toBeLessThan(1000);
  });

  it("classifyUnknownBodyKeys flags forbidden top-level keys and passes the contract keys", () => {
    expect(classifyUnknownBodyKeys({ connector_id: "x", record_ref: "r", patch: {}, expected_version: "v" })).toBeNull();
    expect(classifyUnknownBodyKeys("not an object")).toBeNull();
    expect(classifyUnknownBodyKeys([])).toBeNull();
    expect(classifyUnknownBodyKeys({ patch: {}, delete_record: true })?.code).toBe("DELETION_FORBIDDEN");
    expect(classifyUnknownBodyKeys({ patch: {}, send_email: "x" })?.code).toBe("FORBIDDEN_ACTION");
    expect(classifyUnknownBodyKeys({ patch: {}, favorite_color: "x" })?.code).toBe("VALIDATION_FAILED");
  });
});
