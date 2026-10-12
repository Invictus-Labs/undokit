import { readFileSync, statSync } from "node:fs";
import { bootstrapAdmin } from "../index.js";
import { flag, parseFlags, requireStr, str } from "./args.js";
import type { CommandContext } from "./context.js";
import { CliError, EXIT } from "./exit.js";
import { configFor, openKit, toCliError } from "./kit.js";

async function readPassword(values: ReturnType<typeof parseFlags>["values"], ctx: CommandContext): Promise<string> {
  const file = str(values, "password-file");
  const fromStdin = flag(values, "password-stdin");
  if (file !== undefined && fromStdin) throw new CliError(EXIT.USAGE, "Use either --password-file or --password-stdin, not both");
  let raw: string;
  if (file !== undefined) {
    try {
      const mode = statSync(file).mode;
      if ((mode & 0o077) !== 0) ctx.err(`Warning: ${file} is readable by other users; restrict it with chmod 600.\n`);
      raw = readFileSync(file, "utf8");
    } catch {
      throw new CliError(EXIT.INVALID_INPUT, `Cannot read the password file ${file}`);
    }
  } else if (fromStdin) {
    raw = await ctx.stdin();
  } else {
    if (!ctx.isTTY) throw new CliError(EXIT.USAGE, "No terminal available to prompt for a password", "Use --password-stdin or --password-file. A password is never accepted as a flag.");
    const first = await ctx.prompt("Password");
    const second = await ctx.prompt("Confirm password");
    if (first !== second) throw new CliError(EXIT.USAGE, "The passwords did not match; nothing was created");
    raw = first;
  }
  // Only the trailing newline of a file or pipe is dropped; spaces inside or around a passphrase are kept.
  return raw.replace(/\r?\n$/, "");
}

export async function adminCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "bootstrap") throw new CliError(EXIT.USAGE, sub ? `Unknown admin command: ${sub}` : "Missing admin command", "Usage: undokit admin bootstrap --email ADDR");
  const { values } = parseFlags(rest, {
    email: { type: "string" },
    workspace: { type: "string" },
    "password-stdin": { type: "boolean" },
    "password-file": { type: "string" },
    "data-dir": { type: "string" },
  });
  const email = requireStr(values, "email");
  const workspaceName = str(values, "workspace") ?? "Default Workspace";
  const password = await readPassword(values, ctx);
  const opened = await openKit(configFor(str(values, "data-dir"), ctx.env), { create: true });
  try {
    const created = await bootstrapAdmin(opened.kit, { email, password, workspace_name: workspaceName });
    ctx.out(`Created workspace "${workspaceName}" and its admin ${email.trim().toLowerCase()}.\n  workspace_id  ${created.workspace_id}\nStart the daemon with: undokit serve\n`);
    return EXIT.OK;
  } catch (error) {
    throw toCliError(error);
  } finally {
    await opened.close();
  }
}
