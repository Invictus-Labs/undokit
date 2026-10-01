// @vitest-environment jsdom
// Operation detail page against the real in-process daemon (real worker run by the test, no route mocks).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCompensationPlan, compensateOperation, requestReconcile } from "../../src/index.js";
import { loadSession, type User } from "../../src/web/api.js";
import { OperationPage } from "../../src/web/pages/operation-detail.js";
import type { Daemon } from "../helpers/daemon.js";
import { signInAs, tidy, webDaemon, type Who } from "../helpers/web.js";

let d: Daemon;
beforeAll(async () => {
  d = await webDaemon({ worker: false, sensitiveFields: ["owner_label"] });
}, 90_000);
afterAll(async () => {
  await d.close();
});
beforeEach(() => {
  // Each test starts from the fixture records at version 1 (the in-process simulator stands in for the external provider).
  d.env.sim.seed("contact-0001", { lifecycle_stage: "lead", lead_score: 40, owner_label: "team-red" });
  d.env.sim.seed("contact-0002", { lifecycle_stage: "lead", lead_score: 55, owner_label: "team-blue" });
});
afterEach(async () => {
  tidy();
  d.env.kit.faults.clear();
  await d.env.worker.drain(); // no queued job may leak into the next test
  // A record with an unresolved operation accepts no new plan (review P2-3), so close whatever this test left unresolved; otherwise the
  // next test would inherit an UNKNOWN operation on the same fixture record. Test hygiene only: no assertion depends on these rows afterwards.
  await d.env.kit.db.query("UPDATE compensations SET state = 'failed', failure_code = 'TEST_CLEANUP' WHERE state IN ('unknown','compensating')");
  await d.env.kit.db.query("UPDATE operations SET state = 'failed', failure_code = 'TEST_CLEANUP' WHERE state IN ('unknown','applying')");
});

async function open(id: string, who: Who = "operator") {
  await signInAs(d, who);
  const user: User = (await loadSession())!;
  return render(<OperationPage id={id} user={user} />);
}
const stateIs = (s: string) => expect(screen.getByTestId("state-explainer").getAttribute("data-state")).toBe(s);
const click = (id: string) => fireEvent.click(screen.getByTestId(id));

describe("planned operation (nothing written yet)", () => {
  it("loading, then the plan: field diff, explicit approval gate, compensation unavailable, viewer sees a note instead", async () => {
    const plan = await d.env.plan({ lifecycle_stage: "customer", owner_label: "alice-private-name" });
    const { unmount } = await open(plan.id);
    expect(screen.getByTestId("state-loading")).toBeTruthy();
    expect((await screen.findByTestId("operation-title")).textContent).toContain("contact-0001");
    stateIs("planned");
    expect(screen.getByTestId("field-diff").textContent).toContain("alice-private-name"); // operator sees the value
    expect(screen.getByTestId("compensation-unavailable").textContent).toMatch(/only be previewed after the change is applied/);
    expect(screen.getByTestId("plan-hash").textContent).toBe((await d.env.view(plan.id)).plan_hash);
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("approve-confirm"));
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(false);
    unmount();
    tidy();
    await open(plan.id, "viewer");
    await screen.findByTestId("operation-title");
    expect(screen.getByTestId("viewer-note")).toBeTruthy();
    expect(screen.queryByTestId("approve-panel")).toBeNull();
    expect(screen.getByTestId("field-diff").textContent).not.toContain("alice-private-name");
    expect(screen.getByText("(redacted)")).toBeTruthy();
  });

  it("approve, the page shows the in-flight note and polls, then the worker applies it and the evidence tables appear", async () => {
    const plan = await d.env.plan({ lifecycle_stage: "customer" });
    await open(plan.id);
    await screen.findByTestId("approve-panel");
    click("approve-confirm");
    click("approve-button");
    expect(await screen.findByTestId("in-flight")).toBeTruthy();
    stateIs("approved");
    await d.env.worker.drain();
    await waitFor(() => stateIs("applied"), { timeout: 6000 });
    expect(screen.queryByTestId("in-flight")).toBeNull();
    expect(screen.getByTestId("approvals").textContent).toContain("apply");
    expect(screen.getByTestId("attempts").textContent).toContain("Succeeded");
    expect(screen.getByTestId("preview-compensation-button")).toBeTruthy();
  }, 20_000);

  it("a refused approval shows the server's reason, reloads the page, and writes nothing", async () => {
    const plan = await d.env.plan({ lead_score: 17 }, { record_ref: "contact-0002" });
    await open(plan.id);
    await screen.findByTestId("approve-panel");
    click("approve-confirm");
    const before = d.env.kit.readiness;
    d.env.kit.readiness = { ...before, ok: false, error: "simulated outage" };
    try {
      click("approve-button");
      expect((await screen.findByTestId("action-error")).textContent).toMatch(/not ready/i);
    } finally {
      d.env.kit.readiness = before;
    }
    expect(d.env.sim.snapshot("contact-0002")?.fields["lead_score"]).toBe(55);
  });
});

describe("applied operation and compensation", () => {
  it("preview, separate approval, restore: the compensation block moves planned, approved, compensated", async () => {
    const op = await d.env.applyOnce({ lifecycle_stage: "customer" });
    await open(op.id);
    await screen.findByTestId("preview-compensation-button");
    click("preview-compensation-button");
    await waitFor(() => expect(screen.getByTestId("compensation").getAttribute("data-state")).toBe("planned"));
    expect(screen.getByTestId("compensation-plan-hash").textContent).toMatch(/^sha256:/);
    expect(screen.queryByTestId("preview-compensation-button")).toBeNull(); // no second preview stacked on an open one
    expect((screen.getByTestId("compensate-button") as HTMLButtonElement).disabled).toBe(true);
    click("compensation-confirm");
    click("compensate-button");
    await waitFor(() => expect(screen.getByTestId("compensation").getAttribute("data-state")).toBe("approved"));
    await d.env.worker.drain();
    await waitFor(() => expect(screen.getByTestId("compensation").getAttribute("data-state")).toBe("compensated"), { timeout: 6000 });
    expect(d.env.sim.snapshot("contact-0001")?.fields["lifecycle_stage"]).toBe("lead");
  }, 20_000);

  it("a later edit blocks the preview: conflict list with both values, no approve control, and the edit is kept", async () => {
    const op = await d.env.applyOnce({ lifecycle_stage: "customer" }, { record_ref: "contact-0002" });
    d.env.sim.externalEdit("contact-0002", { lifecycle_stage: "partner" });
    await open(op.id);
    await screen.findByTestId("preview-compensation-button");
    click("preview-compensation-button");
    await waitFor(() => expect(screen.getByTestId("compensation").getAttribute("data-state")).toBe("conflict"));
    expect(screen.getByTestId("conflict-list").textContent).toContain("partner");
    expect(screen.getByTestId("compensation-blocked-note").textContent).toMatch(/No restore will be attempted/);
    expect(screen.queryByTestId("compensate-button")).toBeNull();
    expect(d.env.sim.snapshot("contact-0002")?.fields["lifecycle_stage"]).toBe("partner");
  });

  it("a preview that the server refuses shows the error", async () => {
    const op = await d.env.applyOnce({ lead_score: 66 }, { record_ref: "contact-0002" });
    await open(op.id);
    await screen.findByTestId("preview-compensation-button");
    const before = d.env.kit.readiness;
    d.env.kit.readiness = { ...before, ok: false, error: "simulated outage" };
    try {
      click("preview-compensation-button");
      expect((await screen.findByTestId("action-error")).textContent).toMatch(/not ready/i);
    } finally {
      d.env.kit.readiness = before;
    }
  });

  it("a compensation that is approved but refused at approval time shows the action error", async () => {
    const op = await d.env.applyOnce({ lead_score: 71 }, { record_ref: "contact-0002" });
    const plan = await createCompensationPlan(d.env.kit, d.env.operator, op.id);
    await open(op.id);
    await screen.findByTestId("compensation-approve-panel");
    click("compensation-confirm");
    await compensateOperation(d.env.kit, d.env.operator, op.id, { plan_hash: plan.plan_hash }); // another operator approved it first
    click("compensate-button");
    expect((await screen.findByTestId("action-error")).textContent).toMatch(/already in progress|compensation/i);
  });
});

describe("unresolved and failed outcomes", () => {
  it("UNKNOWN: reconcile button; clicking queues the read-only check and the page follows it to the resolved state", async () => {
    d.env.sim.failNextWrite("ambiguous_after_commit");
    const op = await d.env.applyOnce({ lead_score: 81 }, { record_ref: "contact-0002" });
    await open(op.id);
    await screen.findByTestId("reconcile-button");
    stateIs("unknown");
    const jobsBefore = await d.env.count("jobs");
    click("reconcile-button");
    await waitFor(async () => expect(await d.env.count("jobs")).toBe(jobsBefore + 1));
    await d.env.worker.drain();
    await waitFor(() => stateIs("applied"), { timeout: 8000 });
    expect(d.env.sim.calls.write).toBeGreaterThan(0);
  }, 20_000);

  it("UNKNOWN as a viewer: told to ask an operator, no button", async () => {
    d.env.sim.failNextWrite("ambiguous_after_commit");
    const op = await d.env.applyOnce({ lead_score: 82 }, { record_ref: "contact-0002" });
    await open(op.id, "viewer");
    await screen.findByTestId("operation-title");
    expect(screen.queryByTestId("reconcile-button")).toBeNull();
    expect(document.body.textContent).toMatch(/An operator or admin must run the read-only reconciliation/);
  });

  it("an UNKNOWN compensation offers its own reconcile button inside the compensation block", async () => {
    const op = await d.env.applyOnce({ lead_score: 83 }, { record_ref: "contact-0002" });
    const plan = await createCompensationPlan(d.env.kit, d.env.operator, op.id);
    await compensateOperation(d.env.kit, d.env.operator, op.id, { plan_hash: plan.plan_hash });
    d.env.sim.failNextWrite("ambiguous_after_commit");
    await d.env.worker.runOnce();
    await open(op.id);
    await waitFor(() => expect(screen.getByTestId("compensation").getAttribute("data-state")).toBe("unknown"));
    expect(screen.getByTestId("reconcile-button")).toBeTruthy();
  });

  it("FAILED shows the recorded reason and is not styled as success", async () => {
    d.env.sim.failNextWrite("unavailable");
    const op = await d.env.applyOnce({ lead_score: 84 }, { record_ref: "contact-0002" });
    await open(op.id);
    await screen.findByTestId("operation-title");
    stateIs("failed");
    expect(screen.getByTestId("state-detail").textContent).toContain("CONNECTOR_UNAVAILABLE");
    expect(screen.queryByTestId("preview-compensation-button")).toBeNull();
  });

  it("CONFLICT at apply time: provider-side conflict is shown, not success", async () => {
    const p = await d.env.planAndApprove({ lead_score: 85 }, { record_ref: "contact-0002" });
    d.env.sim.externalEdit("contact-0002", { lead_score: 1 });
    await d.env.worker.drain();
    await open(p.id);
    await screen.findByTestId("operation-title");
    stateIs("conflict");
    expect(screen.getByTestId("operation-title").textContent).not.toContain("Applied");
  });

  it("a partial outcome (a field changed by someone else right after the write) is flagged field by field", async () => {
    d.env.kit.faults.onPoint("apply.after_remote_success", async () => {
      d.env.sim.externalEdit("contact-0001", { lead_score: 999 });
    });
    const op = await d.env.applyOnce({ lifecycle_stage: "churned", lead_score: 41 });
    await open(op.id);
    await screen.findByTestId("operation-title");
    expect(screen.getByTestId("partial-outcome")).toBeTruthy();
    const rows = screen.getAllByTestId("field-row");
    expect(rows.some((r) => within(r).queryByText("Changed by someone else"))).toBe(true);
  });
});

describe("not found and workspace isolation", () => {
  it("another workspace's operation id is a not-found error with none of its data and a Retry", async () => {
    const op = await d.env.applyOnce({ lead_score: 91 }, { record_ref: "contact-0002" });
    await open(op.id, "operatorB");
    const err = await screen.findByTestId("state-error");
    expect(err.textContent).toMatch(/not found/i);
    expect(document.body.textContent).not.toContain("contact-0002");
    fireEvent.click(within(err).getByText("Retry"));
    await screen.findByTestId("state-error");
  });

  it("a malformed id is an error state, not a crash", async () => {
    await open("not-a-uuid");
    expect((await screen.findByTestId("state-error")).textContent).toMatch(/invalid|not found|operation/i);
  });
});

describe("closing an UNKNOWN outcome by hand (administrator only; the provider is never contacted)", () => {
  async function unknownOperation(record = "contact-0001"): Promise<string> {
    d.env.sim.failNextWrite("ambiguous_before_commit");
    const op = await d.env.applyOnce({ lifecycle_stage: "customer" }, { record_ref: record });
    expect((await d.env.view(op.id)).state).toBe("unknown");
    return op.id;
  }
  /** Reconciliation really cannot settle it: someone set the record to a third value (STATE_AMBIGUOUS). Only then may it be closed by hand. */
  async function ambiguousOperation(record = "contact-0001"): Promise<string> {
    const id = await unknownOperation(record);
    d.env.sim.externalEdit(record, { lifecycle_stage: "churned" });
    await requestReconcile(d.env.kit, d.env.operator, id);
    await d.env.worker.drain();
    expect((await d.env.view(id)).attempts.filter((a) => a.phase === "reconcile").at(-1)?.error_code).toBe("STATE_AMBIGUOUS");
    return id;
  }

  it("the control is shown to an administrator for an unknown operation only; operators, viewers and other states never see it", async () => {
    const id = await unknownOperation();
    const applied = await d.env.applyOnce({ lead_score: 77 }, { record_ref: "contact-0002" });
    for (const who of ["operator", "viewer"] as const) {
      const { unmount } = await open(id, who);
      await screen.findByTestId("operation-title");
      expect(screen.queryByTestId("resolve-panel"), who).toBeNull();
      unmount();
      tidy();
    }
    const admin = await open(applied.id, "admin");
    await screen.findByTestId("operation-title");
    expect(screen.queryByTestId("resolve-panel"), "an applied operation has nothing to resolve").toBeNull();
    admin.unmount();
    tidy();
    await open(id, "admin");
    await screen.findByTestId("operation-title");
    expect(screen.getByTestId("resolve-panel")).toBeTruthy();
    expect(screen.getByTestId("resolve-warning").textContent).toMatch(/never writes to the provider and never checks it/);
  });

  it("before any reconcile ran the page says it is not available yet and the confirm step cannot be reached; after a reconcile that could not settle it, it says so and allows it", async () => {
    const id = await unknownOperation();
    const early = await open(id, "admin");
    await screen.findByTestId("resolve-panel");
    expect(screen.getByTestId("resolve-not-yet").textContent).toMatch(/Not available yet/);
    expect(screen.queryByTestId("resolve-eligible")).toBeNull();
    fireEvent.change(screen.getByTestId("resolve-outcome"), { target: { value: "not_applied" } });
    fireEvent.change(screen.getByTestId("resolve-reason"), { target: { value: "too early" } });
    expect((screen.getByTestId("resolve-start") as HTMLButtonElement).disabled, "not reachable before a reconcile settled nothing").toBe(true);
    expect((await d.env.view(id)).state).toBe("unknown");
    early.unmount();
    tidy();
    d.env.sim.externalEdit("contact-0001", { lifecycle_stage: "churned" });
    await requestReconcile(d.env.kit, d.env.operator, id);
    await d.env.worker.drain();
    await open(id, "admin");
    await screen.findByTestId("resolve-panel");
    expect(screen.getByTestId("resolve-eligible").textContent).toMatch(/STATE_AMBIGUOUS/);
    expect(screen.queryByTestId("resolve-not-yet")).toBeNull();
  });

  it("needs a decision and a reason, confirms with the reason shown, cancel changes nothing, and confirming closes it as failed with no provider call", async () => {
    const id = await ambiguousOperation();
    const before = { ...d.env.sim.calls };
    await open(id, "admin");
    await screen.findByTestId("resolve-panel");
    const start = () => screen.getByTestId("resolve-start") as HTMLButtonElement;
    expect(start().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("resolve-outcome"), { target: { value: "not_applied" } });
    expect(start().disabled, "a reason is required").toBe(true);
    fireEvent.change(screen.getByTestId("resolve-reason"), { target: { value: "checked the provider by hand: unchanged" } });
    expect(start().disabled).toBe(false);
    click("resolve-start");
    expect(screen.getByTestId("resolve-confirm").textContent).toMatch(/The provider will not be contacted/);
    expect(screen.getByTestId("resolve-confirm-reason").textContent).toBe("checked the provider by hand: unchanged");
    click("resolve-cancel");
    expect(screen.queryByTestId("resolve-confirm")).toBeNull();
    expect((await d.env.view(id)).state, "cancel changes nothing").toBe("unknown");
    click("resolve-start");
    click("resolve-confirm-button");
    await waitFor(() => expect(screen.getByTestId("state-explainer").getAttribute("data-state")).toBe("failed"));
    const view = await d.env.view(id);
    expect(view.failure?.code).toBe("OPERATOR_RESOLVED");
    expect(d.env.sim.calls, "the provider was never contacted").toEqual(before);
    expect(screen.queryByTestId("resolve-panel")).toBeNull();
  });

  it("an unknown compensation is closed the same way and the page says 'its unknown compensation'", async () => {
    const applied = await d.env.applyOnce({ lifecycle_stage: "customer" });
    const plan = await createCompensationPlan(d.env.kit, d.env.operator, applied.id);
    await compensateOperation(d.env.kit, d.env.operator, applied.id, { plan_hash: plan.plan_hash });
    d.env.sim.failNextWrite("ambiguous_before_commit");
    await d.env.worker.runOnce();
    d.env.sim.externalEdit("contact-0001", { lifecycle_stage: "churned" });
    await requestReconcile(d.env.kit, d.env.operator, applied.id);
    await d.env.worker.drain();
    await open(applied.id, "admin");
    await screen.findByTestId("resolve-panel");
    expect(screen.getByTestId("resolve-warning").textContent).toMatch(/its unknown compensation/);
    fireEvent.change(screen.getByTestId("resolve-outcome"), { target: { value: "abandoned" } });
    fireEvent.change(screen.getByTestId("resolve-reason"), { target: { value: "no longer needed" } });
    click("resolve-start");
    click("resolve-confirm-button");
    await waitFor(() => expect(screen.queryByTestId("resolve-panel")).toBeNull());
    const comp = (await d.env.kit.db.query<{ state: string; failure_code: string }>("SELECT state, failure_code FROM compensations WHERE operation_id = $1::uuid", [applied.id])).rows[0];
    expect(comp).toMatchObject({ state: "failed", failure_code: "OPERATOR_RESOLVED" });
    expect((await d.env.view(applied.id)).state).toBe("applied");
  });
});
