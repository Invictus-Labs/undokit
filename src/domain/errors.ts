/** Stable error codes. HTTP status per code is part of the frozen API contract. */
export const ERROR_STATUS = {
  // 400 malformed input
  MALFORMED_REQUEST: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  BUNDLE_MALFORMED: 400,
  // 401 unauthenticated
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  // 403 forbidden action
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  // 404 inaccessible object (missing OR other workspace; indistinguishable by design)
  NOT_FOUND: 404,
  // 409 version / idempotency / state conflict
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PLAN_HASH_MISMATCH: 409,
  INVALID_STATE: 409,
  APPROVAL_EXPIRED: 409,
  PLAN_EXPIRED: 409,
  COMPENSATION_BLOCKED: 409,
  UNRESOLVED_OPERATION: 409,
  DUPLICATE_RESOURCE: 409,
  // 413 oversize payload
  PAYLOAD_TOO_LARGE: 413,
  // 422 schema / policy rejection
  VALIDATION_FAILED: 422,
  FIELD_NOT_ALLOWED: 422,
  FIELD_VALUE_INVALID: 422,
  NON_SCALAR_VALUE: 422,
  DELETION_FORBIDDEN: 422,
  FORBIDDEN_ACTION: 422,
  RECORD_OUT_OF_SCOPE: 422,
  RECORD_NOT_FOUND: 422,
  CONNECTOR_READ_ONLY: 422,
  BUNDLE_UNSUPPORTED: 422,
  BUNDLE_INTEGRITY_FAILED: 422,
  // 429 rate limit
  RATE_LIMITED: 429,
  // 500 / 503
  INTERNAL_ERROR: 500,
  DEPENDENCY_UNAVAILABLE: 503,
  NOT_READY: 503,
  CONNECTOR_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export interface ErrorDetail {
  code: ErrorCode | string;
  field?: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; request_id: string; details?: ErrorDetail[] };
}

export function errorEnvelope(err: AppError, requestId: string): ErrorEnvelope {
  const body: ErrorEnvelope = { error: { code: err.code, message: err.message, request_id: requestId } };
  if (err.details && err.details.length > 0) body.error.details = err.details;
  return body;
}

/** Thrown by fault-injection hooks to simulate abrupt process death; never caught by the worker. */
export class InjectedCrash extends Error {
  constructor(readonly point: string) {
    super(`injected crash at ${point}`);
    this.name = "InjectedCrash";
  }
}
