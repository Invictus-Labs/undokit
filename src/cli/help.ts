import { EXIT } from "./exit.js";

export const TOP_HELP = `undokit - recover an approved CRM field change without overwriting later work

Usage: undokit <command> [flags]

Commands:
  demo             Run the offline synthetic end-to-end demo and write a static HTML report
  serve            Start the API and web UI (binds to localhost by default)
  admin bootstrap  Create the first admin and workspace (no default password)
  report           Render a static HTML report from a data directory or an evidence bundle
  export           Export a versioned evidence bundle
  verify           Verify an evidence bundle (hashes, version, completeness) without importing it
  import           Verify and import an evidence bundle into a data directory
  version          Print the version

Global flags:
  --help, -h       Show help for a command
  --data-dir DIR   Data directory (default: ./.undokit). Created with owner-only permissions.

Exit codes:
  ${EXIT.OK}  success
  ${EXIT.FAILURE}  failure (verification mismatch, corrupt or unsupported bundle, runtime error)
  ${EXIT.USAGE}  usage error (nothing was done)
  ${EXIT.DISCONNECTED}  a live connector or server is required but not connected (nothing was written)
  ${EXIT.INVALID_INPUT}  input rejected before processing (size, schema, path policy)
  ${EXIT.UNRESOLVED}  command succeeded, but unresolved outcomes (UNKNOWN, CONFLICT, blocked) remain

The deterministic core makes no network calls and sends no telemetry.
Run 'undokit <command> --help' for command flags.
`;

export const COMMAND_HELP: Record<string, string> = {
  demo: `undokit demo [--out DIR] [--data-dir DIR]

Runs a synthetic scenario against a built-in simulator with a fixed UTC clock:
plan -> approve -> apply -> a later edit by someone else -> compensation preview.
One record shows the blocked path (the later edit is kept, nothing is overwritten);
another shows the clean restore path. Prints a summary and writes report.html.
No network, no account, no telemetry. The simulator is not a live provider.

Flags:
  --out DIR        Where to write report.html and evidence.json (default: ./undokit-demo)
  --json           Print the summary as JSON
Exit: 0 when the demo behaved as designed (including the expected blocked path); 1 otherwise.
`,
  serve: `undokit serve [--host ADDR] [--port N] [--data-dir DIR]

Starts the HTTP API and the web UI.

Bind address:
  --host 127.0.0.1 (default)  reachable only from this machine
  --host 0.0.0.0              reachable from every network interface; only use behind
                              a trusted network or reverse proxy with TLS
Open http://localhost:8787 once it is running. Stop with Ctrl-C.
Run 'undokit admin bootstrap' first to create the admin; there is no default password.
`,
  "admin bootstrap": `undokit admin bootstrap --email ADDR [--workspace NAME] [--password-stdin | --password-file PATH] [--data-dir DIR]

Creates the first admin account and workspace. There is no default password: it is
prompted without echo on a terminal, or read from --password-stdin / --password-file.
The password is never accepted as a command-line flag (it would appear in the process list).
`,
  report: `undokit report [--bundle FILE] [--data-dir DIR] [--out FILE]

Renders a static, offline HTML report (no scripts, no external assets). Reads the
given evidence bundle, or the data directory when no bundle is given.
Exit: 0 report written; 5 report written but unresolved outcomes are listed; 4 bad input.
`,
  export: `undokit export --out FILE [--data-dir DIR]

Writes a versioned evidence bundle. The bundle is complete or not written at all.
`,
  verify: `undokit verify FILE

Checks bundle version, structure, size limits and content hashes. Changes nothing.
Exit: 0 verified; 1 hash mismatch, truncated or unsupported; 4 rejected before processing.
`,
  import: `undokit import FILE [--data-dir DIR]

Verifies the bundle first, then imports it in one transaction. A truncated, tampered
or unsupported bundle is rejected and leaves no partial state.
Exit: 0 imported; 1 verification failed; 4 rejected before processing.
`,
  version: `undokit version

Prints the version.
`,
};
