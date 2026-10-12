import { connectorDeadlineMs } from "../config.js";
import { assertOutboundAllowed } from "../connectors/outbound.js";
import type { ConnectorRow } from "../connectors/registry.js";
import type { UndoKit } from "../context.js";
import { AppError } from "../domain/errors.js";
import {
  connectorPolicySchema,
  createConnectorRequestSchema,
  type ConnectorKind,
  type ConnectorPolicy,
  type ConnectorView,
} from "../domain/types.js";
import type { Envelope } from "../evidence/crypto.js";
import { assertReady, assertUuid, isUniqueViolation, parseBody, requireRole, type Actor } from "./common.js";

export interface ConnectorDbRow extends ConnectorRow {
  name: string;
  policy: unknown;
  supports_atomic_conditional_write: boolean;
  disabled_at: string | null;
  created_at: string;
}

export function connectorToView(kit: UndoKit, row: ConnectorDbRow): ConnectorView {
  const instance = kit.connectors.get(row);
  const supports = instance.supportsAtomicConditionalWrite;
  // Credentials and seed records are never part of a view.
  const config: Record<string, unknown> =
    row.kind === "couchdb"
      ? { base_url: row.config["base_url"], database: row.config["database"], timeout_ms: row.config["timeout_ms"] }
      : { supports_atomic_conditional_write: row.config["supports_atomic_conditional_write"] ?? true, seed_record_count: ((row.config["seed_records"] as unknown[] | undefined) ?? []).length };
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    kind: row.kind as ConnectorKind,
    live: instance.live,
    label: instance.label,
    supports_atomic_conditional_write: supports,
    read_only: !supports,
    policy: connectorPolicySchema.parse(row.policy),
    config,
    disabled: row.disabled_at !== null,
    created_at: row.created_at,
  };
}

export async function loadConnectorRow(kit: UndoKit, workspaceId: string, id: string): Promise<ConnectorDbRow> {
  assertUuid(id, "connector");
  const res = await kit.db.query<ConnectorDbRow>("SELECT * FROM connectors WHERE id = $1::uuid AND workspace_id = $2::uuid", [id, workspaceId]);
  const row = res.rows[0];
  if (!row) throw new AppError("NOT_FOUND", "connector not found");
  return row;
}

export async function createConnector(kit: UndoKit, actor: Actor, body: unknown): Promise<ConnectorView> {
  requireRole(actor, "admin");
  assertReady(kit);
  const req = parseBody(createConnectorRequestSchema, body);
  const policy: ConnectorPolicy = req.policy;
  const names = new Set<string>();
  for (const f of policy.allowed_fields) {
    if (names.has(f.name)) throw new AppError("VALIDATION_FAILED", "duplicate field in allowlist", [{ code: "DUPLICATE_FIELD", field: f.name, message: "field listed twice" }]);
    names.add(f.name);
  }
  const id = kit.ids.next();
  let config: Record<string, unknown>;
  let credentialsEnc: Envelope | null = null;
  if (req.kind === "couchdb") {
    // A connector call must finish well inside the worker lease, or a second worker could reclaim the job while
    // the first worker's write is still in flight.
    const maxTimeout = connectorDeadlineMs(kit.config);
    if (req.config.timeout_ms > maxTimeout) {
      throw new AppError("VALIDATION_FAILED", `timeout_ms must be at most ${maxTimeout} (two calls plus a margin must fit in the ${kit.config.leaseMs} ms worker lease); lower it or raise UNDOKIT_LEASE_SECONDS`, [
        { code: "CONNECTOR_TIMEOUT_TOO_LONG", field: "timeout_ms", message: `maximum ${maxTimeout} ms` },
      ]);
    }
    await assertOutboundAllowed(req.config.base_url, kit.config.allowedHosts);
    config = { ...req.config };
    credentialsEnc = kit.keyring.encryptJson("connector-credentials", req.credentials, `connector:${id}`);
    kit.secrets.add(req.credentials.password);
    kit.secrets.add(req.credentials.username);
  } else {
    config = { ...req.config };
  }
  const row: ConnectorDbRow = {
    id,
    workspace_id: actor.workspace_id,
    kind: req.kind,
    config,
    credentials_enc: credentialsEnc,
    name: req.name,
    policy,
    supports_atomic_conditional_write: true,
    disabled_at: null,
    created_at: kit.clock.now().toISOString(),
  };
  const instance = kit.connectors.get(row);
  row.supports_atomic_conditional_write = instance.supportsAtomicConditionalWrite;
  try {
    await kit.db.query(
      `INSERT INTO connectors (id, workspace_id, name, kind, policy, config, credentials_enc, supports_atomic_conditional_write, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::timestamptz)`,
      [
        id,
        actor.workspace_id,
        req.name,
        req.kind,
        JSON.stringify(policy),
        JSON.stringify(config),
        credentialsEnc ? JSON.stringify(credentialsEnc) : null,
        row.supports_atomic_conditional_write,
        actor.user_id,
        row.created_at,
      ],
    );
  } catch (err) {
    kit.connectors.forget(id);
    if (isUniqueViolation(err)) throw new AppError("DUPLICATE_RESOURCE", "a connector with this name already exists");
    throw err;
  }
  return connectorToView(kit, row);
}

export async function listConnectors(kit: UndoKit, actor: Actor): Promise<ConnectorView[]> {
  const res = await kit.db.query<ConnectorDbRow>("SELECT * FROM connectors WHERE workspace_id = $1::uuid ORDER BY created_at, id", [actor.workspace_id]);
  return res.rows.map((r) => connectorToView(kit, r));
}

export async function getConnector(kit: UndoKit, actor: Actor, id: string): Promise<ConnectorView> {
  return connectorToView(kit, await loadConnectorRow(kit, actor.workspace_id, id));
}

/** Read-only reachability probe. */
export async function checkConnector(kit: UndoKit, actor: Actor, id: string): Promise<{ ok: true; live: boolean; label: string }> {
  requireRole(actor, "admin");
  const row = await loadConnectorRow(kit, actor.workspace_id, id);
  const instance = kit.connectors.get(row);
  try {
    await instance.ping();
  } catch {
    throw new AppError("CONNECTOR_UNAVAILABLE", "connector is not reachable");
  }
  return { ok: true, live: instance.live, label: instance.label };
}
