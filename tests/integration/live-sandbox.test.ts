// LIVE SANDBOX DRILL (AC-07). Opt-in: UNDOKIT_LIVE_SANDBOX=1 with the local CouchDB from compose.yaml (`docker compose --profile sandbox
// up -d`) running on 127.0.0.1. Credentials come from the environment (UNDOKIT_SANDBOX_COUCHDB_USER / _PASSWORD / _PORT); nothing is
// hardcoded. Without the opt-in this whole file is skipped and the gate reports AC-07 NOT RUN. The provider is real Apache CouchDB: the
// test refuses to run against anything that does not identify itself as CouchDB, and it only ever creates and deletes its own database.
// "Planted" edits are made directly against the provider, outside UndoKit, to prove that a third party's change is never overwritten.
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  FixedClock,
  KeyRing,
  SequentialIds,
  approveOperation,
  compensateOperation,
  createCompensationPlan,
  createConnector,
  createUndoKit,
  createWorker,
  createWorkspaceWithAdmin,
  getOperation,
  planOperation,
  type Actor,
} from "../../src/index.js";
import { FIXED_NOW_ISO } from "../helpers/fixtures.js";
import { newPassword } from "../helpers/kit.js";

const LIVE = process.env["UNDOKIT_LIVE_SANDBOX"] === "1";
const USER = process.env["UNDOKIT_SANDBOX_COUCHDB_USER"] ?? "";
const PASS = process.env["UNDOKIT_SANDBOX_COUCHDB_PASSWORD"] ?? "";
const PORT = process.env["UNDOKIT_SANDBOX_COUCHDB_PORT"] ?? "15984";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `undokit_sandbox_drill_${Date.now()}`;
const RECEIPT = process.env["UNDOKIT_LIVE_RECEIPT"];

const auth = { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`, "content-type": "application/json" };
async function couch(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const getDoc = async (id: string) => (await couch("GET", `/${DB}/${id}`)).json;
async function seed(id: string, fields: Record<string, unknown>): Promise<string> {
  const r = await couch("PUT", `/${DB}/${id}`, fields);
  expect(r.status).toBe(201);
  return String(r.json["rev"]);
}
/** A third party edits the record directly at the provider, outside UndoKit. */
async function plant(id: string, fields: Record<string, unknown>): Promise<string> {
  const cur = await getDoc(id);
  const r = await couch("PUT", `/${DB}/${id}`, { ...fields, _rev: cur["_rev"] });
  expect(r.status).toBe(201);
  return String(r.json["rev"]);
}

const observed: Record<string, unknown> = { database: DB };

describe.skipIf(!LIVE)("LIVE sandbox drill against a real local Apache CouchDB (AC-07)", () => {
  let kit: Awaited<ReturnType<typeof createUndoKit>>;
  let admin: Actor;
  let connectorId: string;

  beforeAll(async () => {
    expect(USER, "UNDOKIT_SANDBOX_COUCHDB_USER must be set").not.toBe("");
    expect(PASS, "UNDOKIT_SANDBOX_COUCHDB_PASSWORD must be set").not.toBe("");
    const root = await couch("GET", "/");
    expect(root.status).toBe(200);
    expect(String(root.json["couchdb"])).toBe("Welcome");
    expect(String((root.json["vendor"] as { name?: string } | undefined)?.name)).toMatch(/Apache/);
    observed["provider_version"] = root.json["version"];
    expect((await couch("PUT", `/${DB}`)).status).toBe(201);
    kit = await createUndoKit({ databaseUrl: "memory://", keyring: KeyRing.fromBase64(KeyRing.generateKeyText()), clock: new FixedClock(FIXED_NOW_ISO), ids: new SequentialIds("cccccccc"), config: { allowedHosts: ["127.0.0.1"] } });
    const ws = await createWorkspaceWithAdmin(kit, { email: "live-drill@example.test", password: newPassword(), workspace_name: "Live Drill" });
    admin = { workspace_id: ws.workspace_id, user_id: ws.user_id, role: "admin" };
    const view = await createConnector(kit, admin, {
      kind: "couchdb",
      name: "local-couchdb-sandbox",
      policy: { allowed_fields: [{ name: "stage", type: "string", max_length: 16, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
      config: { base_url: BASE, database: DB, timeout_ms: 5000 },
      credentials: { username: USER, password: PASS },
    });
    connectorId = view.id;
    expect(view.live).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await kit?.close();
    if (LIVE) await couch("DELETE", `/${DB}`); // only the database this run created
    if (RECEIPT) writeFileSync(RECEIPT, JSON.stringify(observed, null, 2));
  });

  const plan = async (id: string, patch: Record<string, unknown>, rev: string) => {
    const p = await planOperation(kit, admin, { connector_id: connectorId, record_ref: id, patch, expected_version: rev }, `k-${kit.ids.next()}`);
    await approveOperation(kit, admin, p.body.id, { plan_hash: p.body.plan_hash, expected_version: rev });
    return p.body.id;
  };
  const worker = () => createWorker(kit, { workerId: `live-${kit.ids.next()}` });

  it("changes an allowlisted field at the real provider and restores the original value through approved compensation, leaving other members untouched", async () => {
    const rev0 = await seed("contact-0001", { stage: "lead", untouched: "keep-me" });
    const id = await plan("contact-0001", { stage: "customer" }, rev0);
    await worker().runOnce();
    const op = await getOperation(kit, admin, id);
    expect(op.state).toBe("applied");
    const after = await getDoc("contact-0001");
    expect(after["stage"]).toBe("customer");
    expect(after["untouched"]).toBe("keep-me");
    expect(after["_rev"]).not.toBe(rev0);
    expect(op.observed_version).toBe(after["_rev"]); // the provider's real revision is the version of record
    const cp = await createCompensationPlan(kit, admin, id);
    expect(cp.state).toBe("planned");
    await compensateOperation(kit, admin, id, { plan_hash: cp.plan_hash });
    await worker().runOnce();
    const restored = await getDoc("contact-0001");
    expect(restored["stage"]).toBe("lead");
    expect(restored["untouched"]).toBe("keep-me");
    observed["happy_path"] = { rev_before: rev0, rev_applied: after["_rev"], rev_restored: restored["_rev"], state: op.state };
  }, 60_000);

  it("NEGATIVE CONTROL: a third-party edit planted after the apply blocks compensation and stays intact", async () => {
    const rev0 = await seed("contact-0002", { stage: "lead" });
    const id = await plan("contact-0002", { stage: "customer" }, rev0);
    await worker().runOnce();
    expect((await getOperation(kit, admin, id)).state).toBe("applied");
    const plantedRev = await plant("contact-0002", { stage: "partner" });
    const cp = await createCompensationPlan(kit, admin, id);
    expect(cp.state).toBe("conflict");
    await expect(compensateOperation(kit, admin, id, { plan_hash: cp.plan_hash })).rejects.toBeInstanceOf(AppError);
    await worker().runOnce();
    const doc = await getDoc("contact-0002");
    expect(doc["stage"]).toBe("partner");
    expect(doc["_rev"]).toBe(plantedRev); // no write after the planted edit
    observed["planted_after_apply"] = { compensation_plan_state: cp.state, planted_rev: plantedRev, final_rev: doc["_rev"] };
  }, 60_000);

  it("NEGATIVE CONTROL: a third-party edit planted between approval and apply makes the apply a conflict and stays intact", async () => {
    const rev0 = await seed("contact-0003", { stage: "lead" });
    const id = await plan("contact-0003", { stage: "customer" }, rev0);
    const plantedRev = await plant("contact-0003", { stage: "churned" });
    await worker().runOnce();
    expect((await getOperation(kit, admin, id)).state).toBe("conflict");
    const doc = await getDoc("contact-0003");
    expect(doc["stage"]).toBe("churned");
    expect(doc["_rev"]).toBe(plantedRev);
    observed["planted_before_apply"] = { state: "conflict", planted_rev: plantedRev, final_rev: doc["_rev"] };
  }, 60_000);
});
