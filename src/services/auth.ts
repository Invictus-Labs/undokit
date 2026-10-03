import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { UndoKit } from "../context.js";
import { AppError } from "../domain/errors.js";
import {
  createMemberRequestSchema,
  loginRequestSchema,
  type MemberView,
  type Role,
  type SessionListItem,
  type SessionView,
} from "../domain/types.js";
import { addMs, assertReady, assertUuid, isUniqueViolation, parseBody, requireRole, type Actor } from "./common.js";

/* ---------- password hashing (scrypt) ---------- */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  try {
    const expected = Buffer.from(hash, "base64");
    const actual = await scryptAsync(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Hash verified against a login for an unknown user so response time does not reveal account existence. */
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  return dummyHash;
}

export function sha256Token(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validatePasswordPolicy(password: string): void {
  if (password.length < 12) throw new AppError("VALIDATION_FAILED", "password must be at least 12 characters", [{ code: "PASSWORD_TOO_SHORT", field: "password", message: "minimum 12 characters" }]);
}

/* ---------- workspace and member management ---------- */

export interface WorkspaceBootstrap {
  email: string;
  password: string;
  workspace_name: string;
  display_name?: string;
}

/**
 * Library-only (never an HTTP route): create a workspace with its first admin. There is no default
 * credential anywhere; the caller supplies the password.
 */
export async function createWorkspaceWithAdmin(kit: UndoKit, input: WorkspaceBootstrap): Promise<{ workspace_id: string; user_id: string }> {
  assertReady(kit);
  validatePasswordPolicy(input.password);
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new AppError("VALIDATION_FAILED", "invalid email");
  const name = input.workspace_name.trim();
  if (name.length < 1 || name.length > 128) throw new AppError("VALIDATION_FAILED", "workspace_name must be 1-128 characters");
  const passwordHash = await hashPassword(input.password);
  const now = kit.clock.now().toISOString();
  const workspaceId = kit.ids.next();
  const userId = kit.ids.next();
  try {
    await kit.db.transaction(async (tx) => {
      await tx.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3::timestamptz)", [workspaceId, name, now]);
      await tx.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)", [
        userId,
        email,
        input.display_name ?? null,
        passwordHash,
        now,
      ]);
      await tx.query("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'admin', $3::timestamptz)", [workspaceId, userId, now]);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("DUPLICATE_RESOURCE", "email is already registered");
    throw err;
  }
  return { workspace_id: workspaceId, user_id: userId };
}

/** Marker password hash of the non-loginable system actor; verifyPassword never accepts it. */
export const SYSTEM_PASSWORD_HASH = "!";

/** A workspace created by a clean-install import, with its non-loginable system actor. */
export async function findSystemWorkspace(kit: UndoKit): Promise<{ workspace_id: string; user_id: string } | null> {
  const res = await kit.db.query<{ workspace_id: string; user_id: string }>(
    `SELECT m.workspace_id, m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE u.password_hash = $1 ORDER BY m.created_at, m.workspace_id LIMIT 1`,
    [SYSTEM_PASSWORD_HASH],
  );
  return res.rows[0] ?? null;
}

/** Library-only: workspace plus a system actor (operator role) that nobody can sign in as. */
export async function createSystemWorkspace(kit: UndoKit, workspaceName: string): Promise<{ workspace_id: string; user_id: string }> {
  assertReady(kit);
  const name = workspaceName.trim();
  if (name.length < 1 || name.length > 128) throw new AppError("VALIDATION_FAILED", "workspace_name must be 1-128 characters");
  const now = kit.clock.now().toISOString();
  const workspaceId = kit.ids.next();
  const userId = kit.ids.next();
  await kit.db.transaction(async (tx) => {
    await tx.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3::timestamptz)", [workspaceId, name, now]);
    await tx.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, $2, 'system', $3, $4::timestamptz)", [
      userId,
      `system-${workspaceId}@undokit.invalid`,
      SYSTEM_PASSWORD_HASH,
      now,
    ]);
    await tx.query("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'operator', $3::timestamptz)", [workspaceId, userId, now]);
  });
  return { workspace_id: workspaceId, user_id: userId };
}

/**
 * First-run bootstrap: allowed only while the instance has no loginable users. System actors created by a
 * clean-install import do not count. If such an import already created a workspace, the new admin joins it
 * (and the workspace takes `workspace_name`), so the imported evidence is visible after sign-in.
 */
export async function bootstrapAdmin(kit: UndoKit, input: WorkspaceBootstrap): Promise<{ workspace_id: string; user_id: string }> {
  const existing = await kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE password_hash <> $1", [SYSTEM_PASSWORD_HASH]);
  if ((existing.rows[0]?.n ?? 0) > 0) throw new AppError("FORBIDDEN", "instance is already bootstrapped");
  const system = await findSystemWorkspace(kit);
  if (!system) return createWorkspaceWithAdmin(kit, input);
  assertReady(kit);
  validatePasswordPolicy(input.password);
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new AppError("VALIDATION_FAILED", "invalid email");
  const name = input.workspace_name.trim();
  if (name.length < 1 || name.length > 128) throw new AppError("VALIDATION_FAILED", "workspace_name must be 1-128 characters");
  const passwordHash = await hashPassword(input.password);
  const now = kit.clock.now().toISOString();
  const userId = kit.ids.next();
  try {
    await kit.db.transaction(async (tx) => {
      await tx.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)", [userId, email, input.display_name ?? null, passwordHash, now]);
      await tx.query("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'admin', $3::timestamptz)", [system.workspace_id, userId, now]);
      await tx.query("UPDATE workspaces SET name = $2 WHERE id = $1::uuid", [system.workspace_id, name]);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("DUPLICATE_RESOURCE", "email is already registered");
    throw err;
  }
  return { workspace_id: system.workspace_id, user_id: userId };
}

export async function createMember(kit: UndoKit, actor: Actor, body: unknown): Promise<MemberView> {
  requireRole(actor, "admin");
  assertReady(kit);
  const req = parseBody(createMemberRequestSchema, body);
  const email = req.email.trim().toLowerCase();
  const passwordHash = await hashPassword(req.password);
  const now = kit.clock.now().toISOString();
  const userId = kit.ids.next();
  try {
    await kit.db.transaction(async (tx) => {
      await tx.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)", [
        userId,
        email,
        req.display_name ?? null,
        passwordHash,
        now,
      ]);
      await tx.query("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, $4::timestamptz)", [actor.workspace_id, userId, req.role, now]);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("DUPLICATE_RESOURCE", "email is already registered");
    throw err;
  }
  return { user_id: userId, email, display_name: req.display_name ?? null, role: req.role, created_at: now };
}

export async function listMembers(kit: UndoKit, actor: Actor): Promise<MemberView[]> {
  requireRole(actor, "admin");
  const res = await kit.db.query<{ user_id: string; email: string; display_name: string | null; role: Role; created_at: string }>(
    `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1::uuid ORDER BY m.created_at, m.user_id`,
    [actor.workspace_id],
  );
  return res.rows;
}

/* ---------- sessions ---------- */

export interface LoginMeta {
  /** Client address, used only for rate limiting. */
  ip?: string;
}

export interface LoginResult {
  session: SessionView;
  /** Raw bearer token for the HttpOnly cookie. Only its hash is stored. */
  token: string;
  session_id: string;
}

export async function login(kit: UndoKit, body: unknown, meta: LoginMeta = {}): Promise<LoginResult> {
  assertReady(kit);
  const req = parseBody(loginRequestSchema, body);
  const email = req.email.trim().toLowerCase();
  const limiterKey = `${meta.ip ?? "-"}|${email}`;
  if (kit.loginLimiter.blocked(limiterKey)) throw new AppError("RATE_LIMITED", "too many failed sign-in attempts; try again later");
  const found = await kit.db.query<{ id: string; email: string; display_name: string | null; password_hash: string }>(
    "SELECT id, email, display_name, password_hash FROM users WHERE email = $1",
    [email],
  );
  const user = found.rows[0];
  const ok = await verifyPassword(req.password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !ok) {
    kit.loginLimiter.recordFailure(limiterKey);
    throw new AppError("INVALID_CREDENTIALS", "email or password is incorrect");
  }
  const memberships = await kit.db.query<{ workspace_id: string; role: Role; name: string }>(
    `SELECT m.workspace_id, m.role, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1::uuid AND ($2::uuid IS NULL OR m.workspace_id = $2::uuid) ORDER BY m.created_at, m.workspace_id`,
    [user.id, req.workspace_id ?? null],
  );
  const membership = memberships.rows[0];
  if (!membership) {
    kit.loginLimiter.recordFailure(limiterKey);
    throw new AppError("INVALID_CREDENTIALS", "email or password is incorrect");
  }
  kit.loginLimiter.clear(limiterKey);
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const now = kit.clock.now();
  const expires = addMs(now, kit.config.sessionTtlMs);
  const sessionId = kit.ids.next();
  await kit.db.query(
    `INSERT INTO sessions (id, user_id, workspace_id, token_hash, csrf_token, created_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $6::timestamptz)`,
    [sessionId, user.id, membership.workspace_id, sha256Token(token), csrf, now.toISOString(), expires.toISOString()],
  );
  return {
    token,
    session_id: sessionId,
    session: {
      user: { id: user.id, email: user.email, display_name: user.display_name },
      workspace: { id: membership.workspace_id, name: membership.name },
      role: membership.role,
      csrf_token: csrf,
      expires_at: expires.toISOString(),
    },
  };
}

export interface Authenticated {
  actor: Actor;
  session_id: string;
  csrf_token: string;
  view: SessionView;
}

/** Resolve a raw session token; returns null for unknown, revoked or expired sessions. */
export async function authenticate(kit: UndoKit, token: string | undefined): Promise<Authenticated | null> {
  if (!token || token.length > 256) return null;
  const now = kit.clock.now();
  const res = await kit.db.query<{
    id: string;
    user_id: string;
    workspace_id: string;
    csrf_token: string;
    expires_at: string;
    email: string;
    display_name: string | null;
    role: Role;
    workspace_name: string;
    last_seen_at: string | null;
  }>(
    `SELECT s.id, s.user_id, s.workspace_id, s.csrf_token, s.expires_at, s.last_seen_at, u.email, u.display_name, m.role, w.name AS workspace_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz`,
    [sha256Token(token), now.toISOString()],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!row.last_seen_at || now.getTime() - Date.parse(row.last_seen_at) > 60_000) {
    await kit.db.query("UPDATE sessions SET last_seen_at = $2::timestamptz WHERE id = $1::uuid", [row.id, now.toISOString()]);
  }
  return {
    actor: { user_id: row.user_id, workspace_id: row.workspace_id, role: row.role },
    session_id: row.id,
    csrf_token: row.csrf_token,
    view: {
      user: { id: row.user_id, email: row.email, display_name: row.display_name },
      workspace: { id: row.workspace_id, name: row.workspace_name },
      role: row.role,
      csrf_token: row.csrf_token,
      expires_at: row.expires_at,
    },
  };
}

export async function logout(kit: UndoKit, sessionId: string): Promise<void> {
  await kit.db.query("UPDATE sessions SET revoked_at = $2::timestamptz WHERE id = $1::uuid AND revoked_at IS NULL", [sessionId, kit.clock.now().toISOString()]);
}

export async function listSessions(kit: UndoKit, actor: Actor, currentSessionId: string): Promise<SessionListItem[]> {
  const admin = actor.role === "admin";
  const res = await kit.db.query<Omit<SessionListItem, "current">>(
    `SELECT s.id, s.user_id, u.email, s.created_at, s.expires_at, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.workspace_id = $1::uuid AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz
        AND ($3::boolean OR s.user_id = $4::uuid)
      ORDER BY s.created_at DESC, s.id LIMIT 200`,
    [actor.workspace_id, kit.clock.now().toISOString(), admin, actor.user_id],
  );
  return res.rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
}

/** Admins may revoke any session in their workspace; everyone may revoke their own. */
export async function revokeSession(kit: UndoKit, actor: Actor, sessionId: string): Promise<void> {
  assertUuid(sessionId, "session");
  const res = await kit.db.query(
    `UPDATE sessions SET revoked_at = $4::timestamptz
      WHERE id = $1::uuid AND workspace_id = $2::uuid AND revoked_at IS NULL AND ($5::boolean OR user_id = $3::uuid)`,
    [sessionId, actor.workspace_id, actor.user_id, kit.clock.now().toISOString(), actor.role === "admin"],
  );
  if (res.rowCount === 0) throw new AppError("NOT_FOUND", "session not found");
}
