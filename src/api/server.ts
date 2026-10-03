import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { UndoKit } from "../context.js";
import { AppError, errorEnvelope } from "../domain/errors.js";
import { redactText } from "../domain/redact.js";
import { DEFAULT_LIMITS, PRODUCT_VERSION, SCHEMA_VERSION } from "../domain/types.js";
import { exportBundle, getImport, importBundle, listImports } from "../evidence/bundle.js";
import { authenticate, createMember, listMembers, listSessions, login, logout, revokeSession, type Authenticated } from "../services/auth.js";
import type { Actor } from "../services/common.js";
import { checkConnector, createConnector, getConnector, listConnectors } from "../services/connectors.js";
import {
  approveOperation,
  compensateOperation,
  createCompensationPlan,
  getJob,
  getOperation,
  listCompensations,
  listJobs,
  listOperationEvents,
  listOperations,
  planOperation,
  requestReconcile,
  resolveUnknown,
} from "../services/operations.js";
import { getStatus } from "../services/status.js";

export const SESSION_COOKIE = "undokit_session";
const API = "/api/v1";
const PUBLIC_ROUTES = new Set([`${API}/health`, `${API}/ready`, `${API}/auth/login`]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

declare module "fastify" {
  interface FastifyRequest {
    auth?: Authenticated;
  }
}

export interface ServerOptions {
  /** Add the Secure attribute to the session cookie (default: true unless bound to loopback). */
  cookieSecure?: boolean;
  /** Directory of the built web UI; served at `/` with an SPA fallback when it exists. */
  webRoot?: string | undefined;
  logger?: boolean;
  /**
   * Trust X-Forwarded-* from reverse proxies (default off): a hop count (`true` means 1) or a list of trusted proxy
   * addresses/CIDRs. Only the entries added by the declared hops are used, never the client-controlled leftmost
   * X-Forwarded-For value. The proxy must overwrite X-Forwarded-Proto/Host and append to X-Forwarded-For. With it on,
   * the same-origin check compares the browser's Origin to `<forwarded proto>://<forwarded host>`.
   */
  trustProxy?: boolean | number | string[];
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
  state: z.string().max(32).optional(),
});

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      /* malformed percent-encoding: treat the cookie as absent */
    }
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authOf(req: FastifyRequest): Authenticated {
  if (!req.auth) throw new AppError("UNAUTHENTICATED", "sign in required");
  return req.auth;
}

function actorOf(req: FastifyRequest): Actor {
  return authOf(req).actor;
}

function parseQuery(query: unknown): z.infer<typeof listQuerySchema> {
  const res = listQuerySchema.safeParse(query);
  if (!res.success) throw new AppError("MALFORMED_REQUEST", "invalid query parameters");
  return res.data;
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** A hop count N trusts the connecting socket and the next N-1 hops (`hop < N`); a list trusts those addresses/CIDRs. */
function fastifyTrustProxy(value: boolean | number | string[] | undefined): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (value === undefined || value === false || value === 0) return false;
  if (value === true) return (_address, hop) => hop < 1;
  if (typeof value === "number") return (_address, hop) => hop < value;
  return value;
}

export async function buildServer(kit: UndoKit, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const secureCookie = opts.cookieSecure ?? false;
  const app = Fastify({
    logger: opts.logger === true,
    bodyLimit: DEFAULT_LIMITS.maxBodyBytes,
    trustProxy: fastifyTrustProxy(opts.trustProxy),
    genReqId: () => kit.ids.next(),
  });

  /* ---- JSON parsing: empty body is "no body"; malformed JSON is a typed 400 ---- */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError("MALFORMED_REQUEST", "request body is not valid JSON"), undefined);
    }
  });

  /* ---- error envelope ---- */
  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, req, reply) => {
    let appError: AppError;
    if (err instanceof AppError) appError = err;
    else if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || err.statusCode === 413) appError = new AppError("PAYLOAD_TOO_LARGE", "request body is too large");
    else if (typeof err.code === "string" && (/^(08|57P0|53)/.test(err.code) || ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EPIPE"].includes(err.code))) appError = new AppError("DEPENDENCY_UNAVAILABLE", "the database is temporarily unavailable");
    else if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) appError = new AppError("MALFORMED_REQUEST", "request could not be processed");
    else {
      req.log.error({ msg: redactText(err.message, kit.secrets).slice(0, 300), request_id: req.id }, "unhandled error");
      appError = new AppError("INTERNAL_ERROR", "internal error");
    }
    void reply.code(appError.status).send(errorEnvelope(appError, req.id));
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith(API) && webIndex) return reply.type("text/html; charset=utf-8").send(webIndex);
    return reply.code(404).send(errorEnvelope(new AppError("NOT_FOUND", "no such route"), req.id));
  });

  /* ---- security headers ---- */
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Request-Id", req.id);
    if (req.url.startsWith(API)) reply.header("Cache-Control", "no-store");
    return payload;
  });

  /* ---- authentication, readiness, CSRF ---- */
  app.addHook("onRequest", async (req) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith(API)) return;
    // Cross-origin writes are refused outright, whatever credentials ride along.
    const origin = req.headers.origin;
    if (MUTATING.has(req.method) && typeof origin === "string" && origin !== "null") {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).origin === new URL(`${req.protocol}://${req.host}`).origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) throw new AppError("CSRF_FAILED", "cross-origin request refused");
    } else if (MUTATING.has(req.method) && origin === "null") {
      throw new AppError("CSRF_FAILED", "cross-origin request refused");
    }
    if (PUBLIC_ROUTES.has(route)) return;
    if (!kit.readiness.ok) throw new AppError("NOT_READY", "service is not ready: database schema is not current");
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const auth = await authenticate(kit, token);
    if (!auth) throw new AppError("UNAUTHENTICATED", "sign in required");
    if (MUTATING.has(req.method)) {
      const sent = req.headers["x-csrf-token"];
      if (typeof sent !== "string" || !safeEqual(sent, auth.csrf_token)) throw new AppError("CSRF_FAILED", "missing or invalid CSRF token");
    }
    req.auth = auth;
  });

  /* ---- health ---- */
  app.get(`${API}/health`, async () => ({ status: "ok", version: PRODUCT_VERSION }));
  app.get(`${API}/ready`, async () => {
    const r = await kit.refreshReadiness();
    if (!r.ok) throw new AppError("NOT_READY", "service is not ready: database unavailable or schema not current");
    return { ready: true, schema_version: SCHEMA_VERSION, migrations: r.status.latest };
  });

  /* ---- auth ---- */
  app.post(`${API}/auth/login`, async (req, reply) => {
    const result = await login(kit, req.body, { ip: req.ip });
    const maxAge = Math.max(1, Math.floor((Date.parse(result.session.expires_at) - kit.clock.now().getTime()) / 1000));
    void reply.header("Set-Cookie", sessionCookie(result.token, maxAge, secureCookie));
    return result.session;
  });
  app.post(`${API}/auth/logout`, async (req, reply) => {
    await logout(kit, authOf(req).session_id);
    void reply.header("Set-Cookie", sessionCookie("", 0, secureCookie));
    return reply.code(204).send();
  });
  app.get(`${API}/auth/me`, async (req) => authOf(req).view);
  app.get(`${API}/sessions`, async (req) => ({ items: await listSessions(kit, actorOf(req), authOf(req).session_id) }));
  app.delete<{ Params: { id: string } }>(`${API}/sessions/:id`, async (req, reply) => {
    await revokeSession(kit, actorOf(req), req.params.id);
    return reply.code(204).send();
  });

  /* ---- members ---- */
  app.get(`${API}/members`, async (req) => ({ items: await listMembers(kit, actorOf(req)) }));
  app.post(`${API}/members`, async (req, reply) => reply.code(201).send(await createMember(kit, actorOf(req), req.body)));

  /* ---- connectors ---- */
  app.get(`${API}/connectors`, async (req) => ({ items: await listConnectors(kit, actorOf(req)) }));
  app.get<{ Params: { id: string } }>(`${API}/connectors/:id`, async (req) => getConnector(kit, actorOf(req), req.params.id));
  app.post(`${API}/connectors`, async (req, reply) => reply.code(201).send(await createConnector(kit, actorOf(req), req.body)));
  app.post<{ Params: { id: string } }>(`${API}/connectors/:id/check`, async (req) => checkConnector(kit, actorOf(req), req.params.id));

  /* ---- operations ---- */
  app.post(`${API}/operations`, async (req, reply) => {
    const header = req.headers["idempotency-key"];
    const key = Array.isArray(header) ? header[0] : header;
    const result = await planOperation(kit, actorOf(req), req.body, key);
    if (result.replayed) void reply.header("Idempotency-Replayed", "true");
    return reply.code(result.status).send(result.body);
  });
  app.get(`${API}/operations`, async (req) => listOperations(kit, actorOf(req), parseQuery(req.query)));
  app.get<{ Params: { id: string } }>(`${API}/operations/:id`, async (req) => getOperation(kit, actorOf(req), req.params.id));
  app.get<{ Params: { id: string } }>(`${API}/operations/:id/events`, async (req) => listOperationEvents(kit, actorOf(req), req.params.id));
  app.post<{ Params: { id: string } }>(`${API}/operations/:id/approve`, async (req, reply) => reply.code(202).send(await approveOperation(kit, actorOf(req), req.params.id, req.body)));
  app.post<{ Params: { id: string } }>(`${API}/operations/:id/reconcile`, async (req, reply) => reply.code(202).send(await requestReconcile(kit, actorOf(req), req.params.id)));
  app.post<{ Params: { id: string } }>(`${API}/operations/:id/resolve`, async (req) => resolveUnknown(kit, actorOf(req), req.params.id, req.body));
  app.post<{ Params: { id: string } }>(`${API}/operations/:id/compensation-plans`, async (req, reply) => reply.code(201).send(await createCompensationPlan(kit, actorOf(req), req.params.id)));
  app.get<{ Params: { id: string } }>(`${API}/operations/:id/compensations`, async (req) => listCompensations(kit, actorOf(req), req.params.id));
  app.post<{ Params: { id: string } }>(`${API}/operations/:id/compensate`, async (req, reply) => reply.code(202).send(await compensateOperation(kit, actorOf(req), req.params.id, req.body)));

  /* ---- jobs and status ---- */
  app.get(`${API}/jobs`, async (req) => listJobs(kit, actorOf(req), parseQuery(req.query)));
  app.get<{ Params: { id: string } }>(`${API}/jobs/:id`, async (req) => getJob(kit, actorOf(req), req.params.id));
  app.get(`${API}/status`, async (req) => getStatus(kit, actorOf(req)));

  /* ---- evidence export / import ---- */
  app.post(`${API}/exports`, async (req, reply) => reply.code(200).send(await exportBundle(kit, actorOf(req), req.body ?? {})));
  app.get(`${API}/imports`, async (req) => listImports(kit, actorOf(req), parseQuery(req.query)));
  app.get<{ Params: { id: string } }>(`${API}/imports/:id`, async (req) => getImport(kit, actorOf(req), req.params.id));
  // The import route receives the bundle as raw text (truncation must be detectable) with a larger body limit.
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: kit.config.maxImportBytes }, (_req, body, done) => {
      done(null, typeof body === "string" ? body : body.toString("utf8"));
    });
    scope.post(`${API}/imports`, { bodyLimit: kit.config.maxImportBytes }, async (req: FastifyRequest, reply: FastifyReply) => {
      const text = typeof req.body === "string" ? req.body : "";
      const result = await importBundle(kit, actorOf(req), text);
      return reply.code(result.replayed ? 200 : 201).send(result);
    });
  });

  /* ---- web UI (optional) ---- */
  let webIndex: string | undefined;
  if (opts.webRoot && existsSync(join(opts.webRoot, "index.html"))) {
    const { readFileSync } = await import("node:fs");
    webIndex = readFileSync(join(opts.webRoot, "index.html"), "utf8");
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, { root: opts.webRoot, prefix: "/", index: ["index.html"], wildcard: false, cacheControl: true, maxAge: "1h" });
  }

  return app;
}
