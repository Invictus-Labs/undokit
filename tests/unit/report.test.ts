// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { evidenceBundleSchema, operationViewSchema } from "../../src/domain/types.js";
import { reportInputFromBundle } from "../../src/report/from-bundle.js";
import { findTemplate, formatValue, isPartial, needsAttention, renderReport, safe, type ReportInput } from "../../src/report/render.js";
import { makeBundle, makeCompensation, makeField, makeOperation, scenarioOperations } from "../helpers/builders.js";
import { FIXED_NOW_ISO, leakedNeedles, loadHostile, loadSecrets } from "../helpers/fixtures.js";

const hostile = loadHostile().html_payloads;
const secrets = loadSecrets();
const patternNeedles = secrets.planted.filter((p) => p.kind === "pattern").map((p) => p.value);

function render(input: Partial<ReportInput> & Pick<ReportInput, "operations">): string {
  return renderReport({ generated_at: FIXED_NOW_ISO, data_source: "synthetic test data (not a live provider)", ...input });
}

function dom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const q = (d: Document, testid: string) => [...d.querySelectorAll(`[data-testid="${testid}"]`)];

describe("test builders stay inside the frozen contract", () => {
  it("every scenario operation and the bundle validate against the zod schemas", () => {
    const ops = scenarioOperations();
    for (const op of ops) expect(operationViewSchema.safeParse(op).success, op.record_ref).toBe(true);
    expect(evidenceBundleSchema.safeParse(makeBundle(ops)).success).toBe(true);
  });
});

describe("report from bundle", () => {
  const ops = scenarioOperations();

  it("takes time and identity from the bundle, never from the system clock", () => {
    const bundle = makeBundle(ops, "2026-01-15T12:30:00.000Z");
    const input = reportInputFromBundle(bundle, "evidence bundle (synthetic)");
    expect(input.generated_at).toBe("2026-01-15T12:30:00.000Z");
    expect(input.bundle_id).toBe(bundle.bundle_id);
    expect(input.bundle_hash).toBe(bundle.bundle_hash);
    expect(input.schema_version).toBe(1);
    expect(input.data_source).toBe("evidence bundle (synthetic)");
    const html = renderReport(input);
    expect(html).toContain("2026-01-15T12:30:00.000Z");
    expect(html).toContain(bundle.bundle_hash);
  });

  it("orders operations oldest first with ties broken by id, whatever the order of the bundle files", () => {
    const a = makeOperation({ seed: "a", created_at: "2026-01-15T12:00:00.000Z" });
    const b = makeOperation({ seed: "b", created_at: "2026-01-15T12:00:00.000Z" });
    const c = makeOperation({ seed: "c", created_at: "2026-01-14T08:00:00.000Z" });
    const expected = [c, ...[a, b].sort((x, y) => (x.id < y.id ? -1 : 1))].map((o) => o.id);
    for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
      const input = reportInputFromBundle(makeBundle(order), "x");
      expect(input.operations.map((o) => o.id)).toEqual(expected);
    }
  });

  it("is deterministic: the same bundle renders byte-identical HTML twice", () => {
    const bundle = makeBundle(ops);
    expect(renderReport(reportInputFromBundle(bundle, "x"))).toBe(renderReport(reportInputFromBundle(structuredClone(bundle), "x")));
  });

  it("an empty bundle gives an empty report, not a crash and not a success claim", () => {
    const html = renderReport(reportInputFromBundle(makeBundle([]), "x"));
    const d = dom(html);
    expect(q(d, "report-empty")).toHaveLength(1);
    expect(q(d, "report-clear")).toHaveLength(0);
    expect(q(d, "report-operation")).toHaveLength(0);
  });

  it("does not mutate the bundle it reads", () => {
    const bundle = makeBundle(ops);
    const snapshot = JSON.stringify(bundle);
    renderReport(reportInputFromBundle(bundle, "x"));
    expect(JSON.stringify(bundle)).toBe(snapshot);
  });
});

describe("report shows each outcome honestly (AC-05 / AC-04 wording)", () => {
  const d = dom(render({ operations: scenarioOperations() }));
  const byRef = (ref: string) => q(d, "report-operation").find((el) => el.textContent?.includes(ref)) as Element;

  it("renders one section per operation with the recorded state", () => {
    expect(q(d, "report-operation").map((e) => e.getAttribute("data-state")).sort()).toEqual(["applied", "applied", "applied", "failed", "unknown"].sort());
  });

  it("the clean restore shows Compensated and a Restored field outcome", () => {
    const section = byRef("contact-0001");
    expect(section.querySelector('[data-testid="report-compensation"]')?.getAttribute("data-state")).toBe("compensated");
    expect(section.textContent).toContain("Restored");
  });

  it("the blocked compensation says the later edit was kept, and shows expected versus found values", () => {
    const section = byRef("contact-0002");
    const comp = section.querySelector('[data-testid="report-compensation"]') as Element;
    expect(comp.getAttribute("data-state")).toBe("conflict");
    expect(comp.textContent).toContain("Compensation blocked");
    expect(comp.textContent).toMatch(/later edits were left untouched/i);
    expect(comp.textContent).toContain("Expected");
    expect(comp.textContent).toContain('"customer"');
    expect(comp.textContent).toContain('"partner"');
    expect(comp.textContent).toMatch(/UndoKit will not overwrite/i);
  });

  it("UNKNOWN is shown as unknown with reconciliation guidance, never as success", () => {
    const section = byRef("contact-0003");
    expect(section.textContent).toContain("Unknown outcome");
    expect(section.textContent).toMatch(/read-only reconciliation/i);
    expect(section.querySelector(".tone-ok")).toBeNull();
    expect(section.textContent).toContain("not confirmed");
  });

  it("FAILED shows the recorded reason and is not styled as success", () => {
    const section = byRef("contact-0004");
    expect(section.textContent).toContain("CONNECTOR_UNAVAILABLE");
    expect(section.querySelector("h2 .tone-bad")).not.toBeNull();
  });

  it("the attention banner counts exactly the unresolved operations and links to each", () => {
    const banner = q(d, "report-attention")[0] as Element;
    expect(banner.textContent).toContain("4 operations need attention"); // unknown, failed, blocked compensation, partial outcome
    const links = [...banner.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toHaveLength(4);
    for (const href of links) expect(d.querySelector(href as string), String(href)).not.toBeNull();
    expect(q(d, "report-clear")).toHaveLength(0);
  });

  it("a report with only clean outcomes says so, and does not show an attention banner", () => {
    const clean = scenarioOperations().slice(0, 1);
    const cd = dom(render({ operations: clean }));
    expect(q(cd, "report-clear")).toHaveLength(1);
    expect(q(cd, "report-attention")).toHaveLength(0);
  });

  it("a partial multi-field outcome is labelled partial and never summarised as fully successful", () => {
    const section = byRef("contact-0005");
    expect(section.querySelector('[data-testid="report-partial"]')).not.toBeNull();
    expect(section.textContent).toContain("Changed by someone else");
  });

  // Regression test for QA-D1 (fixed in 67e05fd): a partial outcome counts toward needsAttention.
  it("a partially applied operation alone must not produce the all-clear banner", () => {
    const partialOnly = scenarioOperations().slice(4);
    expect(isPartial(partialOnly[0]!)).toBe(true);
    const pd = dom(render({ operations: partialOnly }));
    expect(q(pd, "report-clear")).toHaveLength(0);
  });

  it("each state class table has a caption and column headers (accessible tables)", () => {
    const tables = [...d.querySelectorAll("table")];
    expect(tables.length).toBeGreaterThan(5);
    for (const t of tables) {
      expect(t.querySelector("caption"), "caption").not.toBeNull();
      expect(t.querySelectorAll('thead th[scope="col"]').length, "headers").toBeGreaterThan(0);
    }
  });

  it("unrecognised states are treated as needing attention, never as success", () => {
    const odd = makeOperation({ seed: "odd" });
    (odd as { state: string }).state = "teleported";
    expect(needsAttention(odd)).toBe(true);
    const od = dom(render({ operations: [odd] }));
    expect(q(od, "report-attention")).toHaveLength(1);
    expect(od.body.textContent).toMatch(/not recognised by this version/);
    const oddComp = makeOperation({ seed: "oddc" });
    oddComp.compensations = [makeCompensation({ seed: "oddc", operation_id: oddComp.id, state: "levitating" as never })];
    expect(needsAttention(oddComp)).toBe(true);
  });

  it("operations with no fields, approvals or attempts show explicit empty messages", () => {
    const bare = makeOperation({ seed: "bare", fields: [], attempts: [] });
    bare.approvals = [];
    const text = dom(render({ operations: [bare] })).body.textContent ?? "";
    expect(text).toContain("No field snapshots were recorded");
    expect(text).toContain("No approvals recorded");
    expect(text).toContain("No attempts recorded yet");
  });

  it("redacted fields are marked as redacted", () => {
    const op = makeOperation({ seed: "red", fields: [makeField({ field: "ssn_last4", redacted: true, before: "[REDACTED]", intended: "[REDACTED]", observed_after: "[REDACTED]" })] });
    expect(dom(render({ operations: [op] })).body.textContent).toContain("(redacted)");
  });
});

describe("empty and error states", () => {
  it("no operations shows an explicit empty message and no success banner", () => {
    const d = dom(render({ operations: [] }));
    expect(q(d, "report-empty")[0]?.textContent).toMatch(/No operations in this evidence/);
    expect(q(d, "report-clear")).toHaveLength(0);
  });

  it("an error replaces all data: nothing is shown as state because none can be trusted", () => {
    const d = dom(render({ operations: scenarioOperations(), error: "bundle hash mismatch" }));
    expect(q(d, "report-error")[0]?.textContent).toContain("bundle hash mismatch");
    expect(q(d, "report-error")[0]?.textContent).toMatch(/Next step/);
    expect(q(d, "report-operation")).toHaveLength(0);
    expect(q(d, "report-clear")).toHaveLength(0);
    expect(d.body.textContent).not.toContain("contact-0001");
  });

  it("an empty-string error is not treated as an error", () => {
    const d = dom(render({ operations: scenarioOperations().slice(0, 1), error: "" }));
    expect(q(d, "report-error")).toHaveLength(0);
    expect(q(d, "report-operation")).toHaveLength(1);
  });
});

describe("AC-09 hostile content renders as text (static report)", () => {
  function hostileOperation(payload: string) {
    const op = makeOperation({
      seed: "h",
      record_ref: payload,
      failure: { code: payload, message: payload },
      fields: [makeField({ field: payload, before: payload, intended: payload, observed_after: payload, provider_version: payload })],
    });
    op.connector = { ...op.connector, name: payload, label: payload };
    op.compensations = [
      makeCompensation({
        seed: "h",
        operation_id: op.id,
        state: "conflict",
        conflicts: [{ field: payload, code: payload as never, expected: payload, actual: payload }],
        fields: [{ field: payload, expected_current: payload, restore_to: payload, redacted: false, outcome: "pending" }],
      }),
    ];
    op.attempts[0] = { ...op.attempts[0]!, provider_request_id: payload, observed_version: payload, error_code: payload };
    return op;
  }

  it.each(hostile.map((h) => [h.name, h.value] as const))("payload %s is inert in every slot", (_name, payload) => {
    const html = render({
      title: payload,
      data_source: payload,
      notes: [payload],
      bundle_id: payload,
      bundle_hash: payload,
      schema_version: payload,
      operations: [hostileOperation(payload)],
    });
    const d = dom(html);
    // Structural proof: the only active content is the template's own single style element.
    expect(d.querySelectorAll("script, img, iframe, svg, object, embed, link, form, input, button, base").length).toBe(0);
    expect(d.querySelectorAll("style").length).toBe(1);
    expect(d.getElementById("injected-heading")).toBeNull();
    for (const el of d.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith("on"), `${el.tagName}[${attr}]`).toBe(false);
    }
    // Only internal anchors exist; none is a javascript: or external url.
    for (const a of d.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").toMatch(/^#op-/);
    // Display fidelity: the visible text still contains the original characters (rendered as text).
    if (/[<>]/.test(payload)) expect(d.body.textContent).toContain(payload.replace(/\s+/g, " ").trim().slice(0, 12));
    // No raw angle-bracket payload survives in the serialized source.
    if (/<[a-z]/i.test(payload)) expect(html).not.toContain(payload);
    expect((globalThis as { __undokit_pwned?: string }).__undokit_pwned).toBeUndefined();
  });

  it("a template placeholder or replacement-pattern value cannot rewrite the page", () => {
    const op = makeOperation({ seed: "p", record_ref: "<!--UNDOKIT:BODY-->$&$1$`$'", fields: [makeField({ field: "f", before: "$&", intended: "<!--UNDOKIT:NOTES-->" })] });
    const html = render({ operations: [op] });
    expect(html.match(/<!--UNDOKIT:/g)).toBeNull();
    expect(dom(html).body.textContent).toContain("$&$1");
  });

  it("values are quoted, truncated and cannot break out of their table cell", () => {
    const op = makeOperation({ seed: "t", fields: [makeField({ field: "f", before: "x".repeat(100_000), intended: "</td></tr></table><h1 id='injected-heading'>X</h1>" })] });
    const html = render({ operations: [op] });
    expect(html.length).toBeLessThan(60_000);
    expect(html).toContain("more characters");
    expect(dom(html).getElementById("injected-heading")).toBeNull();
  });
});

describe("AC-09 planted secrets never reach the report", () => {
  it("credential-shaped values in field values, failure text, notes and provider text are redacted", () => {
    const [bearer, tokenInNote] = patternNeedles as [string, string];
    const op = makeOperation({
      seed: "s",
      failure: { code: "PROVIDER_ERROR", message: `upstream said Authorization: Bearer ${bearer}` },
      fields: [makeField({ field: "notes", before: `see ${tokenInNote}`, intended: `password=hunter2hunter2 ${bearer}`, observed_after: `api_key: ${tokenInNote}` })],
    });
    op.attempts[0] = { ...op.attempts[0]!, provider_request_id: `req ${bearer}`, error_code: tokenInNote };
    const html = render({ operations: [op], notes: [`token ${bearer}`], data_source: `source ${tokenInNote}` });
    expect(leakedNeedles(html)).toEqual([]);
    expect(html).not.toContain("hunter2hunter2");
    expect(html).toContain("[REDACTED]");
  });

  it("well-known credential formats in free text are redacted (cloud key, bearer, private key block)", () => {
    const aws = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    const pem = ["-----BEGIN ", "PRIVATE KEY-----\nMIIE...\n-----END ", "PRIVATE KEY-----"].join("");
    const op = makeOperation({ seed: "f", fields: [makeField({ field: "notes", before: aws, intended: pem, observed_after: "Basic dXNlcjpwYXNzd29yZA==" })] });
    const html = render({ operations: [op] });
    expect(html).not.toContain(aws);
    expect(html).not.toContain("MIIE");
    expect(html).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  it("safe() redacts then escapes, in that order", () => {
    const out = safe(`<b>${patternNeedles[0]}</b>`);
    expect(out).not.toContain("<b>");
    expect(leakedNeedles(out)).toEqual([]);
  });
});

describe("static report is self-contained and offline", () => {
  const html = render({ operations: scenarioOperations() });

  it("ships a restrictive CSP and references no external asset", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b|<script\b|@import|url\(/i);
    expect(html).not.toMatch(/\s(src|srcset|data)=/i);
  });

  it("declares language, charset and a viewport for mobile", () => {
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
  });

  it("tables scroll inside a wrapper instead of forcing page-wide horizontal scroll", () => {
    const d = dom(html);
    for (const t of d.querySelectorAll("table")) expect(t.parentElement?.className).toContain("table-wrap");
  });

  it("renders 300 operations quickly and without error", () => {
    const many = Array.from({ length: 300 }, (_, i) => makeOperation({ seed: `n${i}`, created_at: FIXED_NOW_ISO }));
    const t0 = performance.now();
    const out = render({ operations: many });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(dom(out).querySelectorAll('[data-testid="report-operation"]')).toHaveLength(300);
  });
});

describe("render helpers", () => {
  it("formatValue distinguishes null from the string 'null', and quotes strings", () => {
    expect(formatValue(null)).toBe("null");
    expect(formatValue("null")).toBe('"null"');
    expect(formatValue(41)).toBe("41");
    expect(formatValue(false)).toBe("false");
    expect(formatValue(undefined)).toBe("");
  });

  it("formatValue survives unserialisable and circular values with bounded output", () => {
    expect(formatValue(10n)).toBe("[unserialisable value]");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = formatValue(circular);
    expect(out.length).toBeLessThan(500);
  });

  it("formatValue truncates long values and says how much was cut", () => {
    const out = formatValue("y".repeat(1000));
    expect(out.length).toBeLessThan(500);
    expect(out).toMatch(/more characters/);
  });

  it("findTemplate locates templates/report.html from src and fails clearly when it is absent", () => {
    expect(findTemplate()).toMatch(/templates[\\/]report\.html$/);
    expect(() => findTemplate("/")).toThrow(/templates\/report\.html not found/);
  });

  it("needsAttention is true for blocked, failed and unknown compensations even when the operation is applied", () => {
    for (const state of ["conflict", "failed", "unknown"] as const) {
      const op = makeOperation({ seed: `c-${state}` });
      op.compensations = [makeCompensation({ seed: state, operation_id: op.id, state })];
      expect(needsAttention(op), state).toBe(true);
    }
    const ok = makeOperation({ seed: "ok" });
    ok.compensations = [makeCompensation({ seed: "ok", operation_id: ok.id, state: "compensated" })];
    expect(needsAttention(ok)).toBe(false);
  });

  it("isPartial needs two or more fields with differing apply outcomes", () => {
    expect(isPartial(makeOperation({ seed: "1" }))).toBe(false);
    const same = makeOperation({ seed: "2", fields: [makeField({ field: "a" }), makeField({ field: "b" })] });
    expect(isPartial(same)).toBe(false);
    const diff = makeOperation({ seed: "3", fields: [makeField({ field: "a" }), makeField({ field: "b", apply_outcome: "not_applied" })] });
    expect(isPartial(diff)).toBe(true);
  });
});
