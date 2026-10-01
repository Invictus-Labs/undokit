// @vitest-environment jsdom
// New-plan form against the real in-process daemon: every field type, validation, server rejection, success.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createConnector } from "../../src/index.js";
import { loadSession, type User } from "../../src/web/api.js";
import { NewPlanPage, parseValue } from "../../src/web/pages/new-plan.js";
import type { Daemon } from "../helpers/daemon.js";
import { signInAs, tidy, webDaemon } from "../helpers/web.js";

let d: Daemon;
let richId: string;
beforeAll(async () => {
  d = await webDaemon({ sensitiveFields: ["owner_label"] });
  const rich = await createConnector(d.env.kit, d.env.admin, {
    kind: "simulator",
    name: "rich-sim",
    policy: {
      allowed_fields: [
        { name: "is_vip", type: "boolean", max_length: 8, nullable: false, sensitive: false },
        { name: "nickname", type: "string", max_length: 12, nullable: true, sensitive: false },
        { name: "tier", type: "string", max_length: 16, nullable: false, sensitive: false, enum: ["bronze", "silver", "gold"] },
        { name: "visits", type: "number", max_length: 8, nullable: false, sensitive: false },
      ],
      record_prefixes: ["person-"],
    },
    config: { seed_records: [{ record_ref: "person-001", fields: { is_vip: false, nickname: "old", tier: "bronze", visits: 1 } }] },
  });
  richId = rich.id;
  await createConnector(d.env.kit, d.env.admin, {
    kind: "simulator",
    name: "read-only-sim",
    policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 16, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
    config: { seed_records: [], supports_atomic_conditional_write: false },
  } as never);
}, 90_000);
afterAll(async () => {
  await d.close();
});
afterEach(tidy);

async function operator(): Promise<User> {
  await signInAs(d, "operator");
  return (await loadSession())!;
}

const rowOf = (i = 0) => screen.getAllByTestId("patch-row")[i]!;
const selectIn = (row: HTMLElement, n = 0) => row.querySelectorAll("select")[n] as HTMLSelectElement;
const change = (el: Element, value: string) => fireEvent.change(el, { target: { value } });

async function pickConnector(name: RegExp) {
  const select = (await screen.findByLabelText(/^Connector/)) as HTMLSelectElement;
  const option = [...select.options].find((o) => name.test(o.textContent ?? ""))!;
  change(select, option.value);
  return select;
}

describe("parseValue (every branch)", () => {
  const cfg = (over: object) => ({ name: "f", type: "string", max_length: 5, nullable: false, sensitive: false, ...over }) as never;
  it("null is only accepted for nullable fields", () => {
    expect(parseValue(cfg({ nullable: true }), { field: "f", raw: "", isNull: true })).toEqual({ ok: true, value: null });
    expect(parseValue(cfg({}), { field: "f", raw: "", isNull: true })).toMatchObject({ ok: false });
  });
  it("booleans accept only true and false", () => {
    expect(parseValue(cfg({ type: "boolean" }), { field: "f", raw: "true", isNull: false })).toEqual({ ok: true, value: true });
    expect(parseValue(cfg({ type: "boolean" }), { field: "f", raw: "false", isNull: false })).toEqual({ ok: true, value: false });
    expect(parseValue(cfg({ type: "boolean" }), { field: "f", raw: "yes", isNull: false })).toMatchObject({ ok: false });
  });
  it("numbers must be finite and non-empty", () => {
    expect(parseValue(cfg({ type: "number" }), { field: "f", raw: "41", isNull: false })).toEqual({ ok: true, value: 41 });
    expect(parseValue(cfg({ type: "number" }), { field: "f", raw: "  ", isNull: false })).toMatchObject({ ok: false });
    expect(parseValue(cfg({ type: "number" }), { field: "f", raw: "abc", isNull: false })).toMatchObject({ ok: false });
    expect(parseValue(cfg({ type: "number" }), { field: "f", raw: "Infinity", isNull: false })).toMatchObject({ ok: false });
  });
  it("strings respect max_length exactly", () => {
    expect(parseValue(cfg({}), { field: "f", raw: "12345", isNull: false })).toEqual({ ok: true, value: "12345" });
    expect(parseValue(cfg({}), { field: "f", raw: "123456", isNull: false })).toMatchObject({ ok: false });
  });
});

describe("new plan form", () => {
  it("a viewer is told the role cannot plan and gets no form", async () => {
    await signInAs(d, "viewer");
    render(<NewPlanPage user={(await loadSession())!} />);
    expect(screen.getByTestId("forbidden-note").textContent).toMatch(/viewer/);
    expect(screen.queryByTestId("plan-form")).toBeNull();
  });

  it("a workspace with no connector shows an explicit empty state", async () => {
    await signInAs(d, "operatorB");
    render(<NewPlanPage user={(await loadSession())!} />);
    expect((await screen.findByTestId("state-empty")).textContent).toMatch(/No connector is configured/);
  });

  it("loading, then the form; the read-only connector is listed but disabled; the connector label says simulator", async () => {
    render(<NewPlanPage user={await operator()} />);
    expect(screen.getByTestId("state-loading")).toBeTruthy();
    const select = (await screen.findByLabelText(/^Connector/)) as HTMLSelectElement;
    const readOnly = [...select.options].find((o) => /read-only-sim/.test(o.textContent ?? ""))!;
    expect(readOnly.disabled).toBe(true);
    expect(readOnly.textContent).toMatch(/read-only/);
    await pickConnector(/rich-sim/);
    expect(screen.getByTestId("connector-label").textContent).toMatch(/Simulator, not a live provider/);
    expect(screen.getByTestId("connector-label").textContent).toMatch(/Allowed fields: is_vip, nickname, tier, visits/);
  });

  it("submitting an empty form lists every problem and writes nothing", async () => {
    render(<NewPlanPage user={await operator()} />);
    await screen.findByTestId("plan-form");
    fireEvent.submit(screen.getByTestId("plan-form"));
    const list = (await screen.findByTestId("plan-errors")).textContent ?? "";
    expect(list).toMatch(/Choose a connector/);
    expect(list).toMatch(/Enter the record reference/);
    expect(list).toMatch(/record version/);
    expect(list).toMatch(/Nothing was written to the provider/);
    expect(await d.env.count("operations")).toBe(0);
  });

  it("field-level problems: no field chosen, a duplicate field, a bad boolean, a bad number, a too-long string", async () => {
    render(<NewPlanPage user={await operator()} />);
    await pickConnector(/rich-sim/);
    change(screen.getByLabelText(/^Record reference/), "person-001");
    change(screen.getByLabelText(/^Record version/), "sim-v1");
    fireEvent.submit(screen.getByTestId("plan-form"));
    expect((await screen.findByTestId("plan-errors")).textContent).toMatch(/Choose an allowlisted field/);

    change(selectIn(rowOf(0)), "is_vip");
    fireEvent.submit(screen.getByTestId("plan-form"));
    await waitFor(() => expect(screen.getByTestId("plan-errors").textContent).toMatch(/is_vip must be true or false/));
    change(selectIn(rowOf(0), 1), "true");
    fireEvent.click(screen.getByText("Add field"));
    change(selectIn(rowOf(1)), "is_vip");
    fireEvent.submit(screen.getByTestId("plan-form"));
    await waitFor(() => expect(screen.getByTestId("plan-errors").textContent).toMatch(/is_vip appears twice/));

    change(selectIn(rowOf(1)), "visits");
    change(rowOf(1).querySelector("input")!, "not-a-number");
    fireEvent.submit(screen.getByTestId("plan-form"));
    await waitFor(() => expect(screen.getByTestId("plan-errors").textContent).toMatch(/visits must be a number/));

    change(selectIn(rowOf(1)), "nickname");
    change(rowOf(1).querySelector("input")!, "this-is-too-long");
    fireEvent.submit(screen.getByTestId("plan-form"));
    await waitFor(() => expect(screen.getByTestId("plan-errors").textContent).toMatch(/longer than 12 characters/));
    expect(await d.env.count("operations")).toBe(0);
  });

  it("rows can be added and removed; changing the connector clears the rows", async () => {
    render(<NewPlanPage user={await operator()} />);
    await pickConnector(/rich-sim/);
    fireEvent.click(screen.getByText("Add field"));
    expect(screen.getAllByTestId("patch-row").length).toBe(2);
    fireEvent.click(within(rowOf(1)).getByText("Remove"));
    expect(screen.getAllByTestId("patch-row").length).toBe(1);
    expect(within(rowOf(0)).queryByText("Remove")).toBeNull();
    change(selectIn(rowOf(0)), "tier");
    await pickConnector(/synthetic-crm/);
    expect(selectIn(rowOf(0)).value).toBe("");
  });

  it("a successful plan for boolean, enum, number and nullable fields is stored and the page navigates to it", async () => {
    render(<NewPlanPage user={await operator()} />);
    await pickConnector(/rich-sim/);
    change(screen.getByLabelText(/^Record reference/), " person-001 ");
    change(screen.getByLabelText(/^Record version/), "sim-v1");
    change(selectIn(rowOf(0)), "is_vip");
    change(selectIn(rowOf(0), 1), "true");
    fireEvent.click(screen.getByText("Add field"));
    change(selectIn(rowOf(1)), "tier");
    change(selectIn(rowOf(1), 1), "gold");
    fireEvent.click(screen.getByText("Add field"));
    change(selectIn(rowOf(2)), "visits");
    change(rowOf(2).querySelector("input")!, "7");
    fireEvent.click(screen.getByText("Add field"));
    change(selectIn(rowOf(3)), "nickname");
    fireEvent.click(rowOf(3).querySelector('input[type="checkbox"]')!); // set to empty (null)
    fireEvent.submit(screen.getByTestId("plan-form"));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/operations\/[0-9a-f-]{36}$/));
    const id = window.location.hash.split("/").pop()!;
    const view = await d.env.view(id);
    expect(view.state).toBe("planned");
    expect(Object.fromEntries(view.fields.map((f) => [f.field, f.intended]))).toEqual({ is_vip: true, tier: "gold", visits: 7, nickname: null });
    expect(view.connector_id).toBe(richId);
  });

  it("the server's rejection (record outside the connector scope) is shown with its details and nothing is stored", async () => {
    render(<NewPlanPage user={await operator()} />);
    await pickConnector(/synthetic-crm/);
    change(screen.getByLabelText(/^Record reference/), "outside-0001");
    change(screen.getByLabelText(/^Record version/), "sim-v1");
    change(selectIn(rowOf(0)), "lifecycle_stage");
    change(selectIn(rowOf(0), 1), "customer");
    const before = await d.env.count("operations");
    fireEvent.submit(screen.getByTestId("plan-form"));
    const errors = await screen.findByTestId("plan-errors");
    await waitFor(() => expect(errors.textContent).toMatch(/outside the connector scope/i));
    expect(errors.textContent).toMatch(/Nothing was written to the provider/);
    expect(await d.env.count("operations")).toBe(before);
  });

  it("a stale record version is reported without details; sensitive fields are labelled in the field list", async () => {
    render(<NewPlanPage user={await operator()} />);
    await pickConnector(/synthetic-crm/);
    expect(selectIn(rowOf(0)).textContent).toMatch(/owner_label \(sensitive\)/);
    change(screen.getByLabelText(/^Record reference/), "contact-0001");
    change(screen.getByLabelText(/^Record version/), "sim-v99");
    change(selectIn(rowOf(0)), "lead_score");
    change(rowOf(0).querySelector("input")!, "5");
    fireEvent.submit(screen.getByTestId("plan-form"));
    expect((await screen.findByTestId("plan-errors")).textContent).toMatch(/changed since expected_version|plan again/i);
  });
});
