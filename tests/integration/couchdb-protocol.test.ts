// PROTOCOL TESTS, NOT LIVE. These exercise src/connectors/couchdb.ts against a small in-process HTTP server that speaks CouchDB's
// documented document protocol (GET/PUT with _rev, 200/201/404/409, Basic auth). They prove the connector's request handling and
// outcome classification. They are NOT a drill against a real CouchDB and NEVER count toward AC-07 (docs/qa/AC-MATRIX.md).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  ConnectorAmbiguousError,
  ConnectorRejectedError,
  ConnectorUnavailableError,
  CouchdbConnector,
  FixedClock,
  KeyRing,
  SequentialIds,
  approveOperation,
  assertOutboundAllowed,
  compensateOperation,
  createCompensationPlan,
  createConnector,
  createUndoKit,
  createWorker,
  createWorkspaceWithAdmin,
  getOperation,
  planOperation,
  requestReconcile,
  type Actor,
} from "../../src/index.js";
import { isLoopbackAddress } from "../../src/connectors/outbound.js";
import { FIXED_NOW_ISO } from "../helpers/fixtures.js";
import { newPassword } from "../helpers/kit.js";

interface Doc {
  n: number;
  fields: Record<string, unknown>;
}

class FakeCouch {
  readonly docs = new Map<string, Doc>();
  /** Documents stored as raw JSON text (as CouchDB keeps them: numbers exact, never round-tripped through float64). */
  readonly raw = new Map<string, { n: number; text: string }>();
  lastPutText = "";
  server!: Server;
  port = 0;
  puts = 0;
  gets = 0;
  lastAuth = "";
  lastPaths: string[] = [];
  getMode: "ok" | "500" | "html" | "array" | "no-rev" | "huge" | "redirect" | "slow" | "401" = "ok";
  putMode: "ok" | "500" | "202" | "400" | "reset-before" | "commit-then-reset" | "no-rev" | "huge" | "redirect" | "slow" = "ok";
  pingStatus = 200;
  beforePut: ((id: string) => void) | undefined;
  readonly user = "sandbox-admin";
  readonly password = "protocol-test-placeholder";

  rev(id: string): string | undefined {
    const r = this.raw.get(id);
    if (r) return `${r.n}-${"b".repeat(8)}`;
    const d = this.docs.get(id);
    return d ? `${d.n}-${"a".repeat(8)}` : undefined;
  }
  seed(id: string, fields: Record<string, unknown>): void {
    this.raw.delete(id);
    this.docs.set(id, { n: 1, fields });
  }
  /** Seed a raw document; `{{rev}}` in the text is replaced by the current revision on every read. */
  seedRaw(id: string, text: string): void {
    this.docs.delete(id);
    this.raw.set(id, { n: 1, text });
  }
  rawText(id: string): string {
    return this.raw.get(id)!.text;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", "x-couch-request-id": "req-fake-1", ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.lastAuth = String(req.headers.authorization ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    this.lastPaths.push(url.pathname);
    const expected = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`;
    if (this.lastAuth !== expected) return this.json(res, 401, { error: "unauthorized" });
    if (url.pathname === "/") return this.json(res, this.pingStatus, { couchdb: "Welcome" });
    const [, db, rawId] = url.pathname.split("/");
    if (db !== "crm" || !rawId) return this.json(res, 404, { error: "not_found" });
    const id = decodeURIComponent(rawId);
    if (req.method === "GET") {
      this.gets += 1;
      if (this.getMode === "500") return this.json(res, 500, { error: "boom" });
      if (this.getMode === "401") return this.json(res, 401, { error: "unauthorized" });
      if (this.getMode === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        return void res.end("<html>proxy</html>");
      }
      if (this.getMode === "array") return this.json(res, 200, [1, 2]);
      if (this.getMode === "huge") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }));
      }
      if (this.getMode === "redirect") {
        res.writeHead(302, { location: "http://203.0.113.9/elsewhere" });
        return void res.end();
      }
      if (this.getMode === "slow") return void setTimeout(() => res.destroyed || this.json(res, 200, {}), 600);
      const r = this.raw.get(id);
      if (r) {
        res.writeHead(200, { "content-type": "application/json", "x-couch-request-id": "req-fake-1" });
        return void res.end(r.text.replace("{{rev}}", this.rev(id)!));
      }
      const d = this.docs.get(id);
      if (!d) return this.json(res, 404, { error: "not_found", reason: "missing" });
      if (this.getMode === "no-rev") return this.json(res, 200, { _id: id, ...d.fields });
      return this.json(res, 200, { _id: id, _rev: this.rev(id), ...d.fields });
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(text) as Record<string, unknown>;
      this.lastPutText = text;
      this.puts += 1;
      this.beforePut?.(id);
      if (this.putMode === "reset-before") return void req.socket.destroy();
      if (this.putMode === "500") return this.json(res, 500, { error: "boom" });
      if (this.putMode === "202") return this.json(res, 202, { ok: true });
      if (this.putMode === "400") return this.json(res, 400, { error: "bad_request" });
      if (this.putMode === "huge") {
        res.writeHead(201, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }));
      }
      if (this.putMode === "redirect") {
        res.writeHead(307, { location: "http://203.0.113.9/elsewhere" });
        return void res.end();
      }
      if (this.putMode === "slow") return void setTimeout(() => res.destroyed || this.json(res, 201, { ok: true, rev: "9-slow" }), 600);
      const rawDoc = this.raw.get(id);
      if (rawDoc) {
        if (body["_rev"] !== this.rev(id)) return this.json(res, 409, { error: "conflict", reason: "Document update conflict." });
        rawDoc.n += 1;
        rawDoc.text = text.replace(JSON.stringify(body["_rev"]), '"{{rev}}"');
        return this.json(res, 201, { ok: true, id, rev: this.rev(id) });
      }
      const current = this.docs.get(id);
      if (!current || body["_rev"] !== this.rev(id)) return this.json(res, 409, { error: "conflict", reason: "Document update conflict." });
      const { _rev: _r, _id: _i, ...fields } = body;
      current.n += 1;
      current.fields = fields;
      if (this.putMode === "commit-then-reset") return void req.socket.destroy();
      if (this.putMode === "no-rev") return this.json(res, 201, { ok: true });
      return this.json(res, 201, { ok: true, id, rev: this.rev(id) });
    }
    return this.json(res, 405, { error: "method_not_allowed" });
  }
}

let couch: FakeCouch;
beforeAll(async () => {
  couch = new FakeCouch();
  await couch.start();
});
afterAll(async () => {
  await couch.stop();
});
afterEach(() => {
  couch.docs.clear();
  couch.raw.clear();
  couch.lastPutText = "";
  couch.getMode = "ok";
  couch.putMode = "ok";
  couch.pingStatus = 200;
  couch.beforePut = undefined;
  couch.puts = 0;
  couch.gets = 0;
  couch.lastPaths = [];
});

const connector = (over: Partial<ConstructorParameters<typeof CouchdbConnector>[0]> = {}) =>
  new CouchdbConnector({
    baseUrl: couch.base,
    database: "crm",
    timeoutMs: 250,
    credentials: { username: couch.user, password: couch.password },
    allowedHosts: ["127.0.0.1"],
    ...over,
  });
const ctx = { requestId: "req-test" };
const reject = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe("protocol test, not live: CouchdbConnector reads", () => {
  it("labels itself a live record store, not a CRM product, and supports atomic conditional writes", () => {
    const c = connector();
    expect(c).toMatchObject({ kind: "couchdb", live: true, supportsAtomicConditionalWrite: true });
    expect(c.label).toMatch(/not a CRM product/);
  });

  it("reads a document: version is the _rev, only top-level scalar members are exposed, provider-internal and nested members are not (their presence is reported)", async () => {
    couch.seed("contact-1", { lifecycle_stage: "lead", lead_score: 40, vip: false, note: null, tags: ["a"], nested: { x: 1 } });
    const rec = await connector().read("contact-1");
    expect(rec).toEqual({ record_ref: "contact-1", version: "1-aaaaaaaa", fields: { lifecycle_stage: "lead", lead_score: 40, vip: false, note: null }, non_scalar_fields: ["tags", "nested"] });
    couch.seed("contact-2", { lifecycle_stage: "lead" });
    expect(await connector().read("contact-2")).toEqual({ record_ref: "contact-2", version: "1-aaaaaaaa", fields: { lifecycle_stage: "lead" } });
  });

  it("sends Basic credentials and URL-encodes the record reference and database", async () => {
    couch.seed("a b/c?d#e", { x: 1 });
    expect(await connector().read("a b/c?d#e")).not.toBeNull();
    expect(couch.lastAuth).toBe(`Basic ${Buffer.from(`${couch.user}:${couch.password}`).toString("base64")}`);
    expect(couch.lastPaths.at(-1)).toBe("/crm/a%20b%2Fc%3Fd%23e");
  });

  it("a missing document is null; every other failure is 'unavailable' (nothing about the record is assumed)", async () => {
    expect(await connector().read("nope")).toBeNull();
    couch.seed("d", { x: 1 });
    for (const mode of ["500", "html", "array", "no-rev", "401", "huge", "redirect"] as const) {
      couch.getMode = mode;
      expect(await reject(connector().read("d")), mode).toBeInstanceOf(ConnectorUnavailableError);
    }
  });

  it("the password never appears in any error message", async () => {
    couch.getMode = "401";
    const err = (await reject(connector().read("d"))) as Error;
    expect(err.message).not.toContain(couch.password);
    const wrong = connector({ credentials: { username: "u", password: "wrong-pw-xyz" } });
    const e2 = (await reject(wrong.read("d"))) as Error;
    expect(e2.message).not.toContain("wrong-pw-xyz");
  });

  it("a slow provider is aborted at the timeout and reported unavailable", async () => {
    couch.getMode = "slow";
    expect(await reject(connector({ timeoutMs: 100 }).read("d"))).toBeInstanceOf(ConnectorUnavailableError);
  });

  it("ping: 200 is fine, any other status or a refused connection is unavailable", async () => {
    await expect(connector().ping()).resolves.toBeUndefined();
    couch.pingStatus = 503;
    expect(await reject(connector().ping())).toBeInstanceOf(ConnectorUnavailableError);
    couch.pingStatus = 200;
    expect(await reject(connector({ baseUrl: "http://127.0.0.1:1", allowedHosts: ["127.0.0.1"] }).ping())).toBeInstanceOf(ConnectorUnavailableError);
  });

  it("a host outside the allowlist is refused before any request is sent", async () => {
    const before = couch.gets;
    expect(await reject(connector({ allowedHosts: ["example.test"] }).read("d"))).toBeInstanceOf(ConnectorUnavailableError);
    expect(couch.gets).toBe(before);
  });
});

describe("protocol test, not live: CouchdbConnector conditional writes", () => {
  it("writes with the expected revision and returns the new one; only patched members change", async () => {
    couch.seed("c", { a: "lead", b: 1 });
    const res = await connector().conditionalWrite("c", { a: "customer" }, "1-aaaaaaaa", ctx);
    expect(res).toEqual({ outcome: "written", new_version: "2-aaaaaaaa", provider_request_id: "req-fake-1" });
    expect(couch.docs.get("c")!.fields).toEqual({ a: "customer", b: 1 });
  });

  it("a stale expected revision is a conflict decided before any PUT is sent (early exit)", async () => {
    couch.seed("c", { a: "lead" });
    const res = await connector().conditionalWrite("c", { a: "x" }, "0-stale", ctx);
    expect(res).toMatchObject({ outcome: "conflict", current_version: "1-aaaaaaaa" });
    expect(couch.puts).toBe(0);
  });

  it("an edit that lands between the connector's read and its PUT is rejected by the provider (409): conflict, the edit is kept", async () => {
    couch.seed("c", { a: "lead" });
    couch.beforePut = (id) => {
      const d = couch.docs.get(id)!;
      d.n += 1;
      d.fields = { a: "someone-else" };
    };
    const res = await connector().conditionalWrite("c", { a: "customer" }, "1-aaaaaaaa", ctx);
    expect(res).toMatchObject({ outcome: "conflict", current_version: "2-aaaaaaaa" });
    expect(couch.docs.get("c")!.fields).toEqual({ a: "someone-else" });
  });

  it("a 409 whose follow-up read fails is still a conflict (version reported as unknown)", async () => {
    couch.seed("c", { a: "lead" });
    couch.beforePut = (id) => {
      couch.docs.get(id)!.n += 1;
      couch.getMode = "500"; // the re-read after the 409 fails
    };
    const res = await connector().conditionalWrite("c", { a: "x" }, "1-aaaaaaaa", ctx);
    expect(res).toMatchObject({ outcome: "conflict", current_version: "unknown" });
  });

  it("a missing record is a definite rejection; a failing read is unavailable (nothing was sent that could change state)", async () => {
    expect(await reject(connector().conditionalWrite("none", { a: 1 }, "1-a", ctx))).toBeInstanceOf(ConnectorRejectedError);
    couch.seed("c", { a: 1 });
    for (const mode of ["500", "no-rev"] as const) {
      couch.getMode = mode;
      expect(await reject(connector().conditionalWrite("c", { a: 2 }, "1-aaaaaaaa", ctx)), mode).toBeInstanceOf(ConnectorUnavailableError);
    }
    expect(couch.puts).toBe(0);
  });

  it("outcomes that may have reached the provider are AMBIGUOUS, never success and never a definite failure", async () => {
    couch.seed("c", { a: "lead" });
    for (const mode of ["500", "202", "reset-before", "no-rev", "huge", "slow"] as const) {
      couch.seed("c", { a: "lead" }); // some modes commit the write; start each from the same revision
      couch.putMode = mode;
      const err = await reject(connector({ timeoutMs: 150 }).conditionalWrite("c", { a: "x" }, "1-aaaaaaaa", ctx));
      expect(err, mode).toBeInstanceOf(ConnectorAmbiguousError);
    }
  });

  it("the provider committed but the response was lost: AMBIGUOUS, and the write really happened once (reconciliation must read, not resend)", async () => {
    couch.seed("c", { a: "lead" });
    couch.putMode = "commit-then-reset";
    const err = await reject(connector().conditionalWrite("c", { a: "customer" }, "1-aaaaaaaa", ctx));
    expect(err).toBeInstanceOf(ConnectorAmbiguousError);
    expect(couch.docs.get("c")!.fields).toEqual({ a: "customer" });
    expect(couch.puts).toBe(1);
  });

  it("a 4xx other than a conflict is a definite rejection with the status; a redirect is never followed", async () => {
    couch.seed("c", { a: "lead" });
    couch.putMode = "400";
    const bad = (await reject(connector().conditionalWrite("c", { a: "x" }, "1-aaaaaaaa", ctx))) as ConnectorRejectedError;
    expect(bad).toBeInstanceOf(ConnectorRejectedError);
    expect(bad.status).toBe(400);
    couch.putMode = "redirect";
    const redirected = (await reject(connector().conditionalWrite("c", { a: "x" }, "1-aaaaaaaa", ctx))) as ConnectorRejectedError;
    expect(redirected.status).toBe(307);
    expect(couch.docs.get("c")!.fields).toEqual({ a: "lead" });
  });

  it("a connection that is refused before the PUT is sent is 'unavailable' (a definite non-effect)", async () => {
    couch.seed("c", { a: "lead" });
    const refusing = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return fetch(url, init);
    }) as typeof fetch;
    expect(await reject(connector({ fetchImpl: refusing }).conditionalWrite("c", { a: "x" }, "1-aaaaaaaa", ctx))).toBeInstanceOf(ConnectorUnavailableError);
  });

  it("an allowlist change between the read and the PUT blocks the write as a definite rejection", async () => {
    couch.seed("c", { a: "lead" });
    const allowed = ["127.0.0.1"];
    const shrinking = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(url, init);
      if (init?.method === "GET") allowed.length = 0; // the operator tightened the allowlist
      return res;
    }) as typeof fetch;
    const err = await reject(connector({ fetchImpl: shrinking, allowedHosts: allowed }).conditionalWrite("c", { a: "x" }, "1-aaaaaaaa", ctx));
    expect(err).toBeInstanceOf(ConnectorRejectedError);
    expect(couch.puts).toBe(0);
  });
  // Round 3: the write must not round-trip the document through JSON.parse/JSON.stringify (float64 corrupts numbers).
  const LOSSLESS_DOC =
    '{"_id":"c","_rev":"{{rev}}","stage":"lead","big":9007199254740993,"huge":1e400,"precise":0.1000000000000000055511151231257827,' +
    '"neg":-12345678901234567890123,"nested":{"id":18446744073709551615,"list":[1,2.50,{"deep":12345678901234567890}],"s":"a\\"b\\u00e9}]"},' +
    '"tags":["x",null,true,1.0e2],"_attachments":{"note.txt":{"content_type":"text/plain","revpos":1,"digest":"md5-abc","length":5,"stub":true}},' +
    '"unknown_future_member":{"k":[]} }';

  it("only the patched member changes: large integers, precision, nested members, _attachments stubs and unknown members are sent back byte for byte", async () => {
    couch.seedRaw("c", LOSSLESS_DOC);
    const res = await connector().conditionalWrite("c", { stage: "customer" }, "1-bbbbbbbb", ctx);
    expect(res).toEqual({ outcome: "written", new_version: "2-bbbbbbbb", provider_request_id: "req-fake-1" });
    const expected = LOSSLESS_DOC.replace('"stage":"lead"', '"stage":"customer"');
    expect(couch.lastPutText).toBe(expected.replace("{{rev}}", "1-bbbbbbbb"));
    expect(couch.rawText("c")).toBe(expected);
    expect(couch.lastPutText).toContain('"big":9007199254740993');
    expect(couch.lastPutText).toContain('"huge":1e400');
    expect(couch.lastPutText).toContain('"id":18446744073709551615');
  });

  it("a patched member that is absent is appended; every existing member is kept verbatim", async () => {
    couch.seedRaw("c", '{"_id":"c","_rev":"{{rev}}","big":9007199254740993}');
    await connector().conditionalWrite("c", { stage: "customer", score: 7, vip: null }, "1-bbbbbbbb", ctx);
    expect(couch.rawText("c")).toBe('{"_id":"c","_rev":"{{rev}}","big":9007199254740993,"stage":"customer","score":7,"vip":null}');
  });

  it("a top-level number float64 cannot hold exactly is never exposed as a (rounded) scalar; it is reported like a nested member", async () => {
    couch.seedRaw("c", '{"_id":"c","_rev":"{{rev}}","score":9007199254740993,"ok":42,"f":1.50,"e":1e2,"tiny":1e-400,"inf":1e400,"neg":-17,"s":"9007199254740993"}');
    const rec = await connector().read("c");
    expect(rec).toEqual({
      record_ref: "c",
      version: "1-bbbbbbbb",
      fields: { ok: 42, f: 1.5, e: 100, neg: -17, s: "9007199254740993" },
      non_scalar_fields: ["score", "tiny", "inf"],
    });
  });

});

describe("protocol test, not live: the full service stack over the connector", () => {
  let kit: Awaited<ReturnType<typeof createUndoKit>>;
  let admin: Actor;
  let connectorId: string;
  beforeAll(async () => {
    kit = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()), clock: new FixedClock(FIXED_NOW_ISO), ids: new SequentialIds("bbbbbbbb"), config: { allowedHosts: ["127.0.0.1"] } });
    const ws = await createWorkspaceWithAdmin(kit, { email: "couch-admin@example.test", password: newPassword(), workspace_name: "Protocol Test" });
    admin = { workspace_id: ws.workspace_id, user_id: ws.user_id, role: "admin" };
    const view = await createConnector(kit, admin, {
      kind: "couchdb",
      name: "fake-couch",
      policy: { allowed_fields: [{ name: "stage", type: "string", max_length: 16, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
      config: { base_url: couch.base, database: "crm", timeout_ms: 500 },
      credentials: { username: couch.user, password: couch.password },
    });
    connectorId = view.id;
    expect(view.live).toBe(true);
  }, 60_000);
  afterAll(async () => {
    await kit.close();
  });

  const plan = async (patch: Record<string, unknown>) => {
    const rev = couch.rev("contact-1")!;
    const p = await planOperation(kit, admin, { connector_id: connectorId, record_ref: "contact-1", patch, expected_version: rev }, `k-${kit.ids.next()}`);
    await approveOperation(kit, admin, p.body.id, { plan_hash: p.body.plan_hash, expected_version: rev });
    return p.body.id;
  };

  it("plan, approve, apply and compensate through the provider protocol; the provider's revision is the version", async () => {
    couch.seed("contact-1", { stage: "lead" });
    const worker = createWorker(kit, { workerId: "couch-worker" });
    const id = await plan({ stage: "customer" });
    await worker.runOnce();
    const op = await getOperation(kit, admin, id);
    expect(op.state).toBe("applied");
    expect(op.observed_version).toBe("2-aaaaaaaa");
    expect(couch.docs.get("contact-1")!.fields).toEqual({ stage: "customer" });
    const cp = await createCompensationPlan(kit, admin, id);
    expect(cp.state).toBe("planned");
    await compensateOperation(kit, admin, id, { plan_hash: cp.plan_hash });
    await worker.runOnce();
    expect(couch.docs.get("contact-1")!.fields).toEqual({ stage: "lead" });
    expect(couch.puts).toBe(2);
  });

  it("a later edit at the provider blocks the compensation and is never overwritten", async () => {
    couch.seed("contact-1", { stage: "lead" });
    const worker = createWorker(kit, { workerId: "couch-worker-2" });
    const id = await plan({ stage: "customer" });
    await worker.runOnce();
    const d = couch.docs.get("contact-1")!;
    d.n += 1;
    d.fields = { stage: "partner" };
    const cp = await createCompensationPlan(kit, admin, id);
    expect(cp.state).toBe("conflict");
    expect(couch.docs.get("contact-1")!.fields).toEqual({ stage: "partner" });
    expect(couch.puts).toBe(1);
  });

  it("a response lost after the provider committed is UNKNOWN, then read-only reconciliation resolves it with one write", async () => {
    couch.seed("contact-1", { stage: "lead" });
    const worker = createWorker(kit, { workerId: "couch-worker-3" });
    couch.putMode = "commit-then-reset";
    const id = await plan({ stage: "customer" });
    await worker.runOnce();
    expect((await getOperation(kit, admin, id)).state).toBe("unknown");
    couch.putMode = "ok";
    await requestReconcile(kit, admin, id);
    await worker.runOnce();
    expect((await getOperation(kit, admin, id)).state).toBe("applied");
    expect(couch.puts).toBe(1);
  });

  it("an allowlisted field whose current value is nested (object/array) is refused at planning: it would be recorded as before=null and lost on undo", async () => {
    for (const nested of [{ code: "lead", since: 2020 }, ["lead", "mql"]]) {
      couch.seed("contact-1", { stage: nested });
      const rev = couch.rev("contact-1")!;
      const err = await planOperation(kit, admin, { connector_id: connectorId, record_ref: "contact-1", patch: { stage: "customer" }, expected_version: rev }, `k-${kit.ids.next()}`).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("NON_SCALAR_VALUE");
      expect((err as AppError).details?.map((d) => d.field)).toEqual(["stage"]);
      expect(couch.docs.get("contact-1")!.fields).toEqual({ stage: nested });
      expect(couch.puts).toBe(0);
    }
  });

  it("an edit planted between the connector's read and PUT makes the apply a CONFLICT with the edit kept", async () => {
    couch.seed("contact-1", { stage: "lead" });
    const worker = createWorker(kit, { workerId: "couch-worker-4" });
    const id = await plan({ stage: "customer" });
    couch.beforePut = (docId) => {
      const d = couch.docs.get(docId)!;
      d.n += 1;
      d.fields = { stage: "churned" };
    };
    await worker.runOnce();
    expect((await getOperation(kit, admin, id)).state).toBe("conflict");
    expect(couch.docs.get("contact-1")!.fields).toEqual({ stage: "churned" });
  });

  it("apply and compensate leave every member outside the patch byte-identical (large integers, nested members, _attachments stubs)", async () => {
    const original =
      '{"_id":"contact-1","_rev":"{{rev}}","stage":"lead","account_id":9007199254740993,"tags":["a",{"since":18446744073709551615}],' +
      '"meta":{"x":1,"ratio":0.1000000000000000055511151231257827},"_attachments":{"c.txt":{"content_type":"text/plain","revpos":1,"digest":"md5-x","length":1,"stub":true}}}';
    couch.seedRaw("contact-1", original);
    const worker = createWorker(kit, { workerId: "couch-worker-lossless" });
    const id = await plan({ stage: "customer" });
    await worker.runOnce();
    expect((await getOperation(kit, admin, id)).state).toBe("applied");
    expect(couch.rawText("contact-1")).toBe(original.replace('"stage":"lead"', '"stage":"customer"'));
    const cp = await createCompensationPlan(kit, admin, id);
    expect(cp.state).toBe("planned");
    await compensateOperation(kit, admin, id, { plan_hash: cp.plan_hash });
    await worker.runOnce();
    expect(couch.rawText("contact-1")).toBe(original);
    expect(couch.puts).toBe(2);
  });

  it("an allowlisted field holding a number float64 cannot represent exactly is refused at planning (a rounded before value would corrupt the undo)", async () => {
    couch.seedRaw("contact-1", '{"_id":"contact-1","_rev":"{{rev}}","stage":9007199254740993}');
    const rev = couch.rev("contact-1")!;
    const err = await planOperation(kit, admin, { connector_id: connectorId, record_ref: "contact-1", patch: { stage: "customer" }, expected_version: rev }, `k-${kit.ids.next()}`).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("NON_SCALAR_VALUE");
    expect((err as AppError).details?.map((d) => d.field)).toEqual(["stage"]);
    expect(couch.puts).toBe(0);
  });

  it("creating a connector whose host is not allowlisted is refused and nothing is stored", async () => {
    const before = (await kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM connectors")).rows[0]!.n;
    await expect(
      createConnector(kit, admin, {
        kind: "couchdb",
        name: "outside",
        policy: { allowed_fields: [{ name: "stage", type: "string", max_length: 16, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
        config: { base_url: "http://203.0.113.9:5984", database: "crm" },
        credentials: { username: "u", password: "p-placeholder" },
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect((await kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM connectors")).rows[0]!.n).toBe(before);
  });
});

describe("outbound allowlist (SSRF guard) branches", () => {
  const resolveTo = (...addresses: string[]) => async () => addresses;
  const code = async (p: Promise<unknown>) => ((await reject(p)) as AppError | undefined)?.details?.[0]?.code;

  it("isLoopbackAddress recognises IPv4 and IPv6 loopback forms only", () => {
    for (const a of ["127.0.0.1", "127.255.0.9", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::FFFF:127.0.0.1"]) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ["10.0.0.1", "128.0.0.1", "::2", "example.test", "169.254.169.254"]) expect(isLoopbackAddress(a), a).toBe(false);
  });

  it("rejects an invalid URL, a non-http scheme, embedded credentials and a host that is not allowlisted", async () => {
    expect(await code(assertOutboundAllowed("not a url"))).toBe("OUTBOUND_URL_INVALID");
    expect(await code(assertOutboundAllowed("ftp://127.0.0.1/"))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://user:pw@127.0.0.1/"))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://example.test/"))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://127.0.0.1.evil.test/"))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
  });

  it("accepts loopback names and literals by default, including bracketed IPv6", async () => {
    for (const u of ["http://127.0.0.1:5984", "http://localhost:5984", "https://localhost/", "http://[::1]:5984/db"]) {
      expect((await assertOutboundAllowed(u, undefined, resolveTo("127.0.0.1"))).url.href).toBe(new URL(u).href);
    }
  });

  it("an allowlisted NAME must resolve to loopback unless the operator allowlisted a non-loopback host; a failed or empty resolution is rejected", async () => {
    expect(await code(assertOutboundAllowed("http://localhost/", ["localhost"], resolveTo("203.0.113.9")))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://localhost/", ["localhost"], resolveTo()))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://localhost/", ["localhost"], async () => Promise.reject(new Error("dns down"))))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect((await assertOutboundAllowed("http://couch.internal:5984/", ["couch.internal"], resolveTo("10.1.2.3"))).url.hostname).toBe("couch.internal");
  });

  it("link-local and metadata addresses are blocked unless that literal IP is itself allowlisted", async () => {
    expect(await code(assertOutboundAllowed("http://couch.internal/", ["couch.internal"], resolveTo("169.254.169.254")))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://169.254.169.254/", ["169.254.169.254", "127.0.0.1"]))).toBeUndefined();
    expect(await code(assertOutboundAllowed("http://couch.internal/", ["couch.internal"], resolveTo("fe80::1")))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://couch.internal/", ["couch.internal"], resolveTo("0.0.0.0")))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
  });

  it("a literal non-loopback IP is accepted only when it is the allowlisted entry", async () => {
    expect(await code(assertOutboundAllowed("http://10.9.9.9/", ["127.0.0.1"]))).toBe("OUTBOUND_HOST_NOT_ALLOWED");
    expect(await code(assertOutboundAllowed("http://10.9.9.9/", ["10.9.9.9"]))).toBeUndefined();
  });
});
