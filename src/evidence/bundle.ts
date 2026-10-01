import type { UndoKit } from "../context.js";
import { canonicalJson, contentHash } from "../domain/canonical.js";
import { AppError, type ErrorDetail } from "../domain/errors.js";
import { redactDeep } from "../domain/redact.js";
import {
  BUNDLE_KIND,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  SCHEMA_VERSION,
  evidenceBundleSchema,
  exportRequestSchema,
  operationEvidenceDocSchema,
  type EvidenceBundle,
  type ImportResult,
  type OperationEvidenceDoc,
} from "../domain/types.js";
import { createSystemWorkspace, findSystemWorkspace } from "../services/auth.js";
import { assertReady, assertUuid, isUniqueViolation, parseBody, requireRole, type Actor } from "../services/common.js";
import { buildOperationView } from "../services/views.js";
import { listEvents, verifyEventChain } from "./events.js";
import { clampLimit, encodeCursor, type Page } from "../services/operations.js";

function bundleHeaderHash(b: Pick<EvidenceBundle, "schema_version" | "kind" | "bundle_id" | "created_at" | "workspace_id" | "generator" | "redacted" | "manifest">): string {
  return contentHash({
    schema_version: b.schema_version,
    kind: b.kind,
    bundle_id: b.bundle_id,
    created_at: b.created_at,
    workspace_id: b.workspace_id,
    generator: b.generator,
    redacted: b.redacted,
    manifest: b.manifest,
  });
}

/* ---------- export ---------- */

export async function exportBundle(kit: UndoKit, actor: Actor, body: unknown = {}): Promise<EvidenceBundle> {
  requireRole(actor, "operator");
  assertReady(kit);
  const req = parseBody(exportRequestSchema, body ?? {});
  let ids: string[];
  if (req.operation_ids) {
    ids = [...new Set(req.operation_ids.map((x) => x.toLowerCase()))];
    for (const id of ids) assertUuid(id, "operation");
  } else {
    const res = await kit.db.query<{ id: string }>("SELECT id FROM operations WHERE workspace_id = $1::uuid ORDER BY created_at, id LIMIT $2", [actor.workspace_id, kit.config.maxImportFiles + 1]);
    if (res.rows.length > kit.config.maxImportFiles) {
      throw new AppError("PAYLOAD_TOO_LARGE", `more than ${kit.config.maxImportFiles} operations; export a subset with operation_ids`);
    }
    ids = res.rows.map((r) => r.id);
  }
  if (ids.length > kit.config.maxImportFiles) throw new AppError("PAYLOAD_TOO_LARGE", `at most ${kit.config.maxImportFiles} operations per bundle`);

  const files: Record<string, OperationEvidenceDoc> = {};
  const manifestFiles: { path: string; sha256: string; bytes: number }[] = [];
  for (const id of ids) {
    const view = await buildOperationView(kit, kit.db, actor.workspace_id, id, "export");
    const events = await listEvents(kit.db, id);
    const doc = operationEvidenceDocSchema.parse({
      schema_version: SCHEMA_VERSION,
      kind: "operation-evidence",
      operation: redactDeep(view, kit.secrets),
      events,
    });
    const path = `operations/${view.id}.json`;
    files[path] = doc;
    manifestFiles.push({ path, sha256: contentHash(doc), bytes: Buffer.byteLength(canonicalJson(doc)) });
  }
  manifestFiles.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    files: manifestFiles,
    file_count: manifestFiles.length,
    total_bytes: manifestFiles.reduce((n, f) => n + f.bytes, 0),
  };
  const head = {
    schema_version: SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    bundle_id: kit.ids.next(),
    created_at: kit.clock.now().toISOString(),
    workspace_id: actor.workspace_id,
    generator: { name: PRODUCT_NAME, version: PRODUCT_VERSION } as const,
    redacted: true as const,
    manifest,
  };
  const sortedFiles = Object.fromEntries(manifestFiles.map((f) => [f.path, files[f.path] as OperationEvidenceDoc]));
  // `complete` is the last key so a truncated file can never contain it.
  return evidenceBundleSchema.parse({ ...head, bundle_hash: bundleHeaderHash(head), files: sortedFiles, complete: true });
}

/* ---------- verify (pure: no database, no network) ---------- */

export interface VerifyLimits {
  maxBytes?: number;
  maxFiles?: number;
}

export function verifyBundleText(text: string, limits: VerifyLimits = {}): EvidenceBundle {
  const maxBytes = limits.maxBytes ?? 25 * 1024 * 1024;
  const maxFiles = limits.maxFiles ?? 1000;
  if (Buffer.byteLength(text) > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "bundle exceeds the import size limit");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError("BUNDLE_MALFORMED", "bundle is not valid JSON (it may be truncated)");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("BUNDLE_MALFORMED", "bundle must be a JSON object");
  const head = raw as Record<string, unknown>;
  if (head["kind"] !== BUNDLE_KIND) throw new AppError("BUNDLE_UNSUPPORTED", "not an UndoKit evidence bundle");
  if (head["schema_version"] !== SCHEMA_VERSION) throw new AppError("BUNDLE_UNSUPPORTED", `unsupported bundle schema_version (supported: ${SCHEMA_VERSION})`);
  if (head["complete"] !== true) throw new AppError("BUNDLE_MALFORMED", "bundle is incomplete (missing completion marker)");
  const parsed = evidenceBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const details: ErrorDetail[] = parsed.error.issues.slice(0, 10).map((i) => ({ code: "INVALID", field: i.path.join(".").slice(0, 128), message: i.message.slice(0, 200) }));
    throw new AppError("BUNDLE_MALFORMED", "bundle does not match the schema", details);
  }
  const bundle = parsed.data;
  if (bundle.manifest.files.length > maxFiles || Object.keys(bundle.files).length > maxFiles) throw new AppError("PAYLOAD_TOO_LARGE", `bundle has more than ${maxFiles} files`);

  try {
    return checkIntegrity(bundle);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("BUNDLE_MALFORMED", "bundle contains values that cannot be verified");
  }
}

function checkIntegrity(bundle: EvidenceBundle): EvidenceBundle {
  const problems: ErrorDetail[] = [];
  const manifestPaths = new Set(bundle.manifest.files.map((f) => f.path));
  if (manifestPaths.size !== bundle.manifest.files.length) problems.push({ code: "DUPLICATE_PATH", message: "manifest lists a path twice" });
  if (bundle.manifest.file_count !== bundle.manifest.files.length) problems.push({ code: "COUNT_MISMATCH", message: "manifest file_count does not match its file list" });
  const total = bundle.manifest.files.reduce((n, f) => n + f.bytes, 0);
  if (bundle.manifest.total_bytes !== total) problems.push({ code: "BYTES_MISMATCH", message: "manifest total_bytes does not match its file list" });
  for (const key of Object.keys(bundle.files)) {
    if (!manifestPaths.has(key)) problems.push({ code: "UNLISTED_FILE", field: key.slice(0, 128), message: "file is not in the manifest" });
  }
  for (const entry of bundle.manifest.files) {
    const doc = bundle.files[entry.path];
    if (!doc) {
      problems.push({ code: "MISSING_FILE", field: entry.path, message: "manifest file is absent from the bundle" });
      continue;
    }
    if (contentHash(doc) !== entry.sha256) problems.push({ code: "HASH_MISMATCH", field: entry.path, message: "file content does not match its manifest hash" });
    if (Buffer.byteLength(canonicalJson(doc)) !== entry.bytes) problems.push({ code: "SIZE_MISMATCH", field: entry.path, message: "file size does not match its manifest entry" });
    if (!entry.path.toLowerCase().endsWith(`${doc.operation.id.toLowerCase()}.json`)) problems.push({ code: "PATH_ID_MISMATCH", field: entry.path, message: "file path does not match its operation id" });
    const broken = verifyEventChain(doc.operation.id, doc.events);
    if (broken !== null) problems.push({ code: "CHAIN_BROKEN", field: entry.path, message: `evidence event chain breaks at sequence ${broken}` });
  }
  if (bundleHeaderHash(bundle) !== bundle.bundle_hash) problems.push({ code: "BUNDLE_HASH_MISMATCH", message: "bundle_hash does not match the bundle header and manifest" });
  if (problems.length > 0) throw new AppError("BUNDLE_INTEGRITY_FAILED", `bundle failed integrity verification (${problems.length} problem(s))`, problems.slice(0, 50));
  return bundle;
}

/* ---------- import ---------- */

export async function importBundle(kit: UndoKit, actor: Actor, text: string): Promise<ImportResult> {
  requireRole(actor, "operator");
  assertReady(kit);
  // Everything is verified before any state is written; a failure leaves the database untouched.
  const bundle = verifyBundleText(text, { maxBytes: kit.config.maxImportBytes, maxFiles: kit.config.maxImportFiles });
  const existing = await kit.db.query<{ id: string; bundle_hash: string; file_count: number; total_bytes: number; imported_at: string }>(
    "SELECT id, bundle_hash, file_count, total_bytes, imported_at FROM evidence_imports WHERE workspace_id = $1::uuid AND bundle_id = $2::uuid",
    [actor.workspace_id, bundle.bundle_id],
  );
  const found = existing.rows[0];
  const result = (row: { id: string; file_count: number; total_bytes: number; imported_at: string }, replayed: boolean): ImportResult => ({
    import_id: row.id,
    bundle_id: bundle.bundle_id,
    bundle_hash: bundle.bundle_hash,
    file_count: row.file_count,
    total_bytes: row.total_bytes,
    imported_at: row.imported_at,
    replayed,
  });
  if (found) {
    if (found.bundle_hash !== bundle.bundle_hash) throw new AppError("DUPLICATE_RESOURCE", "a different bundle with this bundle_id was already imported");
    return result(found, true);
  }
  const id = kit.ids.next();
  const now = kit.clock.now().toISOString();
  try {
    await kit.db.query(
      `INSERT INTO evidence_imports (id, workspace_id, bundle_id, bundle_hash, schema_version, file_count, total_bytes, content, imported_by, imported_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz)`,
      [id, actor.workspace_id, bundle.bundle_id, bundle.bundle_hash, bundle.schema_version, bundle.manifest.file_count, bundle.manifest.total_bytes, JSON.stringify(bundle), actor.user_id, now],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await kit.db.query<{ id: string; bundle_hash: string; file_count: number; total_bytes: number; imported_at: string }>(
        "SELECT id, bundle_hash, file_count, total_bytes, imported_at FROM evidence_imports WHERE workspace_id = $1::uuid AND bundle_id = $2::uuid",
        [actor.workspace_id, bundle.bundle_id],
      );
      const row = again.rows[0];
      if (row) {
        if (row.bundle_hash !== bundle.bundle_hash) throw new AppError("DUPLICATE_RESOURCE", "a different bundle with this bundle_id was already imported");
        return result(row, true);
      }
    }
    throw err;
  }
  return result({ id, file_count: bundle.manifest.file_count, total_bytes: bundle.manifest.total_bytes, imported_at: now }, false);
}

export interface ImportSummary {
  import_id: string;
  bundle_id: string;
  bundle_hash: string;
  file_count: number;
  total_bytes: number;
  imported_at: string;
}

export async function listImports(kit: UndoKit, actor: Actor, opts: { limit?: number; cursor?: string | undefined } = {}): Promise<Page<ImportSummary>> {
  const limit = clampLimit(opts.limit);
  let at: string | null = null;
  let cid = "00000000-0000-0000-0000-000000000000";
  if (opts.cursor) {
    const [a, i] = Buffer.from(opts.cursor, "base64url").toString("utf8").split("|");
    if (!a || !i || Number.isNaN(Date.parse(a)) || !/^[0-9a-fA-F-]{36}$/.test(i)) throw new AppError("MALFORMED_REQUEST", "invalid cursor");
    at = a;
    cid = i;
  }
  const res = await kit.db.query<{ id: string; bundle_id: string; bundle_hash: string; file_count: number; total_bytes: number; imported_at: string }>(
    `SELECT id, bundle_id, bundle_hash, file_count, total_bytes, imported_at FROM evidence_imports
      WHERE workspace_id = $1::uuid AND ($2::timestamptz IS NULL OR (imported_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY imported_at DESC, id DESC LIMIT $4`,
    [actor.workspace_id, at, cid, limit + 1],
  );
  const rows = res.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((r) => ({ import_id: r.id, bundle_id: r.bundle_id, bundle_hash: r.bundle_hash, file_count: r.file_count, total_bytes: r.total_bytes, imported_at: r.imported_at })),
    next_cursor: res.rows.length > limit && last ? encodeCursor(last.imported_at, last.id) : null,
  };
}

export async function getImport(kit: UndoKit, actor: Actor, id: string): Promise<EvidenceBundle> {
  assertUuid(id, "import");
  const res = await kit.db.query<{ content: EvidenceBundle }>("SELECT content FROM evidence_imports WHERE id = $1::uuid AND workspace_id = $2::uuid", [id, actor.workspace_id]);
  const row = res.rows[0];
  if (!row) throw new AppError("NOT_FOUND", "import not found");
  return row.content;
}

/**
 * Import into a clean installation: verifies the bundle first (a bad bundle creates nothing), then creates (or
 * reuses) a workspace owned by a non-loginable system actor and imports into it. The system actor does not count
 * as "already bootstrapped", and a later `bootstrapAdmin` joins this workspace so the evidence stays visible.
 */
export async function importBundleIntoCleanInstall(kit: UndoKit, text: string, opts: { workspace_name?: string } = {}): Promise<ImportResult & { workspace_id: string }> {
  assertReady(kit);
  verifyBundleText(text, { maxBytes: kit.config.maxImportBytes, maxFiles: kit.config.maxImportFiles });
  let system = await findSystemWorkspace(kit);
  if (!system) {
    const loginable = await kit.db.query<{ n: number }>("SELECT (SELECT count(*) FROM users WHERE password_hash <> '!')::int + (SELECT count(*) FROM workspaces)::int AS n");
    if ((loginable.rows[0]?.n ?? 0) > 0) throw new AppError("INVALID_STATE", "this installation is not clean; sign in and import into your workspace instead");
    system = await createSystemWorkspace(kit, opts.workspace_name ?? "Imported evidence");
  }
  const actor: Actor = { user_id: system.user_id, workspace_id: system.workspace_id, role: "operator" };
  const result = await importBundle(kit, actor, text);
  return { ...result, workspace_id: system.workspace_id };
}
