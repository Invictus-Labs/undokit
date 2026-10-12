import { redactText } from "./redact.js";
import { AppError, type ErrorCode, type ErrorDetail } from "./errors.js";
import { DEFAULT_LIMITS, type ConnectorPolicy, type FieldConfig, type Scalar } from "./types.js";

/** Echo a submitted key name only when it is not credential-shaped; never more than 64 characters. */
function safeKey(key: string): string {
  const shown = key.slice(0, 64);
  return redactText(shown) === shown ? shown : "[redacted]";
}

const DELETE_LIKE = /^(_?deleted?|_?delete_?\w*|_?remove\w*|_?destroy\w*|_?purge\w*|\$unset|\$delete|\$remove)$/i;
const SEND_LIKE = /^(send|sent|email|e_?mail|sms|notify|notification|message|dispatch|publish|broadcast|invite|send_\w+|\w+_send)$/i;

/** Classify a rejected key so operators get the precise reason (AC-01). */
export function classifyForbiddenKey(key: string): ErrorCode {
  if (DELETE_LIKE.test(key)) return "DELETION_FORBIDDEN";
  if (SEND_LIKE.test(key)) return "FORBIDDEN_ACTION";
  return "FIELD_NOT_ALLOWED";
}

const PRIORITY: ErrorCode[] = [
  "DELETION_FORBIDDEN",
  "FORBIDDEN_ACTION",
  "RECORD_OUT_OF_SCOPE",
  "FIELD_NOT_ALLOWED",
  "NON_SCALAR_VALUE",
  "FIELD_VALUE_INVALID",
  "VALIDATION_FAILED",
];

export interface ValidatedPatchField {
  field: string;
  value: Scalar;
  config: FieldConfig;
}

export function isInScope(policy: ConnectorPolicy, recordRef: string): boolean {
  if (recordRef.includes("..")) return false;
  return policy.record_prefixes.some((prefix) => recordRef.startsWith(prefix));
}

function checkValue(config: FieldConfig, value: unknown): ErrorDetail | null {
  const field = config.name;
  if (value === null) {
    return config.nullable ? null : { code: "FIELD_VALUE_INVALID", field, message: "null is not allowed for this field" };
  }
  if (typeof value === "object" || typeof value === "function" || typeof value === "undefined" || typeof value === "bigint" || typeof value === "symbol") {
    return { code: "NON_SCALAR_VALUE", field, message: "only scalar values (string, number, boolean) are accepted" };
  }
  if (typeof value !== config.type) {
    return { code: "FIELD_VALUE_INVALID", field, message: `expected ${config.type}` };
  }
  if (typeof value === "string") {
    if (value.includes("\u0000")) return { code: "FIELD_VALUE_INVALID", field, message: "NUL characters are not allowed" };
    if (value.length > config.max_length) {
      return { code: "FIELD_VALUE_INVALID", field, message: `longer than ${config.max_length} characters` };
    }
    if (config.enum && !config.enum.includes(value)) {
      return { code: "FIELD_VALUE_INVALID", field, message: "not one of the permitted values" };
    }
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    return { code: "FIELD_VALUE_INVALID", field, message: "number out of range" };
  }
  return null;
}

/**
 * Validate a requested patch against the connector allowlist and record scope. Runs entirely before
 * any provider call (AC-01): nothing is read or written for a rejected intent. Error messages never
 * echo submitted values.
 */
export function validateIntent(policy: ConnectorPolicy, recordRef: string, patch: unknown): ValidatedPatchField[] {
  const problems: ErrorDetail[] = [];
  if (!isInScope(policy, recordRef)) {
    problems.push({ code: "RECORD_OUT_OF_SCOPE", message: "record_ref is outside the connector scope" });
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new AppError("VALIDATION_FAILED", "patch must be an object of field to scalar value");
  }
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length === 0) throw new AppError("VALIDATION_FAILED", "patch must change at least one field");
  if (entries.length > DEFAULT_LIMITS.maxPatchFields) {
    throw new AppError("VALIDATION_FAILED", `patch may change at most ${DEFAULT_LIMITS.maxPatchFields} fields`);
  }
  const byName = new Map(policy.allowed_fields.map((f) => [f.name, f]));
  const accepted: ValidatedPatchField[] = [];
  for (const [key, value] of entries) {
    const config = byName.get(key);
    if (!config) {
      const code = classifyForbiddenKey(key);
      problems.push({ code, field: safeKey(key), message: forbiddenMessage(code) });
      continue;
    }
    const problem = checkValue(config, value);
    if (problem) problems.push(problem);
    else accepted.push({ field: key, value: value as Scalar, config });
  }
  if (problems.length > 0) {
    const code = PRIORITY.find((p) => problems.some((d) => d.code === p)) ?? "VALIDATION_FAILED";
    throw new AppError(code, `intent rejected before any write: ${problems.length} problem(s)`, problems);
  }
  return accepted.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

function forbiddenMessage(code: ErrorCode): string {
  if (code === "DELETION_FORBIDDEN") return "deletion is never allowed";
  if (code === "FORBIDDEN_ACTION") return "sending or notifying is never allowed";
  return "field is not in the connector allowlist";
}

/** Top-level request keys that signal a forbidden action even though the body schema is strict. */
export function classifyUnknownBodyKeys(body: unknown): AppError | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const known = new Set(["connector_id", "record_ref", "patch", "expected_version"]);
  const unknown = Object.keys(body as Record<string, unknown>).filter((k) => !known.has(k));
  if (unknown.length === 0) return null;
  const details: ErrorDetail[] = unknown.map((key) => {
    const code = classifyForbiddenKey(key);
    return {
      code: code === "FIELD_NOT_ALLOWED" ? "VALIDATION_FAILED" : code,
      field: safeKey(key),
      message: code === "FIELD_NOT_ALLOWED" ? "unknown request key" : forbiddenMessage(code),
    };
  });
  const code = PRIORITY.find((p) => details.some((d) => d.code === p)) ?? "VALIDATION_FAILED";
  return new AppError(code, "request contains keys that are not part of the contract", details);
}
