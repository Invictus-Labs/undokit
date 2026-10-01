import { AppError } from "../domain/errors.js";
import type { ConnectorKind, Scalar } from "../domain/types.js";

export interface ConnectorRecord {
  record_ref: string;
  /** Opaque provider version token (CouchDB _rev, simulator counter). Compared for equality only. */
  version: string;
  /** Scalar fields only; non-scalar provider members are never exposed. */
  fields: Record<string, Scalar>;
}

export type WriteResult =
  | { outcome: "written"; new_version: string; provider_request_id: string }
  | { outcome: "conflict"; current_version: string; provider_request_id: string };

/** Nothing was sent or the provider refused before doing anything: a definite non-effect. */
export class ConnectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorUnavailableError";
  }
}

/** The request may or may not have taken effect (timeout, reset, 5xx after send). Never retried blindly. */
export class ConnectorAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAmbiguousError";
  }
}

/** The provider definitively rejected the request (4xx other than a version conflict): a definite non-effect. */
export class ConnectorRejectedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ConnectorRejectedError";
  }
}

export interface CrmConnector {
  readonly kind: ConnectorKind;
  /** True only for a real provider. The simulator is never live. */
  readonly live: boolean;
  /** Human label shown wherever the connector is displayed. */
  readonly label: string;
  /**
   * True only when the PROVIDER enforces the version precondition atomically (compare-and-set).
   * A connector without it is read-only in the MVP: a local check followed by an unconditional
   * write is never acceptable.
   */
  readonly supportsAtomicConditionalWrite: boolean;
  /** Read-only. Returns null when the record does not exist. */
  read(recordRef: string): Promise<ConnectorRecord | null>;
  /**
   * Apply `patch` iff the record's provider version still equals `expectedVersion`; the provider
   * evaluates the precondition and the write as one atomic step. Throws ConnectorUnavailableError
   * (definite non-effect), ConnectorRejectedError (definite non-effect) or ConnectorAmbiguousError.
   */
  conditionalWrite(
    recordRef: string,
    patch: Readonly<Record<string, Scalar>>,
    expectedVersion: string,
    ctx: { requestId: string },
  ): Promise<WriteResult>;
  /** Read-only reachability probe. */
  ping(): Promise<void>;
}

export function assertWritable(connector: CrmConnector): void {
  if (!connector.supportsAtomicConditionalWrite) {
    throw new AppError(
      "CONNECTOR_READ_ONLY",
      "connector does not support atomic conditional writes and is read-only in the MVP",
    );
  }
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read-only checks may retry (three attempts, exponential backoff). Only ever used for reads; the
 * mutation path never retries (PRD section 6).
 */
export async function readWithRetry(connector: CrmConnector, recordRef: string, opts: RetryOptions = {}): Promise<ConnectorRecord | null> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 100;
  const sleep = opts.sleep ?? realSleep;
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await connector.read(recordRef);
    } catch (err) {
      lastError = err;
      if (err instanceof ConnectorRejectedError) break;
      if (i < attempts - 1) await sleep(base * 2 ** i);
    }
  }
  throw lastError;
}
