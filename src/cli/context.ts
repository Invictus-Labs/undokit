import type { Streams } from "./io.js";

/** What a command needs from its caller; tests pass fakes, the binary passes the process. */
export interface CommandContext extends Streams {
  env: Record<string, string | undefined>;
  /** Read all of stdin (only used by --password-stdin). */
  stdin: () => Promise<string>;
  isTTY: boolean;
  /** Prompt for a secret without echo (only used when no --password-stdin/--password-file is given). */
  prompt: (label: string) => Promise<string>;
  /** Resolves when the process is asked to stop (serve). */
  waitForStop: () => Promise<void>;
}
