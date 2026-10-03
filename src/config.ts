import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_ALLOWED_HOSTS, isLoopbackAddress } from "./connectors/outbound.js";
import { databaseHasData } from "./db/client.js";
import { DEFAULT_LIMITS } from "./domain/types.js";
import { KeyRing } from "./evidence/crypto.js";

export interface ServiceConfig {
  /** How long an approval stays valid before the worker invalidates it (approved -> planned). */
  approvalTtlMs: number;
  /** How long a compensation plan can be approved. */
  compensationPlanTtlMs: number;
  sessionTtlMs: number;
  /** Job lease duration; an expired lease is reclaimed by the next worker. */
  leaseMs: number;
  idempotencyRetentionMs: number;
  allowedHosts: readonly string[];
  maxImportBytes: number;
  maxImportFiles: number;
  /** Failed logins allowed per (ip,email) inside `loginWindowMs`. */
  loginMaxFailures: number;
  loginWindowMs: number;
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  approvalTtlMs: 15 * 60 * 1000,
  compensationPlanTtlMs: 30 * 60 * 1000,
  sessionTtlMs: 12 * 60 * 60 * 1000,
  leaseMs: 30 * 1000,
  idempotencyRetentionMs: DEFAULT_LIMITS.idempotencyRetentionDays * 24 * 60 * 60 * 1000,
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  maxImportBytes: DEFAULT_LIMITS.maxImportMetadataBytes,
  maxImportFiles: DEFAULT_LIMITS.maxImportFiles,
  loginMaxFailures: 10,
  loginWindowMs: 15 * 60 * 1000,
};

/**
 * Longest time a single connector call may take (read, ping or the whole conditional write): two such calls plus a
 * safety margin (a tenth of the lease) must fit inside the lease, so a healthy worker never loses it mid-call.
 */
export function connectorDeadlineMs(config: Pick<ServiceConfig, "leaseMs">): number {
  const margin = Math.max(1, Math.floor(config.leaseMs / 10));
  return Math.max(1, Math.floor((config.leaseMs - margin) / 2));
}

/**
 * After an attempt starts, a worker that lost its lease can still deliver a write for lease + one connector
 * deadline. Reconciliation may conclude "not applied" only after that quiet period.
 */
export function quietPeriodMs(config: Pick<ServiceConfig, "leaseMs">): number {
  return config.leaseMs + connectorDeadlineMs(config);
}

export type TrustProxy = false | number | string[];

/**
 * UNDOKIT_TRUST_PROXY: unset/0/false/off = no proxy; true/yes/on or `1` = one hop; a positive integer N = N hops;
 * anything else is a comma list of proxy addresses or CIDRs. Never "trust everything": the client-controlled
 * leftmost X-Forwarded-For entry is not used, only the entries added by the proxies you declare.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? "").trim();
  if (v === "" || /^(0|false|off|no)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) return 1;
  if (/^\d+$/.test(v)) return Number(v);
  const list = v.split(",").map((x) => x.trim());
  if (list.some((x) => x === "")) throw new Error("UNDOKIT_TRUST_PROXY must be 0, a hop count, or a comma list of proxy addresses/CIDRs");
  return list;
}

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  keyFile: string | undefined;
  keyBase64: string | undefined;
  cookieSecure: boolean;
  /**
   * Trust forwarded headers from a TLS-terminating reverse proxy (UNDOKIT_TRUST_PROXY). false = off (default); a number
   * = that many proxy hops in front of the server; a list = trusted proxy addresses/CIDRs.
   */
  trustProxy: TrustProxy;
  runWorker: boolean;
  workerPollMs: number;
  webRoot: string | undefined;
  service: ServiceConfig;
}

function num(env: Record<string, string | undefined>, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number of at least ${min}`);
  return n;
}

/** Smallest accepted worker lease and approval lifetime (seconds): shorter values make healthy workers lose jobs. */
export const MIN_LEASE_SECONDS = 5;
export const MIN_APPROVAL_TTL_SECONDS = 60;

/**
 * Environment contract (all optional):
 *   UNDOKIT_HOST (127.0.0.1)  UNDOKIT_PORT (8787)  UNDOKIT_DATABASE_URL (pglite://./.undokit/db)
 *   UNDOKIT_KEY_FILE or UNDOKIT_ENCRYPTION_KEY_FILE (./.undokit/undokit.key, created 0600 on first start)  UNDOKIT_ENCRYPTION_KEY (base64, 32 bytes)
 *   UNDOKIT_ALLOWED_HOSTS (comma list; default loopback)  UNDOKIT_COOKIE_SECURE (1|0; default: on unless loopback host)
 *   UNDOKIT_TRUST_PROXY (hop count or proxy address/CIDR list; 1 = one proxy hop; default 0)  UNDOKIT_WORKER (1|0; default 1)  UNDOKIT_WORKER_POLL_MS (500)  UNDOKIT_WEB_ROOT (dist/web)
 *   UNDOKIT_APPROVAL_TTL_SECONDS (900)  UNDOKIT_LEASE_SECONDS (30)
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const host = env["UNDOKIT_HOST"] ?? "127.0.0.1";
  const hostIsLoopback = host === "localhost" || isLoopbackAddress(host);
  const cookieSecure = env["UNDOKIT_COOKIE_SECURE"] !== undefined ? env["UNDOKIT_COOKIE_SECURE"] === "1" : !hostIsLoopback;
  const allowed = env["UNDOKIT_ALLOWED_HOSTS"];
  return {
    host,
    port: num(env, "UNDOKIT_PORT", 8787),
    databaseUrl: env["UNDOKIT_DATABASE_URL"] ?? "pglite://./.undokit/db",
    keyFile: env["UNDOKIT_KEY_FILE"] ?? env["UNDOKIT_ENCRYPTION_KEY_FILE"],
    keyBase64: env["UNDOKIT_ENCRYPTION_KEY"],
    cookieSecure,
    trustProxy: parseTrustProxy(env["UNDOKIT_TRUST_PROXY"]),
    runWorker: env["UNDOKIT_WORKER"] !== "0",
    workerPollMs: num(env, "UNDOKIT_WORKER_POLL_MS", 500, 10),
    webRoot: env["UNDOKIT_WEB_ROOT"],
    service: {
      ...DEFAULT_SERVICE_CONFIG,
      approvalTtlMs: num(env, "UNDOKIT_APPROVAL_TTL_SECONDS", DEFAULT_SERVICE_CONFIG.approvalTtlMs / 1000, MIN_APPROVAL_TTL_SECONDS) * 1000,
      leaseMs: num(env, "UNDOKIT_LEASE_SECONDS", DEFAULT_SERVICE_CONFIG.leaseMs / 1000, MIN_LEASE_SECONDS) * 1000,
      allowedHosts: allowed ? allowed.split(",").map((h) => h.trim()).filter(Boolean) : DEFAULT_ALLOWED_HOSTS,
    },
  };
}

/**
 * Like resolveKeyRing, but a missing key file is only minted for a brand-new empty database. If the database
 * already holds data, a new key would make every stored value unreadable (and encrypt new rows under a different
 * key), so it refuses with an actionable error instead.
 */
export async function resolveKeyRingChecked(config: Pick<ServerConfig, "keyBase64" | "keyFile" | "databaseUrl">, opts: { create?: boolean } = {}): Promise<KeyRing> {
  if (!config.keyBase64) {
    const path = resolve(config.keyFile ?? "./.undokit/undokit.key");
    if (!existsSync(path) && opts.create !== false && (await databaseHasData(config.databaseUrl))) {
      throw new Error(
        `encryption key file not found at ${path}, but the database already contains data. Restore the original key file (or set UNDOKIT_ENCRYPTION_KEY); starting with a new key would make existing data unreadable.`,
      );
    }
  }
  return resolveKeyRing(config, opts);
}

/**
 * Resolve the operator-managed encryption key: explicit base64 env value, else a key file. When the
 * file does not exist it is created owner-only (0600) so a first run works; back it up separately
 * from the database, because the database cannot be decrypted without it.
 */
export function resolveKeyRing(config: Pick<ServerConfig, "keyBase64" | "keyFile">, opts: { create?: boolean } = {}): KeyRing {
  if (config.keyBase64) return KeyRing.fromBase64(config.keyBase64);
  const path = resolve(config.keyFile ?? "./.undokit/undokit.key");
  if (!existsSync(path)) {
    if (opts.create === false) throw new Error(`encryption key file not found: ${path}`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    KeyRing.writeNewKeyFile(path);
  }
  return KeyRing.fromFile(path);
}
