import { COMMAND_HELP, TOP_HELP } from "./help.js";
import { CliError, EXIT } from "./exit.js";
import { packageVersion, type Streams } from "./io.js";
import type { CommandContext } from "./context.js";

type Handler = (argv: string[], ctx: CommandContext) => Promise<number>;

const HANDLERS: Record<string, () => Promise<Handler>> = {
  demo: async () => (await import("./demo.js")).demoCommand,
  serve: async () => (await import("./serve.js")).serveCommand,
  admin: async () => (await import("./admin.js")).adminCommand,
  report: async () => (await import("./data.js")).reportCommand,
  export: async () => (await import("./data.js")).exportCommand,
  verify: async () => (await import("./data.js")).verifyCommand,
  import: async () => (await import("./data.js")).importCommand,
};

function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** Run one CLI invocation and return its exit code. Never throws: failures become a printed message and a code. */
export async function run(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === undefined) {
      ctx.err(TOP_HELP);
      return EXIT.USAGE;
    }
    if (command === "--help" || command === "-h" || command === "help") {
      ctx.out(TOP_HELP);
      return EXIT.OK;
    }
    if (command === "--version" || command === "-v" || (command === "version" && !wantsHelp(rest))) {
      ctx.out(`${packageVersion()}\n`);
      return EXIT.OK;
    }
    if (command === "version") {
      ctx.out(COMMAND_HELP["version"] ?? TOP_HELP);
      return EXIT.OK;
    }
    const load = HANDLERS[command];
    if (!load) throw new CliError(EXIT.USAGE, `Unknown command: ${command}`, "Run 'undokit --help' for the command list.");
    if (wantsHelp(rest)) {
      const key = command === "admin" ? "admin bootstrap" : command;
      ctx.out(COMMAND_HELP[key] ?? TOP_HELP);
      return EXIT.OK;
    }
    return await (await load())(rest, ctx);
  } catch (error) {
    const failure = error instanceof CliError ? error : await mapUnexpected(error);
    ctx.err(`undokit: ${failure.message}\n${failure.hint ? `${failure.hint}\n` : ""}`);
    return failure.exitCode;
  }
}

async function mapUnexpected(error: unknown): Promise<CliError> {
  // The library is loaded only when something went wrong in a command that already loaded it.
  const { toCliError } = await import("./kit.js");
  return toCliError(error);
}

export type { Streams };
