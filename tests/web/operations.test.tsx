// @vitest-environment jsdom
// Operations list, status panel, pagination, polling, export, loading/empty/error states: real in-process daemon, no route mocks.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OperationsPage } from "../../src/web/pages/operations.js";
import type { User } from "../../src/web/api.js";
import { loadSession } from "../../src/web/api.js";
import type { Daemon } from "../helpers/daemon.js";
import { signInAs, tidy, webDaemon } from "../helpers/web.js";

let d: Daemon;
beforeAll(async () => {
  d = await webDaemon({ worker: false });
}, 90_000);
afterAll(async () => {
  await d.close();
});
afterEach(async () => {
  tidy();
  vi.restoreAllMocks();
  // A record with an unresolved operation accepts no new plan (review P2-3), so close whatever an earlier test left UNKNOWN or in flight;
  // otherwise later tests that plan on the same fixture record would be refused. Test hygiene only.
  await d.env.kit.db.query("UPDATE compensations SET state = 'failed', failure_code = 'TEST_CLEANUP' WHERE state IN ('unknown','compensating')");
  await d.env.kit.db.query("UPDATE operations SET state = 'failed', failure_code = 'TEST_CLEANUP' WHERE state IN ('unknown','applying')");
});

async function userFor(who: "admin" | "operator" | "viewer" | "operatorB"): Promise<User> {
  await signInAs(d, who);
  return (await loadSession())!;
}

describe("operations page states", () => {
  it("empty workspace: loading, then an explicit empty state with zeroed status counts and no attention list", async () => {
    const user = await userFor("operatorB");
    render(<OperationsPage user={user} />);
    expect(screen.getAllByTestId("state-loading").length).toBeGreaterThanOrEqual(1); // status panel and list both load
    expect((await screen.findAllByTestId("state-empty"))[0]!.textContent).toMatch(/No operations yet/);
    expect((await screen.findByTestId("status-counts")).textContent).toMatch(/Jobs: 0 queued, 0 running, 0 failed/);
    expect(screen.queryByTestId("attention-list")).toBeNull();
    expect(screen.queryByTestId("operations-table")).toBeNull();
  });

  it("a failing server shows an error with a Retry that recovers once the server is ready again", async () => {
    const user = await userFor("operator");
    const before = d.env.kit.readiness;
    d.env.kit.readiness = { ...before, ok: false, error: "simulated outage" };
    render(<OperationsPage user={user} />);
    const errors = await screen.findAllByTestId("state-error");
    expect(errors[0]!.textContent).toMatch(/not ready/i);
    d.env.kit.readiness = before;
    // Several panels fetch independently and an error from a request that was already in flight can land after the
    // server recovered, so keep pressing Retry on whatever is still showing an error until every panel has recovered.
    await waitFor(() => {
      for (const err of screen.queryAllByTestId("state-error")) fireEvent.click(within(err).getByText("Retry"));
      expect(screen.queryAllByTestId("state-error")).toHaveLength(0);
    });
  });
});

describe("operations with data", () => {
  it("rows show each state; unresolved ones are listed with a next step; compensation labels are shown", async () => {
    const d2 = d;
    const restored = await d2.env.applyOnce({ lifecycle_stage: "customer" });
    await d2.env.worker.drain();
    await d2.env.compensateOnce(restored.id);
    d2.env.sim.failNextWrite("ambiguous_after_commit");
    await d2.env.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    d2.env.sim.failNextWrite("unavailable");
    await d2.env.applyOnce({ owner_label: "x" }, { record_ref: "contact-0002" }).catch(() => undefined);
    const user = await userFor("operator");
    render(<OperationsPage user={user} />);
    const table = await screen.findByTestId("operations-table");
    const states = within(table).getAllByTestId("operation-row").map((r) => r.getAttribute("data-state"));
    expect(states).toEqual(expect.arrayContaining(["applied", "unknown"]));
    expect(within(table).getByText("Compensated")).toBeTruthy();
    expect((await screen.findByTestId("attention-list")).textContent).toMatch(/need attention/);
    expect(screen.getAllByTestId("attention-item").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("new-plan-link").getAttribute("href")).toBe("#/operations/new");
  });

  it("viewer: a read-only note and no export or new-plan controls", async () => {
    const user = await userFor("viewer");
    render(<OperationsPage user={user} />);
    expect(await screen.findByTestId("viewer-note")).toBeTruthy();
    expect(screen.queryByTestId("export-button")).toBeNull();
    expect(screen.queryByTestId("new-plan-link")).toBeNull();
  });

  it("export downloads a real evidence bundle from the real server", async () => {
    const created: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => {
      created.push(b);
      return "blob:test";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = await userFor("operator");
    render(<OperationsPage user={user} />);
    fireEvent.click(await screen.findByTestId("export-button"));
    await waitFor(() => expect(created.length).toBe(1));
    const bundle = JSON.parse(await created[0]!.text()) as { kind: string; redacted: boolean; complete: boolean };
    expect(bundle).toMatchObject({ kind: "undokit.evidence-bundle", redacted: true, complete: true });
    expect(click).toHaveBeenCalled();
  });

  it("an export that the server refuses shows the error and keeps the page usable", async () => {
    const user = await userFor("operator");
    render(<OperationsPage user={user} />);
    const button = await screen.findByTestId("export-button");
    await screen.findByTestId("operations-table");
    const before = d.env.kit.readiness;
    d.env.kit.readiness = { ...before, ok: false, error: "simulated outage" };
    try {
      fireEvent.click(button);
      expect((await screen.findByTestId("export-error")).textContent).toMatch(/not ready/i);
    } finally {
      d.env.kit.readiness = before;
    }
    expect(screen.getByTestId("operations-table")).toBeTruthy();
  });
});

describe("pagination and polling", () => {
  it("more than one page: Older loads the next page and Newer comes back", async () => {
    for (let i = 0; i < 26; i += 1) await d.env.plan({ lead_score: 200 + i }, { record_ref: "contact-0002" });
    const user = await userFor("operator");
    render(<OperationsPage user={user} />);
    const table = await screen.findByTestId("operations-table");
    expect(within(table).getAllByTestId("operation-row").length).toBe(25);
    fireEvent.click(await screen.findByText("Older"));
    await waitFor(() => expect(screen.getByText("Newer")).toBeTruthy());
    fireEvent.click(screen.getByText("Newer"));
    await waitFor(() => expect(screen.queryByText("Newer")).toBeNull());
  });

  it("an approved operation that the worker has not run yet is re-polled until it resolves, and the status panel follows the queue", async () => {
    const queued = await d.env.planAndApprove({ lead_score: 321 }, { record_ref: "contact-0002" });
    const user = await userFor("operator");
    render(<OperationsPage user={user} />);
    await waitFor(() => expect(screen.getAllByTestId("operation-row").some((r) => r.getAttribute("data-state") === "approved")).toBe(true));
    expect((await screen.findByTestId("status-counts")).textContent).toMatch(/[1-9]\d* queued/);
    await d.env.worker.drain();
    await waitFor(() => expect(screen.getAllByTestId("operation-row").some((r) => r.getAttribute("data-state") === "approved")).toBe(false), { timeout: 6000 });
    expect(queued.id).toBeTruthy();
  }, 20_000);
});
