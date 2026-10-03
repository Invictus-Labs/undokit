// Shared in-process CLI harness (QA-owned): injected streams, env, stdin and TTY flag for src/cli/run.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyRing, SequentialIds, approveOperation, bootstrapAdmin, compensateOperation, createCompensationPlan, createConnector, createUndoKit, createWorker, planOperation, type Actor } from "../../src/index.js";
import type { CommandContext } from "../../src/cli/context.js";
import { run } from "../../src/cli/run.js";
import { demoPolicy } from "./policy.js";
import { loadDemo } from "./fixtures.js";
import { newPassword } from "./kit.js";

export function makeCtx(over: Partial<CommandContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    env: {},
    stdin: async () => "",
    isTTY: false,
    prompt: async () => {
      throw new Error("no prompt expected");
    },
    waitForStop: async () => undefined,
    ...over,
  };
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

export async function cli(argv: string[], over: Partial<CommandContext> = {}) {
  const c = makeCtx(over);
  const code = await run(argv, c.ctx);
  return { code, out: c.out(), err: c.err() };
}

const dirs: string[] = [];
export function tmpDir(prefix = "undokit-cli-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
export function cleanTmp(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Bootstrap an admin through the CLI itself (password on stdin). Returns the password. */
export async function bootstrapViaCli(dir: string, email = "cli-admin@example.test", workspace = "Synthetic CLI"): Promise<string> {
  const password = newPassword();
  const r = await cli(["admin", "bootstrap", "--email", email, "--workspace", workspace, "--password-stdin", "--data-dir", dir], { stdin: async () => `${password}\n` });
  if (r.code !== 0) throw new Error(`bootstrap failed: ${r.err}`);
  return password;
}

/**
 * Populate a bootstrapped data directory with real operations through the library: one applied then compensated, one UNKNOWN
 * (lost response) and one applied. The directory's key file is used, exactly as a daemon would.
 */
export async function populateDataDir(dir: string): Promise<{ actor: Actor; ids: string[] }> {
  const kit = await createUndoKit({ databaseUrl: `pglite://${dir}/db`, keyring: KeyRing.fromFile(join(dir, "undokit.key")), ids: new SequentialIds("eeeeeeee") });
  try {
    const members = await kit.db.query<{ workspace_id: string; user_id: string }>("SELECT workspace_id, user_id FROM memberships WHERE role = 'admin' LIMIT 1");
    const actor: Actor = { workspace_id: members.rows[0]!.workspace_id, user_id: members.rows[0]!.user_id, role: "admin" };
    const demo = loadDemo();
    const connector = await createConnector(kit, actor, {
      kind: "simulator",
      name: "cli-sim",
      policy: demoPolicy(),
      config: { seed_records: demo.records.map((r) => ({ record_ref: r.record_ref, fields: r.fields })) },
    });
    const sim = kit.connectors.simulator(connector.id);
    const worker = createWorker(kit, { workerId: "populate" });
    const ids: string[] = [];
    const apply = async (record: string, patch: Record<string, unknown>) => {
      const version = sim.snapshot(record)!.version;
      const plan = await planOperation(kit, actor, { connector_id: connector.id, record_ref: record, patch, expected_version: version }, `pop-${kit.ids.next()}`);
      await approveOperation(kit, actor, plan.body.id, { plan_hash: plan.body.plan_hash, expected_version: version });
      await worker.runOnce();
      ids.push(plan.body.id);
      return plan.body.id;
    };
    const restored = await apply("contact-0001", { lifecycle_stage: "customer" });
    const cp = await createCompensationPlan(kit, actor, restored);
    await compensateOperation(kit, actor, restored, { plan_hash: cp.plan_hash });
    await worker.runOnce();
    sim.failNextWrite("ambiguous_after_commit");
    await apply("contact-0002", { lead_score: 77 });
    return { actor, ids };
  } finally {
    await kit.close();
  }
}

export { bootstrapAdmin };
