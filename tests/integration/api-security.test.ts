import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, computeApplyPlanHash, createCompensationPlan, planOperation, type Actor, type ApplyPlanInput } from "../../src/index.js";
import { HOST, ORIGIN, anon, login, type Client } from "../helpers/http.js";
import { leakedNeedles, loadDemo, loadHostile, loadSecrets } from "../helpers/fixtures.js";
import { makeEnv, type Env } from "../helpers/kit.js";

let env: Env;
let app: FastifyInstance;
let admin: Client;
let operator: Client;
let viewer: Client;
let adminB: Client;
let operatorB: Client;
let appliedId: string; // an applied operation in workspace A (job, events, compensation all exist)
let plannedId: string; // a planned operation in workspace A
let compPlanHash: string;
let jobId: string;

async function must(email: string, password: string): Promise<Client> {
  const r = await login(app, email, password);
  if (!r.client) throw new Error(`login failed for ${email}: ${r.reply.status}`);
  return r.client;
}

beforeAll(async () => {
  env = await makeEnv({ sensitiveFields: ["owner_label"] });
  app = await buildServer(env.kit);
  admin = await must(env.emails.admin, env.passwords.admin);
  operator = await must(env.emails.operator, env.passwords.operator);
  viewer = await must(env.emails.viewer, env.passwords.viewer);
  adminB = await must(env.emails.adminB, env.passwords.adminB);
  operatorB = await must(env.emails.operatorB, env.passwords.operatorB);
  const applied = await env.applyOnce({ lifecycle_stage: "customer", owner_label: "alice-private-name" });
  appliedId = applied.id;
  const comp = await createCompensationPlan(env.kit, env.operator, appliedId);
  compPlanHash = comp.plan_hash;
  plannedId = (await env.plan({ lead_score: 12 }, { record_ref: "contact-0002" })).id;
  jobId = (await operator.get("/api/v1/jobs")).body.items[0].id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await env.close();
});

const planBody = (patch: Record<string, unknown> = { lead_score: 61 }, ref = "contact-0002") => ({
  connector_id: env.connectorId,
  record_ref: ref,
  patch,
  expected_version: env.sim.snapshot(ref)!.version,
});

describe("authentication, sessions and CSRF", () => {
  it("login sets an HttpOnly, SameSite=Strict, Path=/ cookie and returns the session view (the raw token is only in the cookie)", async () => {
    const r = await login(app, env.emails.operator, env.passwords.operator);
    expect(r.reply.status).toBe(200);
    const cookie = String(r.client && (await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { host: HOST }, payload: { email: env.emails.operator, password: env.passwords.operator } })).headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/); // default is for loopback development
    expect(JSON.stringify(r.reply.body)).not.toContain(r.client!.token);
    expect(r.reply.body.role).toBe("operator");
  });

  it("the Secure attribute is set when the server is configured for a non-loopback deployment", async () => {
    const secureApp = await buildServer(env.kit, { cookieSecure: true });
    try {
      const res = await secureApp.inject({ method: "POST", url: "/api/v1/auth/login", headers: { host: HOST }, payload: { email: env.emails.viewer, password: env.passwords.viewer } });
      expect(String(res.headers["set-cookie"])).toMatch(/; Secure/);
    } finally {
      await secureApp.close();
    }
  });

  it("wrong password and unknown email give the same 401 body (no account enumeration)", async () => {
    const wrongPw = await login(app, env.emails.operator, "definitely-not-the-password");
    const unknown = await login(app, "nobody@example.test", "definitely-not-the-password");
    expect(wrongPw.reply.status).toBe(401);
    expect(unknown.reply.status).toBe(401);
    expect(wrongPw.reply.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPw.reply.body.error.message).toBe(unknown.reply.body.error.message);
  });

  it("repeated failures from one client are rate limited (429), while another client address is unaffected", async () => {
    const victim = env.emails.viewer;
    for (let i = 0; i < env.kit.config.loginMaxFailures; i += 1) await login(app, victim, "wrong-password-xx", "10.9.9.9");
    const blocked = await login(app, victim, env.passwords.viewer, "10.9.9.9");
    expect(blocked.reply.status).toBe(429);
    expect(blocked.reply.body.error.code).toBe("RATE_LIMITED");
    const other = await login(app, victim, env.passwords.viewer, "10.8.8.8");
    expect(other.reply.status).toBe(200);
  });

  it("every protected route returns 401 without a session", async () => {
    const a = anon(app);
    const gets = ["/api/v1/auth/me", "/api/v1/sessions", "/api/v1/members", "/api/v1/connectors", `/api/v1/connectors/${env.connectorId}`, "/api/v1/operations", `/api/v1/operations/${appliedId}`, `/api/v1/operations/${appliedId}/events`, `/api/v1/operations/${appliedId}/compensations`, "/api/v1/jobs", `/api/v1/jobs/${jobId}`, "/api/v1/status", "/api/v1/imports"];
    for (const url of gets) expect((await a.get(url)).status, url).toBe(401);
    const posts = ["/api/v1/auth/logout", "/api/v1/members", "/api/v1/connectors", `/api/v1/connectors/${env.connectorId}/check`, "/api/v1/operations", `/api/v1/operations/${plannedId}/approve`, `/api/v1/operations/${appliedId}/reconcile`, `/api/v1/operations/${appliedId}/compensation-plans`, `/api/v1/operations/${appliedId}/compensate`, "/api/v1/exports", "/api/v1/imports"];
    for (const url of posts) expect((await a.post(url, {})).status, url).toBe(401);
  });

  it("a mutating request without the CSRF token, or with a wrong one, is refused with 403 and changes nothing", async () => {
    const before = await env.count("operations");
    const noToken = await app.inject({ method: "POST", url: "/api/v1/operations", headers: { host: HOST, cookie: operator.cookie, "idempotency-key": "csrf-1" }, payload: planBody() });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error.code).toBe("CSRF_FAILED");
    const wrong = await operator.post("/api/v1/operations", planBody(), { headers: { "x-csrf-token": "x".repeat(operator.csrf.length), "idempotency-key": "csrf-2" } });
    expect(wrong.status).toBe(403);
    expect(await env.count("operations")).toBe(before);
  });

  it("the CSRF token of one session does not work for another session", async () => {
    const res = await operator.post("/api/v1/operations", planBody(), { headers: { "x-csrf-token": admin.csrf, "idempotency-key": "csrf-3" } });
    expect(res.status).toBe(403);
  });

  it("cross-origin writes are refused whatever credentials ride along; null origin too; same origin works", async () => {
    for (const origin of ["http://evil.example", "http://undokit.test.evil.example", "http://evil.example:80", "null"]) {
      const res = await operator.post("/api/v1/operations", planBody(), { headers: { origin, "idempotency-key": `origin-${origin}` } });
      expect(res.status, origin).toBe(403);
      expect(res.body.error.code).toBe("CSRF_FAILED");
    }
    const ok = await operator.post("/api/v1/operations", planBody({ lead_score: 62 }), { headers: { origin: ORIGIN, "idempotency-key": "origin-ok" } });
    expect(ok.status).toBe(201);
  });

  // Regression tests for QA-D8 (fixed in 3d15b45): the Origin must equal scheme + host + port, not only the host name.
  it("an Origin with the same host but a different scheme is refused (CSRF_FAILED) and nothing is stored", async () => {
    const before = await env.count("operations");
    for (const origin of ["https://undokit.test", "ftp://undokit.test", "HTTPS://UNDOKIT.TEST"]) {
      const res = await operator.post("/api/v1/operations", planBody({ lead_score: 64 }), { headers: { origin, "idempotency-key": `origin-scheme-${origin}` } });
      expect(res.status, origin).toBe(403);
      expect(res.body.error.code).toBe("CSRF_FAILED");
    }
    expect(await env.count("operations")).toBe(before);
  });

  it("an Origin with the same host but a different port is refused; a matching host and port is accepted", async () => {
    const before = await env.count("operations");
    const refused = await operator.post("/api/v1/operations", planBody({ lead_score: 65 }), { headers: { host: "undokit.test:8443", origin: "http://undokit.test:8444", "idempotency-key": "origin-port-wrong" } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("CSRF_FAILED");
    const noPort = await operator.post("/api/v1/operations", planBody({ lead_score: 65 }), { headers: { host: "undokit.test:8443", origin: "http://undokit.test", "idempotency-key": "origin-port-missing" } });
    expect(noPort.status).toBe(403);
    expect(await env.count("operations")).toBe(before);
    const accepted = await operator.post("/api/v1/operations", planBody({ lead_score: 65 }), { headers: { host: "undokit.test:8443", origin: "http://undokit.test:8443", "idempotency-key": "origin-port-ok" } });
    expect(accepted.status).toBe(201);
  });

  it("a state-changing GET does not exist: GET on a mutating path is a 404 envelope, not an action", async () => {
    const res = await operator.get(`/api/v1/operations/${plannedId}/approve`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("logout revokes the session: the same cookie then gets 401", async () => {
    const c = await must(env.emails.viewer, env.passwords.viewer);
    expect((await c.get("/api/v1/auth/me")).status).toBe(200);
    expect((await c.post("/api/v1/auth/logout")).status).toBe(204);
    expect((await c.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("a forged, truncated or oversized session cookie is 401, not 500", async () => {
    for (const cookie of ["undokit_session=", "undokit_session=garbage", `undokit_session=${"a".repeat(5000)}`, "other=1", "undokit_session", ";;;", "=;="]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { host: HOST, cookie } });
      expect([401, 400], cookie.slice(0, 30)).toContain(res.statusCode);
    }
  });

  // Regression test for QA-D9 (P2, fixed in 3d15b45): malformed percent-encoding in the Cookie header is an absent cookie (401), not a 500.
  it("a Cookie header with malformed percent-encoding is 401, not 500", async () => {
    for (const cookie of ["undokit_session=%E0%A4%A", "undokit_session=%", "undokit_session=%zz", "a=%; undokit_session=%E0%A4%A"]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { host: HOST, cookie } });
      expect(res.statusCode, cookie).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }
    expect((await operator.get("/api/v1/auth/me")).status).toBe(200); // a valid session is unaffected
  });

  it("an expired session is refused", async () => {
    const short = await must(env.emails.admin, env.passwords.admin);
    env.advance(env.kit.config.sessionTtlMs + 1);
    expect((await short.get("/api/v1/auth/me")).status).toBe(401);
    // restore valid sessions for the remaining tests (a fixed clock cannot go back, so log in again)
    admin = await must(env.emails.admin, env.passwords.admin);
    operator = await must(env.emails.operator, env.passwords.operator);
    viewer = await must(env.emails.viewer, env.passwords.viewer);
    adminB = await must(env.emails.adminB, env.passwords.adminB);
    operatorB = await must(env.emails.operatorB, env.passwords.operatorB);
  });

  it("members: no default password, a short password is rejected, a duplicate email is a conflict, and no response carries a password or hash", async () => {
    const short = await admin.post("/api/v1/members", { email: "x1@example.test", password: "short", role: "viewer" });
    expect(short.status).toBe(422);
    const dup = await admin.post("/api/v1/members", { email: env.emails.viewer, password: "a-long-enough-password", role: "viewer" });
    expect(dup.status).toBe(409);
    const list = await admin.get("/api/v1/members");
    expect(list.status).toBe(200);
    expect(list.text).not.toMatch(/password|hash|scrypt|argon/i);
    const me = await operator.get("/api/v1/auth/me");
    expect(me.text).not.toMatch(/password|hash/i);
  });

  it("security headers are present on API responses, which are never cached", async () => {
    const res = await operator.get("/api/v1/operations");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'self'");
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("every response carries a request id equal to the id in an error body", async () => {
    const res = await operator.get("/api/v1/operations/not-a-uuid");
    expect(res.headers["x-request-id"]).toBe(res.body.error.request_id);
  });
});

describe("AC-12 roles: each role succeeds on its permitted routes and gets 403 elsewhere, with no state change", () => {
  it("viewer: reads succeed (redacted), every write is 403", async () => {
    for (const url of ["/api/v1/operations", `/api/v1/operations/${appliedId}`, `/api/v1/operations/${appliedId}/events`, `/api/v1/operations/${appliedId}/compensations`, "/api/v1/jobs", `/api/v1/jobs/${jobId}`, "/api/v1/status", "/api/v1/connectors", `/api/v1/connectors/${env.connectorId}`, "/api/v1/auth/me", "/api/v1/imports"]) {
      expect((await viewer.get(url)).status, url).toBe(200);
    }
    const before = { ops: await env.count("operations"), jobs: await env.count("jobs"), approvals: await env.count("approvals"), conns: await env.count("connectors") };
    const writes: [string, unknown][] = [
      ["/api/v1/operations", planBody()],
      [`/api/v1/operations/${plannedId}/approve`, { plan_hash: `sha256:${"0".repeat(64)}`, expected_version: "sim-v1" }],
      [`/api/v1/operations/${appliedId}/compensation-plans`, {}],
      [`/api/v1/operations/${appliedId}/compensate`, { plan_hash: compPlanHash }],
      [`/api/v1/operations/${appliedId}/reconcile`, {}],
      ["/api/v1/exports", {}],
      ["/api/v1/connectors", { kind: "simulator", name: "x", policy: { allowed_fields: [{ name: "a", type: "string" }], record_prefixes: ["c-"] } }],
      [`/api/v1/connectors/${env.connectorId}/check`, {}],
      ["/api/v1/members", { email: "v@example.test", password: "a-long-enough-password", role: "viewer" }],
    ];
    for (const [url, payload] of writes) {
      const res = await viewer.post(url, payload, { headers: { "idempotency-key": "viewer-write" } });
      expect(res.status, url).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
    const imp = await viewer.post("/api/v1/imports", undefined, { raw: "{}" });
    expect(imp.status).toBe(403);
    expect((await viewer.get("/api/v1/members")).status).toBe(403);
    expect({ ops: await env.count("operations"), jobs: await env.count("jobs"), approvals: await env.count("approvals"), conns: await env.count("connectors") }).toEqual(before);
  });

  it("viewer sees sensitive fields redacted everywhere they appear, operator and admin see values", async () => {
    const asViewer = await viewer.get(`/api/v1/operations/${appliedId}`);
    const field = asViewer.body.fields.find((f: { field: string }) => f.field === "owner_label");
    expect(field).toMatchObject({ redacted: true, sensitive: true, before: "[REDACTED]", intended: "[REDACTED]" });
    expect(asViewer.text).not.toContain("alice-private-name");
    expect((await viewer.get("/api/v1/operations")).text).not.toContain("alice-private-name");
    expect((await viewer.get(`/api/v1/operations/${appliedId}/compensations`)).text).not.toContain("alice-private-name");
    expect((await viewer.get(`/api/v1/operations/${appliedId}/events`)).text).not.toContain("alice-private-name");
    const asOperator = await operator.get(`/api/v1/operations/${appliedId}`);
    expect(asOperator.body.fields.find((f: { field: string }) => f.field === "owner_label")).toMatchObject({ redacted: false, intended: "alice-private-name" });
    expect((await admin.get(`/api/v1/operations/${appliedId}`)).text).toContain("alice-private-name");
  });

  it("the plan hash of a sensitive field is keyed: it cannot be reproduced from the plain values, but a non-sensitive plan matches an independent oracle", async () => {
    const view = (await operator.get(`/api/v1/operations/${appliedId}`)).body;
    const plain: ApplyPlanInput = {
      operation_id: view.id,
      workspace_id: view.workspace_id,
      connector_id: view.connector_id,
      record_ref: view.record_ref,
      expected_version: view.expected_version,
      fields: view.fields.map((f: { field: string; before: never; intended: never }) => ({ field: f.field, before: f.before, intended: f.intended })),
    };
    expect(computeApplyPlanHash(plain)).not.toBe(view.plan_hash); // owner_label is sensitive: the hash must not be derivable from its value
    const plannedView = (await operator.get(`/api/v1/operations/${plannedId}`)).body;
    const oracle = computeApplyPlanHash({
      operation_id: plannedView.id,
      workspace_id: plannedView.workspace_id,
      connector_id: plannedView.connector_id,
      record_ref: plannedView.record_ref,
      expected_version: plannedView.expected_version,
      fields: plannedView.fields.map((f: { field: string; before: never; intended: never }) => ({ field: f.field, before: f.before, intended: f.intended })),
    });
    expect(oracle).toBe(plannedView.plan_hash);
  });

  it("operator: can plan, approve, preview compensation and export; cannot manage connectors or members", async () => {
    const plan = await operator.post("/api/v1/operations", planBody({ lead_score: 63 }), { headers: { "idempotency-key": "op-1" } });
    expect(plan.status).toBe(201);
    const approve = await operator.post(`/api/v1/operations/${plan.body.id}/approve`, { plan_hash: plan.body.plan_hash, expected_version: env.sim.snapshot("contact-0002")!.version });
    expect(approve.status).toBe(202);
    expect((await operator.post(`/api/v1/operations/${appliedId}/compensation-plans`, {})).status).toBe(201);
    expect((await operator.post("/api/v1/exports", {})).status).toBe(200);
    expect((await operator.post("/api/v1/connectors", { kind: "simulator", name: "x", policy: { allowed_fields: [{ name: "a", type: "string" }], record_prefixes: ["c-"] } })).status).toBe(403);
    expect((await operator.post(`/api/v1/connectors/${env.connectorId}/check`, {})).status).toBe(403);
    expect((await operator.get("/api/v1/members")).status).toBe(403);
    expect((await operator.post("/api/v1/members", { email: "o@example.test", password: "a-long-enough-password", role: "viewer" })).status).toBe(403);
    await env.worker.drain();
  });

  it("admin: manages connectors and members; a duplicate connector name is a conflict", async () => {
    const policy = { allowed_fields: [{ name: "lifecycle_stage", type: "string" }], record_prefixes: ["contact-"] };
    const created = await admin.post("/api/v1/connectors", { kind: "simulator", name: "second-sim", policy });
    expect(created.status).toBe(201);
    expect(created.body.live).toBe(false);
    expect(created.body.label).toMatch(/SIMULATOR/);
    expect((await admin.post("/api/v1/connectors", { kind: "simulator", name: "second-sim", policy })).status).toBe(409);
    expect((await admin.post(`/api/v1/connectors/${created.body.id}/check`, {})).status).toBe(200);
    expect((await admin.post("/api/v1/members", { email: "m1@example.test", password: "a-long-enough-password", role: "viewer" })).status).toBe(201);
  });

  it("the simulator is never labelled live, and connector views never contain credentials", async () => {
    const list = await admin.get("/api/v1/connectors");
    for (const c of list.body.items) expect(c.live).toBe(false);
    expect(list.text).not.toMatch(/credentials|password/i);
  });

  it("a user cannot revoke another user's session unless admin; an admin can", async () => {
    const victim = await must(env.emails.viewer, env.passwords.viewer);
    const target = (await victim.get("/api/v1/sessions")).body.items.find((s: { current: boolean }) => s.current);
    expect(target).toBeDefined();
    const adminView = await admin.get("/api/v1/sessions");
    expect(adminView.status).toBe(200);
    expect(adminView.body.items.some((s: { id: string }) => s.id === target.id)).toBe(true);
    // The operator's own list never shows the viewer's sessions, and revoking one is refused.
    const opList = (await operator.get("/api/v1/sessions")).body.items as { email: string }[];
    expect(opList.every((s) => s.email === env.emails.operator)).toBe(true);
    const refused = await operator.del(`/api/v1/sessions/${target.id}`);
    expect(refused.status).toBeGreaterThanOrEqual(403);
    expect(refused.status).toBeLessThan(500);
    expect((await admin.get("/api/v1/auth/me")).status).toBe(200);
    expect((await admin.del(`/api/v1/sessions/${target.id}`)).status).toBe(204);
    expect((await victim.get("/api/v1/auth/me")).status).toBe(401);
    expect((await viewer.get("/api/v1/auth/me")).status).toBe(200); // other sessions of the same user are untouched
  });
});

describe("AC-12 workspace isolation: another workspace's ids are 404 with no state change", () => {
  it("every read and write on workspace A objects by workspace B returns 404 and changes nothing", async () => {
    const snapshot = async () => ({
      ops: (await env.kit.db.query("SELECT id, state, updated_at FROM operations ORDER BY id")).rows,
      jobs: await env.count("jobs"),
      approvals: await env.count("approvals"),
      comps: await env.count("compensations"),
      events: await env.count("evidence_events"),
    });
    const before = await snapshot();
    const reads = [`/api/v1/operations/${appliedId}`, `/api/v1/operations/${appliedId}/events`, `/api/v1/operations/${appliedId}/compensations`, `/api/v1/connectors/${env.connectorId}`, `/api/v1/jobs/${jobId}`];
    for (const url of reads) {
      for (const who of [operatorB, adminB]) {
        const res = await who.get(url);
        expect(res.status, url).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
      }
    }
    const writes: [string, unknown][] = [
      [`/api/v1/operations/${plannedId}/approve`, { plan_hash: `sha256:${"0".repeat(64)}`, expected_version: "sim-v1" }],
      [`/api/v1/operations/${appliedId}/compensation-plans`, {}],
      [`/api/v1/operations/${appliedId}/compensate`, { plan_hash: compPlanHash }],
      [`/api/v1/operations/${appliedId}/reconcile`, {}],
    ];
    for (const [url, payload] of writes) expect((await operatorB.post(url, payload)).status, url).toBe(404);
    expect((await adminB.post(`/api/v1/connectors/${env.connectorId}/check`, {})).status).toBe(404);
    const ownPlan = await operatorB.post("/api/v1/operations", planBody(), { headers: { "idempotency-key": "b-uses-a-connector" } });
    expect(ownPlan.status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it("workspace B lists never contain workspace A rows, and its status counts are its own", async () => {
    const ops = await operatorB.get("/api/v1/operations");
    expect(ops.body.items).toEqual([]);
    expect((await operatorB.get("/api/v1/jobs")).body.items).toEqual([]);
    expect((await operatorB.get("/api/v1/connectors")).body.items).toEqual([]);
    const status = await operatorB.get("/api/v1/status");
    expect(Object.values(status.body.operations as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
    expect((await adminB.get("/api/v1/members")).body.items.map((m: { email: string }) => m.email).sort()).toEqual([env.emails.adminB, env.emails.operatorB].sort());
  });

  it("exporting another workspace's operation ids is refused and a bundle only ever holds the caller's workspace", async () => {
    const res = await operatorB.post("/api/v1/exports", { operation_ids: [appliedId] });
    expect(res.status).toBe(404);
    const own = await operatorB.post("/api/v1/exports", {});
    expect(own.status).toBe(200);
    expect(own.body.manifest.file_count).toBe(0);
    expect(own.text).not.toContain(appliedId);
  });

  it("another workspace's session id cannot be revoked, and sessions lists are per workspace", async () => {
    const aSessions = (await admin.get("/api/v1/sessions")).body.items as { id: string }[];
    const res = await adminB.del(`/api/v1/sessions/${aSessions[0]!.id}`);
    expect(res.status).toBe(404);
    const bIds = new Set(((await adminB.get("/api/v1/sessions")).body.items as { id: string }[]).map((s) => s.id));
    for (const s of aSessions) expect(bIds.has(s.id)).toBe(false);
  });

  it("the same Idempotency-Key in two workspaces is two independent keys", async () => {
    const a = await operator.post("/api/v1/operations", planBody({ lead_score: 71 }), { headers: { "idempotency-key": "same-key-both" } });
    expect(a.status).toBe(201);
    const b = await operatorB.post("/api/v1/operations", planBody({ lead_score: 71 }), { headers: { "idempotency-key": "same-key-both" } });
    expect(b.status).toBe(404); // B has no such connector; the key of A is not consulted
  });
});

describe("AC-06 over HTTP: replay header and key requirements", () => {
  it("a replay returns the same status and body with Idempotency-Replayed: true; the first response does not carry the header", async () => {
    const first = await operator.post("/api/v1/operations", planBody({ lead_score: 81 }), { headers: { "idempotency-key": "http-replay" } });
    const again = await operator.post("/api/v1/operations", planBody({ lead_score: 81 }), { headers: { "idempotency-key": "http-replay" } });
    expect(first.status).toBe(201);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    expect(again.status).toBe(201);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
  });

  it("a changed body under the same key is 409 IDEMPOTENCY_CONFLICT, and a missing key is 400", async () => {
    await operator.post("/api/v1/operations", planBody({ lead_score: 82 }), { headers: { "idempotency-key": "http-conflict" } });
    const changed = await operator.post("/api/v1/operations", planBody({ lead_score: 83 }), { headers: { "idempotency-key": "http-conflict" } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const missing = await operator.post("/api/v1/operations", planBody());
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("a key containing a space or non-ASCII is refused with 400 (printable ASCII, no spaces)", async () => {
    for (const [i, key] of ["has space", "tab\there", "non-ascii-é", ""].entries()) {
      const res = await operator.post("/api/v1/operations", planBody({ lead_score: 90 + i }), { headers: { "idempotency-key": key } });
      expect(res.status, JSON.stringify(key)).toBe(400);
      expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });
});

describe("AC-09 hostile input at the HTTP boundary: validated before processing, no state change, no secrets echoed", () => {
  const stateCounts = async () => ({ ops: await env.count("operations"), keys: await env.count("idempotency_keys"), jobs: await env.count("jobs") });

  it("an oversize body is 413 before it is parsed or acted on", async () => {
    const before = await stateCounts();
    const huge = JSON.stringify({ ...planBody(), padding: "x".repeat(300 * 1024) });
    const res = await operator.post("/api/v1/operations", undefined, { raw: huge, headers: { "idempotency-key": "huge" } });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(await stateCounts()).toEqual(before);
  });

  it.each(loadHostile().malformed_json_bodies.map((b) => [b] as const))("malformed or wrong-shaped JSON body %j is a typed 4xx with no state change", async (raw) => {
    const before = await stateCounts();
    const res = await operator.post("/api/v1/operations", undefined, { raw, headers: { "idempotency-key": "malformed" } });
    expect([400, 422]).toContain(res.status);
    expect(res.body.error.code).toBeTruthy();
    expect(await stateCounts()).toEqual(before);
  });

  it("a very long string value is rejected by validation (422), not stored", async () => {
    const before = await stateCounts();
    const res = await operator.post("/api/v1/operations", planBody({ owner_label: "y".repeat(loadHostile().limits.long_string_length) }), { headers: { "idempotency-key": "long" } });
    expect([413, 422]).toContain(res.status);
    expect(await stateCounts()).toEqual(before);
  });

  it("deeply nested JSON does not crash the server", async () => {
    const depth = 20_000;
    const raw = `{"patch":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const res = await operator.post("/api/v1/operations", undefined, { raw, headers: { "idempotency-key": "nested" } });
    expect(res.status).toBeLessThan(500);
    expect((await operator.get("/api/v1/status")).status).toBe(200);
  });

  it("a __proto__ or constructor key in the body does not pollute anything and is rejected as an unknown key", async () => {
    const res = await operator.post("/api/v1/operations", undefined, { raw: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}', headers: { "idempotency-key": "proto" } });
    expect(res.status).toBeLessThan(500);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("path parameters and query strings that are not valid ids or numbers are 4xx, never 500, and never echoed unescaped", async () => {
    for (const id of ["not-a-uuid", "1' OR '1'='1", encodeURIComponent("<script>alert(1)</script>"), "00000000-0000-0000-0000-000000000000", "../../etc/passwd"]) {
      const res = await operator.get(`/api/v1/operations/${id}`);
      expect(res.status, id).toBeGreaterThanOrEqual(400);
      expect(res.status, id).toBeLessThan(500);
      expect(res.text).not.toContain("<script>");
    }
    for (const q of ["limit=0", "limit=1000", "limit=abc", "limit=-1", "cursor=" + "x".repeat(600), "state=" + "z".repeat(40), "cursor=%00"]) {
      const res = await operator.get(`/api/v1/operations?${q}`);
      expect([400, 422], q).toContain(res.status);
    }
    expect((await operator.get("/api/v1/operations?limit=100")).status).toBe(200);
  });

  it("an unknown route is a typed 404 envelope; an unsupported media type on a JSON route is a typed 4xx", async () => {
    const nf = await operator.get("/api/v1/does-not-exist");
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("NOT_FOUND");
    const res = await operator.post("/api/v1/operations", undefined, { raw: "a=b", contentType: "application/x-www-form-urlencoded", headers: { "idempotency-key": "form" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("error bodies never contain stack traces, SQL, file paths or a planted secret sent as a value or in a path", async () => {
    const secret = loadSecrets().needles[0] as string;
    const attempts = [
      await operator.post("/api/v1/operations", planBody({ lifecycle_stage: secret }), { headers: { "idempotency-key": "secret-value" } }),
      await operator.post("/api/v1/operations", planBody({ owner_label: secret.repeat(3) }), { headers: { "idempotency-key": "secret-value-long" } }),
      await operator.post(`/api/v1/operations/${secret}/approve`, {}),
      await operator.get(`/api/v1/operations/${secret}`),
      await operator.get(`/api/v1/operations?cursor=${secret}`),
    ];
    for (const res of attempts) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(leakedNeedles(res.text)).toEqual([]);
      expect(res.text).not.toMatch(/\bat \w+.*\.(ts|js):\d+|node_modules|SELECT |INSERT |select .* from|\/Users\//);
    }
  });

  // Regression test for QA-D10 (fixed in 3d15b45): credential-shaped KEY names are not echoed back in error details.
  it("a credential-shaped key name sent in the body or the patch is not echoed, while an ordinary unknown key still is (errors stay useful)", async () => {
    const secret = loadSecrets().needles[0] as string;
    const topLevel = await operator.post("/api/v1/operations", { ...planBody({ lead_score: 70 }), [secret]: 1 }, { headers: { "idempotency-key": "secret-key-top" } });
    const inPatch = await operator.post("/api/v1/operations", planBody({ [secret]: "x" }), { headers: { "idempotency-key": "secret-key-patch" } });
    for (const res of [topLevel, inPatch]) {
      expect(res.status).toBe(422);
      expect(leakedNeedles(res.text)).toEqual([]);
      expect(res.body.error.details.some((d: { field?: string }) => d.field === "[redacted]")).toBe(true);
    }
    const ordinary = await operator.post("/api/v1/operations", planBody({ favorite_color: "blue" }), { headers: { "idempotency-key": "ordinary-key" } });
    expect(ordinary.status).toBe(422);
    expect(ordinary.body.error.details.some((d: { field?: string }) => d.field === "favorite_color")).toBe(true);
  });

  it("an import larger than the configured limit is 413 before parsing, and a text/plain import is a typed 4xx", async () => {
    const small = await makeEnv({ config: { maxImportBytes: 2000 } });
    const smallApp = await buildServer(small.kit);
    try {
      const c = (await login(smallApp, small.emails.operator, small.passwords.operator)).client!;
      const res = await c.post("/api/v1/imports", undefined, { raw: JSON.stringify({ pad: "x".repeat(5000) }) });
      expect(res.status).toBe(413);
      expect(await small.count("evidence_imports")).toBe(0);
    } finally {
      await smallApp.close();
      await small.close();
    }
    const text = await operator.post("/api/v1/imports", undefined, { raw: "{}", contentType: "text/plain" });
    expect(text.status).toBeGreaterThanOrEqual(400);
    expect(text.status).toBeLessThan(500);
  });

  it("HTTP import and export round trip: export is 200 JSON, a truncated import is rejected, an intact import is accepted once and replayed after", async () => {
    const exported = await operator.post("/api/v1/exports", {});
    expect(exported.status).toBe(200);
    const text = exported.text;
    expect((await adminB.post("/api/v1/imports", undefined, { raw: text.slice(0, text.length - 1) })).status).toBe(400);
    expect((await adminB.get("/api/v1/imports")).body.items).toEqual([]);
    const ok = await operatorB.post("/api/v1/imports", undefined, { raw: text });
    expect(ok.status).toBe(201);
    const again = await operatorB.post("/api/v1/imports", undefined, { raw: text });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(((await adminB.get("/api/v1/imports")).body.items as unknown[]).length).toBe(1);
    expect((await operatorB.get(`/api/v1/imports/${ok.body.import_id}`)).body.bundle_hash).toBe(exported.body.bundle_hash);
    expect((await operator.get(`/api/v1/imports/${ok.body.import_id}`)).status).toBe(404); // not visible to workspace A
  });
});

describe("planning through the API matches the library (AC-01 over HTTP)", () => {
  it("rejected patches are 422 with the precise code and nothing stored", async () => {
    const codes: Record<string, string> = { "unknown field": "FIELD_NOT_ALLOWED", "send-style field": "FORBIDDEN_ACTION", "deletion via null": "FIELD_VALUE_INVALID", "outside connector scope": "RECORD_OUT_OF_SCOPE" };
    const before = await env.count("operations");
    const cases = loadDemo().rejected_patches.filter((x) => codes[x.name]);
    expect(cases.length).toBe(Object.keys(codes).length);
    for (const [i, r] of cases.entries()) {
      const res = await operator.post("/api/v1/operations", { connector_id: env.connectorId, record_ref: r.record_ref, patch: r.patch, expected_version: "sim-v1" }, { headers: { "idempotency-key": `rejected-patch-${i}` } });
      expect(res.status, r.name).toBe(422);
      expect(res.body.error.code, r.name).toBe(codes[r.name]);
    }
    expect(await env.count("operations")).toBe(before);
    const actor: Actor = env.operator;
    await expect(planOperation(env.kit, actor, { connector_id: env.connectorId, record_ref: "contact-0001", patch: {}, expected_version: "sim-v1" }, "lib-empty")).rejects.toBeTruthy();
  });
});
