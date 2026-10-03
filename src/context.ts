import { connectorDeadlineMs, DEFAULT_SERVICE_CONFIG, type ServiceConfig } from "./config.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { openDatabase, type Db } from "./db/client.js";
import { checkSchema, runMigrations, type MigrationStatus } from "./db/migrate.js";
import { systemClock, randomIds, type Clock, type IdGenerator } from "./domain/clock.js";
import { FaultInjector } from "./domain/faults.js";
import { SecretRegistry } from "./domain/redact.js";
import type { KeyRing } from "./evidence/crypto.js";
import { LoginRateLimiter } from "./services/ratelimit.js";

export interface UndoKitOptions {
  /** `memory://`, `pglite://<dir>` or `postgres://...`. Ignored when `db` is given. */
  databaseUrl?: string;
  db?: Db;
  keyring: KeyRing;
  clock?: Clock;
  ids?: IdGenerator;
  faults?: FaultInjector;
  /** Override the migrations directory (tests use a broken one to prove AC-13). */
  migrationsDir?: string;
  config?: Partial<ServiceConfig>;
  /** HTTP client for the CouchDB connector (tests inject faults here). */
  fetch?: typeof fetch;
  /** Skip running migrations (readiness is then only checked, never changed). */
  skipMigrations?: boolean;
}

export interface Readiness {
  ok: boolean;
  error?: string;
  status: MigrationStatus;
}

export interface UndoKit {
  db: Db;
  keyring: KeyRing;
  clock: Clock;
  ids: IdGenerator;
  faults: FaultInjector;
  secrets: SecretRegistry;
  connectors: ConnectorRegistry;
  config: ServiceConfig;
  loginLimiter: LoginRateLimiter;
  migrationsDir: string | undefined;
  /** Mutable: set once at startup from the migration result and refreshed by `refreshReadiness`. */
  readiness: Readiness;
  fetch: typeof fetch | undefined;
  refreshReadiness(): Promise<Readiness>;
  close(): Promise<void>;
}

function toReadiness(status: MigrationStatus): Readiness {
  return status.error === undefined ? { ok: status.ok, status } : { ok: status.ok, error: status.error, status };
}

export async function createUndoKit(options: UndoKitOptions): Promise<UndoKit> {
  const db = options.db ?? (await openDatabase(options.databaseUrl ?? "memory://"));
  const clock = options.clock ?? systemClock;
  const config: ServiceConfig = { ...DEFAULT_SERVICE_CONFIG, ...options.config };
  const secrets = new SecretRegistry();
  const migrateOpts = options.migrationsDir === undefined ? { now: () => clock.now() } : { dir: options.migrationsDir, now: () => clock.now() };
  const status = options.skipMigrations ? await checkSchema(db, migrateOpts) : await runMigrations(db, migrateOpts);
  const kit: UndoKit = {
    db,
    keyring: options.keyring,
    clock,
    ids: options.ids ?? randomIds,
    faults: options.faults ?? new FaultInjector(),
    secrets,
    connectors: new ConnectorRegistry(options.keyring, secrets, config.allowedHosts, options.fetch, connectorDeadlineMs(config)),
    config,
    loginLimiter: new LoginRateLimiter(clock, config.loginMaxFailures, config.loginWindowMs),
    migrationsDir: options.migrationsDir,
    readiness: toReadiness(status),
    fetch: options.fetch,
    async refreshReadiness() {
      kit.readiness = toReadiness(await checkSchema(db, kit.migrationsDir === undefined ? {} : { dir: kit.migrationsDir }));
      return kit.readiness;
    },
    async close() {
      await db.close();
    },
  };
  return kit;
}
