import { join } from "node:path";
import { runDemo, PRODUCT_VERSION, type DemoReport } from "../index.js";
import { compensationGuide, operationGuide } from "../report/guide.js";
import { reportInputFromBundle } from "../report/from-bundle.js";
import { needsAttention, renderReport } from "../report/render.js";
import { flag, parseFlags, str } from "./args.js";
import type { CommandContext } from "./context.js";
import { EXIT } from "./exit.js";
import { writeOutputFile } from "./io.js";

export const DEMO_SOURCE = "synthetic demo (built-in simulator, not a live provider)";

export function summarize(report: DemoReport): string {
  const lines: string[] = [`UndoKit demo: synthetic data, built-in simulator (not a live provider), no network, fixed UTC clock ${report.started_at}`, ""];
  report.scenarios.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`);
    for (const step of s.steps) lines.push(`   - ${step.step}: ${step.outcome} - ${step.detail}`);
  });
  lines.push("", "Operations as an operator would see them:");
  for (const op of report.operations) {
    const comp = op.compensations[op.compensations.length - 1];
    const opText = operationGuide(op.state).label;
    if (!comp) {
      lines.push(`  ${op.record_ref}: ${opText}`);
      continue;
    }
    const guide = compensationGuide(comp.state);
    const tail = comp.state === "conflict" ? " (the later edit was kept; nothing was overwritten)" : comp.state === "compensated" ? " (original value restored)" : "";
    lines.push(`  ${op.record_ref}: ${opText}; ${guide.label}${tail}`);
  }
  const passed = report.checks.filter((c) => c.pass).length;
  lines.push("", `Checks: ${passed}/${report.checks.length} passed`);
  for (const c of report.checks) lines.push(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  return `${lines.join("\n")}\n`;
}

export async function demoCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseFlags(argv, { out: { type: "string" }, json: { type: "boolean" }, "data-dir": { type: "string" } });
  const outDir = str(values, "out") ?? "./undokit-demo";
  const report = await runDemo();
  const html = renderReport({
    generated_at: report.started_at,
    data_source: DEMO_SOURCE,
    ...reportFields(report),
    notes: [
      "Synthetic data produced by the built-in simulator. It is not a live provider and no real record was touched.",
      ...report.checks.map((c) => `${c.pass ? "PASS" : "FAIL"}: ${c.name}`),
    ],
  });
  const reportPath = join(outDir, "report.html");
  const evidencePath = join(outDir, "evidence.json");
  writeOutputFile(reportPath, html, 0o644);
  writeOutputFile(evidencePath, `${JSON.stringify(report.evidence)}\n`);
  const attention = report.operations.filter(needsAttention).length;
  if (flag(values, "json")) {
    ctx.out(
      `${JSON.stringify({ kind: "undokit-demo-result", version: PRODUCT_VERSION, mode: report.mode, live: report.live, all_passed: report.all_passed, checks: report.checks, operations_needing_attention: attention, bundle: report.bundle, files: { report: reportPath, evidence: evidencePath } }, null, 2)}\n`,
    );
  } else {
    ctx.out(summarize(report));
    ctx.out(`\nWrote ${reportPath}\nWrote ${evidencePath}\nNext: open the report in a browser, then run: undokit verify ${evidencePath}\n`);
  }
  return report.all_passed ? EXIT.OK : EXIT.FAILURE;
}

function reportFields(report: DemoReport) {
  const input = reportInputFromBundle(report.evidence, DEMO_SOURCE);
  return { schema_version: input.schema_version, bundle_id: input.bundle_id, bundle_hash: input.bundle_hash, operations: input.operations };
}
