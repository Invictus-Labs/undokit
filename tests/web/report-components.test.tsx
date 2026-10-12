// @vitest-environment jsdom
// Pure presentation components rendered from contract-valid views (no network). These cover states the real API never produces
// (an operation with no fields, no approvals or no attempts) and every badge/format branch. Real-API rendering is in the other web tests.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Async, Badge, CompensationExplainer, EmptyState, ErrorState, FieldStatusBadge, Loading, StateBadge, StateExplainer, Value, formatValue } from "../../src/web/components.js";
import { ApprovalsTable, AttemptsTable, CompensationFieldsTable, CompensationSummary, ConflictList, FieldDiffTable, OperationExplainer } from "../../src/web/Report.js";
import { makeCompensation, makeField, makeOperation } from "../helpers/builders.js";
import { syntheticUuid } from "../helpers/fixtures.js";
import { tidy } from "../helpers/web.js";

afterEach(tidy);

describe("components: badges, explainers and value formatting", () => {
  it("StateBadge and FieldStatusBadge label known states and show unknown ones as needing attention", () => {
    render(
      <>
        <StateBadge state="applied" />
        <StateBadge state="teleported" />
        <FieldStatusBadge status="changed_other" />
        <FieldStatusBadge status="mystery" />
        <Badge tone="ok">plain</Badge>
      </>,
    );
    const text = document.body.textContent ?? "";
    for (const s of ["Applied", "teleported", "Changed by someone else", "mystery", "plain"]) expect(text).toContain(s);
  });

  it("StateExplainer and CompensationExplainer use alert for attention states, note otherwise, and show the recorded reason", () => {
    render(
      <>
        <StateExplainer state="unknown" extra="OUTCOME_UNKNOWN: lost" />
        <StateExplainer state="applied" />
        <CompensationExplainer state="conflict" extra="COMPENSATION_BLOCKED: later edit" />
        <CompensationExplainer state="compensated" />
      </>,
    );
    const ex = screen.getAllByTestId("state-explainer");
    expect(ex[0]!.getAttribute("role")).toBe("alert");
    expect(ex[1]!.getAttribute("role")).toBe("note");
    expect(screen.getByTestId("state-detail").textContent).toContain("OUTCOME_UNKNOWN: lost");
    const cx = screen.getAllByTestId("compensation-explainer");
    expect(cx[0]!.getAttribute("role")).toBe("alert");
    expect(cx[1]!.getAttribute("role")).toBe("note");
    expect(cx[0]!.textContent).toContain("COMPENSATION_BLOCKED");
  });

  it("formatValue quotes strings, distinguishes null, truncates long values and survives unserialisable ones", () => {
    expect(formatValue(undefined)).toBe("");
    expect(formatValue("null")).toBe('"null"');
    expect(formatValue(null)).toBe("null");
    expect(formatValue(41)).toBe("41");
    expect(formatValue("x".repeat(500))).toMatch(/… \(\d+ more characters\)$/);
    expect(formatValue(10n as unknown as string)).toBe("[unserialisable value]");
    expect(formatValue(() => 1)).toContain("=>"); // JSON.stringify returns undefined for a function: falls back to String()
    render(<Value value={{ a: 1 }} />);
    expect(document.body.textContent).toBe('{"a":1}');
  });

  it("Loading, EmptyState and ErrorState render their roles; Retry is only offered when a handler is given", () => {
    const retry = vi.fn();
    render(
      <>
        <Loading />
        <Loading what="Loading thing" />
        <EmptyState>nothing here</EmptyState>
        <ErrorState message="broken" />
        <ErrorState message="broken again" onRetry={retry} />
      </>,
    );
    expect(screen.getAllByTestId("state-loading")[0]!.textContent).toBe("Loading…");
    expect(screen.getAllByTestId("state-loading")[1]!.textContent).toBe("Loading thing…");
    expect(screen.getByTestId("state-empty").textContent).toBe("nothing here");
    expect(screen.getAllByTestId("state-error")[0]!.textContent).not.toContain("Retry");
    fireEvent.click(within(screen.getAllByTestId("state-error")[1]!).getByText("Retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("Async renders loading, error (with and without reload), empty, and ready", () => {
    const reload = vi.fn();
    const view = (state: Parameters<typeof Async<number[]>>[0]["state"], extra: object = {}) => (
      <Async state={state} {...extra}>
        {(d: number[]) => <p data-testid="ready">{d.join(",")}</p>}
      </Async>
    );
    const { rerender } = render(view({ status: "loading" }));
    expect(screen.getByTestId("state-loading")).toBeTruthy();
    rerender(view({ status: "loading" }, { what: "Loading numbers" }));
    expect(screen.getByTestId("state-loading").textContent).toContain("Loading numbers");
    rerender(view({ status: "error", message: "nope" }));
    expect(screen.getByTestId("state-error").textContent).toContain("nope");
    rerender(view({ status: "error", message: "nope" }, { reload }));
    fireEvent.click(screen.getByText("Retry"));
    expect(reload).toHaveBeenCalled();
    rerender(view({ status: "ready", data: [] }, { isEmpty: (d: number[]) => d.length === 0, empty: "no numbers" }));
    expect(screen.getByTestId("state-empty").textContent).toBe("no numbers");
    rerender(view({ status: "ready", data: [1, 2] }, { isEmpty: (d: number[]) => d.length === 0 }));
    expect(screen.getByTestId("ready").textContent).toBe("1,2");
    rerender(view({ status: "ready", data: [3] }));
    expect(screen.getByTestId("ready").textContent).toBe("3");
  });
});

describe("Report components", () => {
  it("FieldDiffTable: empty state, redacted marker, compensation outcome, partial warning only for differing outcomes", () => {
    const empty = makeOperation({ seed: "e", fields: [] });
    const { unmount } = render(<FieldDiffTable op={empty} />);
    expect(screen.getByTestId("state-empty").textContent).toMatch(/No field snapshots/);
    unmount();

    const op = makeOperation({
      seed: "p",
      fields: [
        makeField({ field: "a", redacted: true, before: "[REDACTED]", intended: "[REDACTED]", observed_after: "[REDACTED]" }),
        makeField({ field: "b", apply_outcome: "changed_other", compensation_outcome: "restored", observed_after: null }),
        makeField({ field: "c", apply_outcome: "mismatch" }),
        makeField({ field: "d", apply_outcome: "not_applied" }),
      ],
    });
    render(<FieldDiffTable op={op} />);
    expect(screen.getByTestId("partial-outcome")).toBeTruthy();
    expect(screen.getByText("(redacted)")).toBeTruthy();
    const rows = screen.getAllByTestId("field-row");
    expect(rows.map((r) => r.className)).toEqual(["", "row-attention", "row-attention", "row-attention"]);
    expect(within(rows[1]!).getByText("Restored")).toBeTruthy();
    expect(within(rows[0]!).getByText("none")).toBeTruthy();
  });

  it("FieldDiffTable: a single field or identical outcomes never show the partial warning", () => {
    render(<FieldDiffTable op={makeOperation({ seed: "s", fields: [makeField({ field: "a" }), makeField({ field: "b" })] })} />);
    expect(screen.queryByTestId("partial-outcome")).toBeNull();
  });

  it("ApprovalsTable and AttemptsTable: empty states and populated rows with null provider fields", () => {
    const bare = makeOperation({ seed: "b", attempts: [] });
    bare.approvals = [];
    const { unmount } = render(
      <>
        <ApprovalsTable op={bare} />
        <AttemptsTable op={bare} />
      </>,
    );
    expect(screen.getAllByTestId("state-empty").map((e) => e.textContent)).toEqual(["No approvals recorded.", "No attempts recorded yet."]);
    unmount();
    const op = makeOperation({ seed: "q" });
    op.attempts[0] = { ...op.attempts[0]!, provider_request_id: null, observed_version: null, error_code: null };
    op.attempts.push({ ...op.attempts[0]!, id: syntheticUuid("second-attempt"), outcome: "reconciled_indeterminate", error_code: "STATE_AMBIGUOUS" });
    render(
      <>
        <ApprovalsTable op={op} />
        <AttemptsTable op={op} />
      </>,
    );
    expect(screen.getByTestId("approvals").textContent).toContain(op.plan_hash);
    expect(screen.getAllByTestId("attempt-row").map((r) => r.getAttribute("data-outcome"))).toEqual(["succeeded", "reconciled_indeterminate"]);
    expect(screen.getByText("Reconciled: still indeterminate")).toBeTruthy();
  });

  it("ConflictList: nothing for no conflicts; a record-level conflict and an unknown code are shown with expected and found", () => {
    const { container, rerender } = render(<ConflictList conflicts={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(
      <ConflictList
        conflicts={[
          { field: null, code: "VERSION_CHANGED", expected: "v2", actual: "v3" },
          { field: "tier", code: "VALUE_CHANGED", expected: "gold", actual: "silver" },
          { field: null, code: "RECORD_MISSING", expected: "v2", actual: null },
          { field: "x", code: "SOMETHING_NEW" as never, expected: 1, actual: 2 },
        ]}
      />,
    );
    const items = screen.getAllByTestId("conflict-item");
    expect(items.map((i) => i.getAttribute("data-code"))).toEqual(["VERSION_CHANGED", "VALUE_CHANGED", "RECORD_MISSING", "SOMETHING_NEW"]);
    expect(items[0]!.textContent).toContain("record:");
    expect(items[1]!.textContent).toContain('"gold"');
    expect(items[3]!.textContent).toContain("Conflict: SOMETHING_NEW");
  });

  it("CompensationFieldsTable: empty state and a redacted row; CompensationSummary shows the recorded failure", () => {
    const { unmount } = render(<CompensationFieldsTable fields={[]} caption="c" />);
    expect(screen.getByTestId("state-empty").textContent).toMatch(/No fields in this compensation/);
    unmount();
    const op = makeOperation({ seed: "c" });
    const comp = makeCompensation({
      seed: "c",
      operation_id: op.id,
      state: "failed",
      fields: [{ field: "owner_label", expected_current: "[REDACTED]", restore_to: "[REDACTED]", redacted: true, outcome: "not_restored" }],
    });
    comp.failure = { code: "NOT_APPLIED", message: "restore did not happen" };
    render(<CompensationSummary comp={comp} index={0} />);
    expect(screen.getByTestId("compensation").getAttribute("data-state")).toBe("failed");
    expect(screen.getByText("(redacted)")).toBeTruthy();
    expect(screen.getByTestId("compensation-explainer").textContent).toContain("NOT_APPLIED: restore did not happen");
    expect(screen.getByTestId("compensation-state").textContent).toBe("Compensation failed");
  });

  it("OperationExplainer includes the recorded failure when there is one and omits it otherwise", () => {
    const failed = makeOperation({ seed: "f", state: "failed", failure: { code: "CONNECTOR_UNAVAILABLE", message: "down" } });
    const { unmount } = render(<OperationExplainer op={failed} />);
    expect(screen.getByTestId("state-detail").textContent).toContain("CONNECTOR_UNAVAILABLE: down");
    unmount();
    render(<OperationExplainer op={makeOperation({ seed: "ok" })} />);
    expect(screen.queryByTestId("state-detail")).toBeNull();
  });
});
