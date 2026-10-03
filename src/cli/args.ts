import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError, EXIT } from "./exit.js";

export type OptionSpec = NonNullable<ParseArgsConfig["options"]>;

export interface ParsedCommand {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** Parse flags for one command; any unknown or malformed flag becomes a usage error (exit 2). */
export function parseFlags(argv: string[], options: OptionSpec, maxPositionals = 0): ParsedCommand {
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: maxPositionals > 0, strict: true });
    if (positionals.length > maxPositionals) {
      throw new CliError(EXIT.USAGE, `Unexpected argument: ${positionals[maxPositionals]}`, "Run with --help for usage.");
    }
    return { values: values as ParsedCommand["values"], positionals };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.USAGE, (error as Error).message, "Run with --help for usage.");
  }
}

export function str(values: ParsedCommand["values"], name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

export function requireStr(values: ParsedCommand["values"], name: string): string {
  const v = str(values, name);
  if (v === undefined || v === "") throw new CliError(EXIT.USAGE, `Missing required flag --${name}`, "Run with --help for usage.");
  return v;
}

export function flag(values: ParsedCommand["values"], name: string): boolean {
  return values[name] === true;
}

/** Integer flag with bounds; rejects non-numeric, fractional and out-of-range values. */
export function intFlag(values: ParsedCommand["values"], name: string, fallback: number, min: number, max: number): number {
  const raw = str(values, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new CliError(EXIT.USAGE, `--${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new CliError(EXIT.USAGE, `--${name} must be between ${min} and ${max}`);
  return n;
}
