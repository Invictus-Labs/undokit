import { AppError } from "../domain/errors.js";
import { SecretRegistry } from "../domain/redact.js";
import type { KeyRing } from "../evidence/crypto.js";
import type { Envelope } from "../evidence/crypto.js";
import type { Scalar } from "../domain/types.js";
import { CouchdbConnector } from "./couchdb.js";
import type { CrmConnector } from "./crm.js";
import { SimulatorConnector } from "./simulator.js";

export interface ConnectorRow {
  id: string;
  workspace_id: string;
  kind: string;
  config: Record<string, unknown>;
  credentials_enc: Envelope | null;
}

/**
 * Process-local cache of live connector instances keyed by connector id. Simulators keep their
 * state in memory (re-seeded from config when the process starts); tests can register a custom
 * instance with `register` to inject faults.
 */
export class ConnectorRegistry {
  private readonly instances = new Map<string, CrmConnector>();

  constructor(
    private readonly keyring: KeyRing,
    private readonly secrets: SecretRegistry,
    private readonly allowedHosts: readonly string[],
    private readonly fetchImpl: typeof fetch | undefined,
    /** Upper bound for a connector's per-call deadline (half the worker lease); larger stored values are clamped. */
    private readonly maxTimeoutMs: number = Number.POSITIVE_INFINITY,
  ) {}

  register(connectorId: string, connector: CrmConnector): void {
    this.instances.set(connectorId, connector);
  }

  forget(connectorId: string): void {
    this.instances.delete(connectorId);
  }

  get(row: ConnectorRow): CrmConnector {
    const cached = this.instances.get(row.id);
    if (cached) return cached;
    const built = this.build(row);
    this.instances.set(row.id, built);
    return built;
  }

  /** The in-process simulator for a connector id (throws if the connector is not a simulator). */
  simulator(connectorId: string): SimulatorConnector {
    const instance = this.instances.get(connectorId);
    if (!(instance instanceof SimulatorConnector)) {
      throw new Error(`connector ${connectorId} is not a loaded simulator`);
    }
    return instance;
  }

  private build(row: ConnectorRow): CrmConnector {
    if (row.kind === "simulator") {
      const seed = (row.config["seed_records"] as { record_ref: string; fields: Record<string, Scalar> }[] | undefined) ?? [];
      const atomic = row.config["supports_atomic_conditional_write"];
      return new SimulatorConnector({ seed, supportsAtomicConditionalWrite: atomic === false ? false : true });
    }
    if (row.kind === "couchdb") {
      if (!row.credentials_enc) throw new AppError("INTERNAL_ERROR", "connector credentials are missing");
      const credentials = this.keyring.decryptJson<{ username: string; password: string }>("connector-credentials", row.credentials_enc, `connector:${row.id}`);
      this.secrets.add(credentials.password);
      this.secrets.add(credentials.username);
      return new CouchdbConnector({
        baseUrl: String(row.config["base_url"]),
        database: String(row.config["database"]),
        timeoutMs: Math.min(Number(row.config["timeout_ms"] ?? 10000), this.maxTimeoutMs),
        credentials,
        allowedHosts: this.allowedHosts,
        fetchImpl: this.fetchImpl,
      });
    }
    throw new AppError("INTERNAL_ERROR", `unsupported connector kind ${row.kind}`);
  }
}
