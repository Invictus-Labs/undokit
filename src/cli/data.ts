import { exportBundle, getImport, importBundle, importBundleIntoCleanInstall, listImports, verifyBundleText, type EvidenceBundle, type OperationView } from "../index.js";
import { reportInputFromBundle } from "../report/from-bundle.js";
import { needsAttention, renderReport, type ReportInput } from "../report/render.js";
import { parseFlags, requireStr, str } from "./args.js";
import type { CommandContext } from "./context.js";
import { CliError, EXIT } from "./exit.js";
import { readInputFile, writeOutputFile } from "./io.js";
import { configFor, localActor, openKit, toCliError } from "./kit.js";

/** Bundles are bounded before they are read; the library enforces the same default again. */
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;

export async function verifyCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals } = parseFlags(argv, {}, 1);
  const file = positionals[0];
  if (!file) throw new CliError(EXIT.USAGE, "Missing bundle file", "Usage: undokit verify FILE");
  const text = readInputFile(file, MAX_BUNDLE_BYTES);
  try {
    const bundle = verifyBundleText(text);
    ctx.out(`Verified ${file}\n  bundle_id    ${bundle.bundle_id}\n  schema       ${bundle.schema_version}\n  files        ${bundle.manifest.file_count}\n  bundle_hash  ${bundle.bundle_hash}\nAll content hashes match.\n`);
    return EXIT.OK;
  } catch (error) {
    throw toCliError(error);
  }
}

export async function exportCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseFlags(argv, { out: { type: "string" }, "data-dir": { type: "string" }, workspace: { type: "string" } });
  const out = requireStr(values, "out");
  const opened = await openKit(configFor(str(values, "data-dir"), ctx.env), { create: false });
  try {
    const actor = await localActor(opened.kit, str(values, "workspace"));
    if (!actor) throw new CliError(EXIT.FAILURE, "Nothing to export: no workspace exists in this data directory", "Run 'undokit admin bootstrap' first, or import a bundle.");
    const bundle = await exportBundle(opened.kit, actor, {});
    // Verify our own output before it is written so a bundle that would not verify never lands on disk.
    verifyBundleText(JSON.stringify(bundle));
    writeOutputFile(out, `${JSON.stringify(bundle)}\n`);
    ctx.out(`Exported ${bundle.manifest.file_count} operation(s) to ${out}\n  bundle_hash  ${bundle.bundle_hash}\nThe bundle is redacted. Check it with: undokit verify ${out}\n`);
    if (bundle.manifest.file_count === 0) ctx.out("This data directory has no operations of its own to export (imported bundles are not re-exported).\n");
    return EXIT.OK;
  } catch (error) {
    throw toCliError(error);
  } finally {
    await opened.close();
  }
}

export async function importCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const { values, positionals } = parseFlags(argv, { "data-dir": { type: "string" }, workspace: { type: "string" } }, 1);
  const file = positionals[0];
  if (!file) throw new CliError(EXIT.USAGE, "Missing bundle file", "Usage: undokit import FILE [--data-dir DIR]");
  const text = readInputFile(file, MAX_BUNDLE_BYTES);
  // Verify before the data directory is even opened: a bad bundle must leave no state behind.
  try {
    verifyBundleText(text);
  } catch (error) {
    throw toCliError(error);
  }
  const opened = await openKit(configFor(str(values, "data-dir"), ctx.env), { create: true });
  try {
    const workspace = str(values, "workspace");
    const actor = await localActor(opened.kit, workspace);
    if (workspace && !actor) throw new CliError(EXIT.INVALID_INPUT, "That workspace does not exist in this data directory");
    // With a workspace the bundle goes in as that workspace's member; a clean installation gets a
    // library-created workspace owned by a system actor that nobody can sign in as.
    const result = actor ? await importBundle(opened.kit, actor, text) : await importBundleIntoCleanInstall(opened.kit, text);
    ctx.out(
      `${result.replayed ? "Already imported" : "Imported"} ${file}\n  bundle_id    ${result.bundle_id}\n  files        ${result.file_count}\n  bundle_hash  ${result.bundle_hash}\nRead it with: undokit report --data-dir <dir>\n`,
    );
    return EXIT.OK;
  } catch (error) {
    throw toCliError(error);
  } finally {
    await opened.close();
  }
}

function mergeOperations(bundles: EvidenceBundle[], native: OperationView[]): OperationView[] {
  const byId = new Map<string, OperationView>();
  for (const op of native) byId.set(op.id, op);
  for (const bundle of bundles) for (const doc of Object.values(bundle.files)) if (!byId.has(doc.operation.id)) byId.set(doc.operation.id, doc.operation);
  return [...byId.values()].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
}

async function reportFromDataDir(ctx: CommandContext, dataDir: string | undefined, workspace: string | undefined): Promise<ReportInput> {
  const opened = await openKit(configFor(dataDir, ctx.env), { create: false });
  try {
    const actor = await localActor(opened.kit, workspace);
    if (!actor) {
      return { generated_at: opened.kit.clock.now().toISOString(), data_source: "data directory", operations: [], notes: ["No workspace exists in this data directory yet."] };
    }
    // The export path redacts, so the report never holds more than an evidence bundle would.
    const bundle = await exportBundle(opened.kit, actor, {});
    const imports = await listImports(opened.kit, actor, { limit: 100 });
    const imported: EvidenceBundle[] = [];
    for (const item of imports.items) imported.push(await getImport(opened.kit, actor, item.import_id));
    const base = reportInputFromBundle(bundle, "data directory (native operations)");
    return {
      ...base,
      data_source: imported.length > 0 ? "data directory (native operations and imported evidence bundles)" : "data directory",
      operations: mergeOperations(imported, base.operations),
      notes: imported.map((b) => `Includes imported bundle ${b.bundle_id} (hash ${b.bundle_hash}).`),
    };
  } finally {
    await opened.close();
  }
}

export async function reportCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseFlags(argv, { bundle: { type: "string" }, "data-dir": { type: "string" }, out: { type: "string" }, workspace: { type: "string" } });
  const out = str(values, "out") ?? "./undokit-report.html";
  const bundlePath = str(values, "bundle");
  if (bundlePath !== undefined && str(values, "data-dir") !== undefined) throw new CliError(EXIT.USAGE, "Use either --bundle or --data-dir, not both");
  let input: ReportInput;
  try {
    if (bundlePath !== undefined) {
      const text = readInputFile(bundlePath, MAX_BUNDLE_BYTES);
      input = reportInputFromBundle(verifyBundleText(text), `evidence bundle ${bundlePath}`);
    } else {
      input = await reportFromDataDir(ctx, str(values, "data-dir"), str(values, "workspace"));
    }
  } catch (error) {
    const failure = toCliError(error);
    // The reader still gets a page that says why there is nothing to trust.
    writeOutputFile(out, renderReport({ generated_at: new Date().toISOString(), data_source: bundlePath ?? "data directory", operations: [], error: failure.message }), 0o644);
    ctx.err(`Report written with an error state: ${out}\n`);
    throw failure;
  }
  writeOutputFile(out, renderReport(input), 0o644);
  const attention = input.operations.filter(needsAttention);
  ctx.out(`Report written to ${out}\n  operations        ${input.operations.length}\n  need attention    ${attention.length}\n`);
  if (attention.length > 0) {
    for (const op of attention) ctx.out(`  - ${op.record_ref}: ${op.state}${op.compensations.length ? ` (compensation ${op.compensations[op.compensations.length - 1]!.state})` : ""}\n`);
    ctx.out("Unknown, conflicting, blocked or failed outcomes are listed in the report; none of them is a success.\n");
    return EXIT.UNRESOLVED;
  }
  return EXIT.OK;
}
