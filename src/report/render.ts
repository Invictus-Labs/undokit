/**
 * Static HTML report renderer.
 *
 * Produces one self-contained, script-free HTML file from operation views (the
 * same shape the API and evidence bundles use). Every interpolated value (record
 * ids, field values, provider text, reasons) is passed through the shared
 * credential redactor and then escapeHtml, so planted secrets never reach the
 * file and malicious markup renders as text. The output references no external
 * asset and ships a restrictive Content-Security-Policy.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "../domain/html.js";
import { redactDeep, redactText } from "../domain/redact.js";
import type { CompensationView, OperationView } from "../domain/types.js";
import {
  attemptOutcomeLabel,
  compensationGuide,
  conflictText,
  fieldNeedsAttention,
  fieldOutcome,
  operationGuide,
  type Tone,
} from "./guide.js";

export interface ReportInput {
  title?: string;
  /** Fixed by the caller (fixed UTC clock in the demo); never read from the system clock here. */
  generated_at: string;
  /** What produced the data, e.g. "synthetic demo (simulator, not a live provider)". Shown verbatim. */
  data_source: string;
  schema_version?: number | string;
  bundle_hash?: string | null;
  bundle_id?: string | null;
  operations: OperationView[];
  /** When set the report shows an error state instead of data. */
  error?: string | null;
  notes?: string[];
}

/** Escape for HTML after removing credential-looking text. */
export function safe(value: unknown): string {
  return escapeHtml(redactText(String(value ?? "")));
}

const MAX_VALUE_CHARS = 400;

/** Render any JSON-ish value as short, redacted, unescaped text (callers escape). Strings are quoted so "null" and null differ. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(redactDeep(value)) ?? String(value);
  } catch {
    text = "[unserialisable value]";
  }
  if (text.length > MAX_VALUE_CHARS) text = `${text.slice(0, MAX_VALUE_CHARS)}… (${text.length - MAX_VALUE_CHARS} more characters)`;
  return text;
}

const TONE_CLASS: Record<Tone, string> = { ok: "tone-ok", info: "tone-info", warn: "tone-warn", bad: "tone-bad" };

function badge(label: string, tone: Tone): string {
  return `<span class="badge ${TONE_CLASS[tone]}">${safe(label)}</span>`;
}

function tableWrap(table: string): string {
  return `<div class="table-wrap">${table}</div>`;
}

function renderFields(op: OperationView): string {
  if (op.fields.length === 0) return `<p class="empty">No field snapshots were recorded for this operation.</p>`;
  const rows = op.fields
    .map((f) => {
      const apply = fieldOutcome(f.apply_outcome);
      const restore = fieldOutcome(f.compensation_outcome);
      return `<tr>
<th scope="row">${safe(f.field)}${f.redacted ? ` <span class="note">(redacted)</span>` : ""}</th>
<td><code>${safe(formatValue(f.before))}</code></td>
<td><code>${safe(formatValue(f.intended))}</code></td>
<td><code>${safe(formatValue(f.observed_after))}</code></td>
<td>${badge(apply.label, apply.tone)}</td>
<td>${f.compensation_outcome === "pending" ? `<span class="note">none</span>` : badge(restore.label, restore.tone)}</td>
<td><code>${safe(f.provider_version)}</code></td>
</tr>`;
    })
    .join("\n");
  return tableWrap(`<table>
<caption>Field changes (outcomes are per field)</caption>
<thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">Intended</th><th scope="col">Observed after</th><th scope="col">Apply outcome</th><th scope="col">Restore outcome</th><th scope="col">Provider version</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`);
}

function renderApprovals(op: OperationView): string {
  if (op.approvals.length === 0) return `<p class="empty">No approvals recorded.</p>`;
  const rows = op.approvals
    .map(
      (a) => `<tr>
<td>${safe(a.phase)}</td>
<td><code>${safe(a.plan_hash)}</code></td>
<td>${safe(a.created_at)}</td>
<td>${safe(a.expires_at)}</td>
</tr>`,
    )
    .join("\n");
  return tableWrap(`<table>
<caption>Approvals (each binds a plan hash)</caption>
<thead><tr><th scope="col">Phase</th><th scope="col">Plan hash</th><th scope="col">Approved at (UTC)</th><th scope="col">Expires (UTC)</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`);
}

function renderAttempts(op: OperationView): string {
  if (op.attempts.length === 0) return `<p class="empty">No attempts recorded yet.</p>`;
  const rows = op.attempts
    .map(
      (a) => `<tr>
<td>${safe(a.phase)}</td>
<td>${safe(attemptOutcomeLabel(a.outcome))}</td>
<td>${safe(a.created_at)}</td>
<td><code>${safe(a.provider_request_id ?? "")}</code></td>
<td><code>${safe(a.observed_version ?? "")}</code></td>
<td>${safe(a.error_code ?? "")}</td>
</tr>`,
    )
    .join("\n");
  return tableWrap(`<table>
<caption>Attempt history (append-only; failures are kept)</caption>
<thead><tr><th scope="col">Phase</th><th scope="col">Outcome</th><th scope="col">At (UTC)</th><th scope="col">Provider request</th><th scope="col">Observed version</th><th scope="col">Error code</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`);
}

function renderCompensation(c: CompensationView, index: number): string {
  const guide = compensationGuide(c.state, c.failure?.code);
  const conflicts = c.conflicts.length
    ? `<div class="callout tone-warn" role="note"><strong>Why it is blocked or at risk</strong><ul>${c.conflicts
        .map(
          (k) =>
            `<li>${safe(k.field ?? "record")}: ${safe(conflictText(k.code))} Expected <code>${safe(formatValue(k.expected))}</code>, found <code>${safe(formatValue(k.actual))}</code>.</li>`,
        )
        .join("")}</ul></div>`
    : "";
  const failure = c.failure ? `<p class="note">Failure: ${safe(c.failure.code)} - ${safe(c.failure.message)}</p>` : "";
  const rows = c.fields
    .map((f) => {
      const o = fieldOutcome(f.outcome);
      return `<tr><th scope="row">${safe(f.field)}${f.redacted ? ` <span class="note">(redacted)</span>` : ""}</th><td><code>${safe(formatValue(f.expected_current))}</code></td><td><code>${safe(formatValue(f.restore_to))}</code></td><td>${badge(o.label, o.tone)}</td></tr>`;
    })
    .join("\n");
  return `<div class="comp" data-testid="report-compensation" data-state="${safe(c.state)}">
<h3>Compensation ${index + 1} ${badge(guide.label, guide.tone)}</h3>
<div class="callout ${TONE_CLASS[guide.tone]}" role="note"><strong>Why:</strong> ${safe(guide.reason)}<br><strong>Next step:</strong> ${safe(guide.nextStep)}</div>
${conflicts}${failure}
${tableWrap(`<table>
<caption>Compensation preview: exact fields (plan hash <code>${safe(c.plan_hash)}</code>, requires provider version <code>${safe(c.expected_version)}</code>)</caption>
<thead><tr><th scope="col">Field</th><th scope="col">Must currently be</th><th scope="col">Would be restored to</th><th scope="col">Outcome</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`)}
</div>`;
}

/** Operation needs attention if it, any compensation or any single field is unresolved, blocked or not as planned. */
export function needsAttention(op: OperationView): boolean {
  return (
    operationGuide(op.state, op.failure?.code).needsAttention ||
    op.fields.some((f) => fieldNeedsAttention(f.apply_outcome) || fieldNeedsAttention(f.compensation_outcome)) ||
    op.compensations.some((c) => compensationGuide(c.state, c.failure?.code).needsAttention || c.fields.some((f) => fieldNeedsAttention(f.outcome)))
  );
}

/** True when fields of one operation ended in different outcomes. */
export function isPartial(op: OperationView): boolean {
  if (op.fields.length < 2) return false;
  const apply = new Set(op.fields.map((f) => f.apply_outcome));
  return apply.size > 1;
}

function renderOperation(op: OperationView): string {
  const guide = operationGuide(op.state, op.failure?.code);
  const reasons = op.failure ? `${guide.reason} Recorded reason: ${op.failure.code} - ${op.failure.message}` : guide.reason;
  const partial = isPartial(op)
    ? `<p class="callout tone-warn" role="note" data-testid="report-partial"><strong>Partial outcome:</strong> fields ended in different states. Review each row; nothing here is summarised as fully successful.</p>`
    : "";
  return `<section class="op" id="op-${safe(op.id)}" data-testid="report-operation" data-state="${safe(op.state)}">
<h2>${safe(op.record_ref)} ${badge(guide.label, guide.tone)}</h2>
<dl class="meta">
<dt>Operation</dt><dd><code>${safe(op.id)}</code></dd>
<dt>Connector</dt><dd>${safe(op.connector.name)} (${safe(op.connector.label)})</dd>
<dt>Plan hash</dt><dd><code>${safe(op.plan_hash)}</code></dd>
<dt>Planned against version</dt><dd><code>${safe(op.expected_version)}</code></dd>
<dt>Observed version after write</dt><dd><code>${safe(op.observed_version ?? "not confirmed")}</code></dd>
<dt>Created (UTC)</dt><dd>${safe(op.created_at)}</dd>
</dl>
<div class="callout ${TONE_CLASS[guide.tone]}" role="note" data-testid="report-reason"><strong>Why:</strong> ${safe(reasons)}<br><strong>Next step:</strong> ${safe(guide.nextStep)}</div>
${partial}
${renderFields(op)}
${renderApprovals(op)}
${renderAttempts(op)}
${op.compensations.map(renderCompensation).join("\n")}
</section>`;
}

function renderSummary(ops: OperationView[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.state, (counts.get(op.state) ?? 0) + 1);
  const attention = ops.filter(needsAttention);
  const rows = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, n]) => {
      const guide = operationGuide(state);
      return `<tr><td>${badge(guide.label, guide.tone)}</td><td>${n}</td></tr>`;
    })
    .join("\n");
  const banner =
    attention.length > 0
      ? `<div class="callout tone-warn" role="alert" data-testid="report-attention"><strong>${attention.length} operation${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} attention.</strong> Unknown, conflicting, blocked or failed outcomes are not successes.<ul>${attention
          .map((op) => `<li><a href="#op-${safe(op.id)}">${safe(op.record_ref)}</a>: ${safe(operationGuide(op.state, op.failure?.code).label)}${op.compensations.some((c) => compensationGuide(c.state, c.failure?.code).needsAttention) ? " (compensation needs attention)" : ""}${isPartial(op) || op.fields.some((f) => fieldNeedsAttention(f.apply_outcome)) ? " (a field did not end as planned)" : ""}</li>`)
          .join("")}</ul></div>`
      : `<p class="callout tone-ok" role="status" data-testid="report-clear">No operation or compensation is in an unknown, conflicting, blocked or failed state.</p>`;
  return `${banner}
${tableWrap(`<table class="summary">
<caption>Operations by state</caption>
<thead><tr><th scope="col">State</th><th scope="col">Count</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`)}`;
}

/** Locate templates/report.html whether running from src/ (tsx) or dist/src/ (built). */
export function findTemplate(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "templates", "report.html");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("templates/report.html not found; the package is incomplete");
}

let cachedTemplate: string | undefined;

function loadTemplate(): string {
  cachedTemplate ??= readFileSync(findTemplate(), "utf8");
  return cachedTemplate;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/<!--UNDOKIT:([A-Z_]+)-->/g, (_match, key: string) => values[key] ?? "");
}

/** Render the report. Pure apart from reading the bundled template. */
export function renderReport(input: ReportInput): string {
  const title = input.title ?? "UndoKit recovery report";
  let body: string;
  if (input.error) {
    body = `<div class="callout tone-bad" role="alert" data-testid="report-error"><strong>The report could not be built from this data.</strong><br>${safe(input.error)}<br><strong>Next step:</strong> fix the input or re-export the evidence bundle, then run the report again. No operation state is shown because none could be trusted.</div>`;
  } else if (input.operations.length === 0) {
    body = `<p class="empty" data-testid="report-empty">No operations in this evidence. Create a plan first, or check that the right bundle or workspace was selected.</p>`;
  } else {
    body = `${renderSummary(input.operations)}\n${input.operations.map(renderOperation).join("\n")}`;
  }
  const notes = (input.notes ?? []).length ? `<ul class="notes">${(input.notes ?? []).map((n) => `<li>${safe(n)}</li>`).join("")}</ul>` : "";
  const meta = `<dl class="meta">
<dt>Generated (UTC)</dt><dd>${safe(input.generated_at)}</dd>
<dt>Data source</dt><dd>${safe(input.data_source)}</dd>
<dt>Schema version</dt><dd>${safe(input.schema_version ?? "")}</dd>
<dt>Bundle</dt><dd><code>${safe(input.bundle_id ?? "none")}</code></dd>
<dt>Bundle hash</dt><dd><code>${safe(input.bundle_hash ?? "none")}</code></dd>
</dl>`;
  return fill(loadTemplate(), { TITLE: safe(title), META: meta, NOTES: notes, BODY: body });
}
