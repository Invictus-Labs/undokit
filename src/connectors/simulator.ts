import type { Scalar } from "../domain/types.js";
import {
  ConnectorAmbiguousError,
  ConnectorUnavailableError,
  type ConnectorRecord,
  type CrmConnector,
  type WriteResult,
} from "./crm.js";

export type SimulatorFault = "ambiguous_after_commit" | "ambiguous_before_commit" | "unavailable";

export const SIMULATOR_LABEL = "SIMULATOR (deterministic in-process stand-in; not a live provider)";

interface SimRecord {
  version: number;
  fields: Record<string, Scalar>;
}

/**
 * Deterministic in-process CRM stand-in for the synthetic demo and unit/integration tests.
 * It is NEVER live: `live` is false and the label says so everywhere it is displayed.
 *
 * conditionalWrite checks the version and applies the patch in one synchronous block (no await
 * between check and set), which is the in-process analogue of a provider-side atomic CAS.
 */
export class SimulatorConnector implements CrmConnector {
  readonly kind = "simulator" as const;
  readonly live = false;
  readonly label = SIMULATOR_LABEL;
  readonly supportsAtomicConditionalWrite: boolean;
  private readonly records = new Map<string, SimRecord>();
  private readonly faults: SimulatorFault[] = [];
  /** Call counters so tests can prove a mutation is never blindly repeated. */
  readonly calls = { read: 0, write: 0, writeApplied: 0, ping: 0 };

  constructor(opts: { supportsAtomicConditionalWrite?: boolean; seed?: { record_ref: string; fields: Record<string, Scalar> }[] } = {}) {
    this.supportsAtomicConditionalWrite = opts.supportsAtomicConditionalWrite ?? true;
    for (const rec of opts.seed ?? []) this.seed(rec.record_ref, rec.fields);
  }

  static versionToken(n: number): string {
    return `sim-v${n}`;
  }

  /** Create or replace a record at version 1. */
  seed(recordRef: string, fields: Record<string, Scalar>): string {
    this.records.set(recordRef, { version: 1, fields: { ...fields } });
    return SimulatorConnector.versionToken(1);
  }

  /** Planted intervening edit by "someone else": changes fields and advances the version. */
  externalEdit(recordRef: string, patch: Record<string, Scalar>): string {
    const rec = this.records.get(recordRef);
    if (!rec) throw new Error(`simulator: unknown record ${recordRef}`);
    Object.assign(rec.fields, patch);
    rec.version += 1;
    return SimulatorConnector.versionToken(rec.version);
  }

  /** Queue a fault for the next conditionalWrite call. */
  failNextWrite(fault: SimulatorFault): void {
    this.faults.push(fault);
  }

  snapshot(recordRef: string): ConnectorRecord | null {
    const rec = this.records.get(recordRef);
    return rec ? { record_ref: recordRef, version: SimulatorConnector.versionToken(rec.version), fields: { ...rec.fields } } : null;
  }

  async read(recordRef: string): Promise<ConnectorRecord | null> {
    this.calls.read += 1;
    return this.snapshot(recordRef);
  }

  async ping(): Promise<void> {
    this.calls.ping += 1;
  }

  async conditionalWrite(
    recordRef: string,
    patch: Readonly<Record<string, Scalar>>,
    expectedVersion: string,
    ctx: { requestId: string },
  ): Promise<WriteResult> {
    if (!this.supportsAtomicConditionalWrite) {
      throw new Error("simulator configured without atomic conditional writes must never be written");
    }
    this.calls.write += 1;
    const fault = this.faults.shift();
    if (fault === "unavailable") throw new ConnectorUnavailableError("simulator: connection refused");
    if (fault === "ambiguous_before_commit") throw new ConnectorAmbiguousError("simulator: request timed out before commit");
    const requestId = `sim-${ctx.requestId}`;
    const rec = this.records.get(recordRef);
    if (!rec) throw new ConnectorUnavailableError("simulator: record not found");
    // ---- atomic section: no await between the precondition check and the write ----
    if (SimulatorConnector.versionToken(rec.version) !== expectedVersion) {
      return { outcome: "conflict", current_version: SimulatorConnector.versionToken(rec.version), provider_request_id: requestId };
    }
    Object.assign(rec.fields, patch);
    rec.version += 1;
    this.calls.writeApplied += 1;
    // ---- end atomic section ----
    if (fault === "ambiguous_after_commit") {
      throw new ConnectorAmbiguousError("simulator: response lost after commit");
    }
    return { outcome: "written", new_version: SimulatorConnector.versionToken(rec.version), provider_request_id: requestId };
  }
}
