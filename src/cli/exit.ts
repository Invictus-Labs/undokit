/** Process exit codes for the `undokit` CLI. Documented in `undokit --help`. */
export const EXIT = {
  /** Command completed and, where it verifies something, the check passed. */
  OK: 0,
  /** Command ran but failed: verification mismatch, corrupt or unsupported bundle, runtime error. */
  FAILURE: 1,
  /** Bad command line: unknown command, missing or invalid flag. Nothing was done. */
  USAGE: 2,
  /** A live connector or the server was needed but is not connected or configured. Nothing was written. */
  DISCONNECTED: 3,
  /** Input rejected before processing (size, schema, path policy). Nothing was imported or written. */
  INVALID_INPUT: 4,
  /** The command succeeded but unresolved outcomes (UNKNOWN, CONFLICT, blocked) remain in the data it reported on. */
  UNRESOLVED: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Error carrying the exit code and a message safe to print. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
