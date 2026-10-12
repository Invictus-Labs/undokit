import { startServer } from "../index.js";
import { intFlag, parseFlags, str } from "./args.js";
import type { CommandContext } from "./context.js";
import { EXIT } from "./exit.js";
import { acquireDataLock, assertKeyLocation, configFor, toCliError } from "./kit.js";

export async function serveCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseFlags(argv, { host: { type: "string" }, port: { type: "string" }, "data-dir": { type: "string" } });
  const base = configFor(str(values, "data-dir"), ctx.env);
  const host = str(values, "host") ?? base.host;
  const port = intFlag(values, "port", base.port, 0, 65535);
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  // The cookie policy depends on the bind address, so it is recomputed when --host overrides the environment.
  const cookieSecure = ctx.env["UNDOKIT_COOKIE_SECURE"] !== undefined ? base.cookieSecure : !loopback;
  assertKeyLocation(base);
  const release = acquireDataLock(base.databaseUrl);
  let running;
  try {
    running = await startServer({ ...base, host, port, cookieSecure });
  } catch (error) {
    release();
    throw toCliError(error);
  }
  try {
    const shown = new URL(running.url);
    if (loopback) shown.hostname = "localhost";
    ctx.out(`UndoKit is running at ${shown.origin}\n`);
    ctx.out(loopback ? "Bound to this machine only. Stop with Ctrl-C.\n" : `WARNING: bound to ${host}, reachable from the network. UndoKit does not terminate TLS; use a trusted network or a TLS reverse proxy.\n`);
    if (!running.kit.readiness.ok) ctx.err(`WARNING: the database is not ready (${running.kit.readiness.error ?? "migration did not complete"}). The API refuses requests until this is fixed.\n`);
    const users = await running.kit.db.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    if ((users.rows[0]?.n ?? 0) === 0) ctx.out("No admin exists yet. The embedded database is single-process: stop this server, run 'undokit admin bootstrap --email ADDR', then start it again.\n");
    await ctx.waitForStop();
    ctx.out("Stopping...\n");
  } finally {
    await running.close();
    release();
  }
  return EXIT.OK;
}
