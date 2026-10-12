// @vitest-environment jsdom
// Connectors and members pages against the real in-process daemon.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createConnector } from "../../src/index.js";
import { loadSession } from "../../src/web/api.js";
import { ConnectorsPage, MembersPage } from "../../src/web/pages/admin.js";
import type { Daemon } from "../helpers/daemon.js";
import { newPassword } from "../helpers/kit.js";
import { signInAs, tidy, webDaemon, type Who } from "../helpers/web.js";

let d: Daemon;
beforeAll(async () => {
  d = await webDaemon({ sensitiveFields: ["owner_label"] });
  await createConnector(d.env.kit, d.env.admin, {
    kind: "simulator",
    name: "read-only-sim",
    policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 16, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
    config: { seed_records: [], supports_atomic_conditional_write: false },
  } as never);
  const live = await createConnector(d.env.kit, d.env.admin, {
    kind: "couchdb",
    name: "local-couch",
    policy: { allowed_fields: [{ name: "lifecycle_stage", type: "string", max_length: 16, nullable: false, sensitive: false }], record_prefixes: ["contact-"] },
    config: { base_url: "http://127.0.0.1:5984", database: "crm", timeout_ms: 1000 },
    credentials: { username: "sandbox-admin", password: "placeholder-not-a-real-password" },
  });
  await d.env.kit.db.query("UPDATE connectors SET disabled_at = $2::timestamptz WHERE id = $1::uuid", [live.id, "2026-01-15T12:00:00.000Z"]);
}, 90_000);
afterAll(async () => {
  await d.close();
});
afterEach(tidy);

async function as(who: Who) {
  await signInAs(d, who);
  return (await loadSession())!;
}

describe("connectors page", () => {
  it("lists every connector with kind, mode, atomic-write support, allowed fields (sensitive marked) and prefixes", async () => {
    render(<ConnectorsPage user={await as("operator")} />);
    expect(screen.getByTestId("state-loading")).toBeTruthy();
    const table = await screen.findByTestId("connectors-table");
    const rows = within(table).getAllByTestId("connector-row");
    expect(rows.map((r) => r.getAttribute("data-kind")).sort()).toEqual(["couchdb", "simulator", "simulator"]);
    expect(table.textContent).toMatch(/owner_label \(sensitive\)/);
    expect(table.textContent).toMatch(/Read-only/);
    expect(table.textContent).toMatch(/Writable/);
    expect(table.textContent).toMatch(/Disabled/);
    expect(table.textContent).toMatch(/Not live \(simulator\)/);
    const couch = rows.find((r) => r.getAttribute("data-kind") === "couchdb")!;
    expect(couch.textContent).not.toMatch(/Not live/); // the CouchDB connector is a real provider kind, labelled as such
    expect(rows.filter((r) => r.getAttribute("data-kind") === "simulator").every((r) => /Not live \(simulator\)/.test(r.textContent ?? ""))).toBe(true);
    expect(document.body.textContent).toMatch(/Only admins can change connectors/);
  });

  it("an admin does not see the 'only admins' hint", async () => {
    render(<ConnectorsPage user={await as("admin")} />);
    await screen.findByTestId("connectors-table");
    expect(document.body.textContent).not.toMatch(/Only admins can change connectors/);
  });

  it("a workspace with no connector shows an explicit empty state", async () => {
    render(<ConnectorsPage user={await as("operatorB")} />);
    expect((await screen.findByTestId("state-empty")).textContent).toMatch(/No connector is configured yet/);
  });
});

describe("members page", () => {
  it("a non-admin is told only admins can manage members and no request for the list is made", async () => {
    render(<MembersPage user={await as("operator")} />);
    expect(screen.getByTestId("forbidden-note").textContent).toMatch(/Only admins/);
    expect(screen.queryByTestId("member-form")).toBeNull();
  });

  it("admin: lists members, adds one (form resets, notice shown, table grows), and a duplicate email shows the server's error", async () => {
    render(<MembersPage user={await as("admin")} />);
    const table = await screen.findByTestId("members-table");
    const before = within(table).getAllByTestId("member-row").length;
    const form = screen.getByTestId("member-form") as HTMLFormElement;
    const email = form.querySelector('input[name="email"]') as HTMLInputElement;
    const password = form.querySelector('input[name="password"]') as HTMLInputElement;
    const role = form.querySelector('select[name="role"]') as HTMLSelectElement;
    expect(role.value).toBe("viewer");
    fireEvent.change(email, { target: { value: "web-added@example.test" } });
    fireEvent.change(password, { target: { value: newPassword() } });
    fireEvent.change(role, { target: { value: "operator" } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Added web-added@example.test"));
    await waitFor(() => expect(within(screen.getByTestId("members-table")).getAllByTestId("member-row").length).toBe(before + 1));
    expect(email.value).toBe("");
    // duplicate
    fireEvent.change(email, { target: { value: "web-added@example.test" } });
    fireEvent.change(password, { target: { value: newPassword() } });
    fireEvent.submit(form);
    expect((await screen.findByTestId("member-error")).textContent).toMatch(/already registered/);
    // short password is rejected by the server (the browser's minLength is bypassed by fireEvent)
    fireEvent.change(email, { target: { value: "web-short@example.test" } });
    fireEvent.change(password, { target: { value: "short" } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByTestId("member-error").textContent).toMatch(/validation/i));
    expect(await d.env.kit.db.query("SELECT 1 FROM users WHERE email = $1", ["web-short@example.test"])).toMatchObject({ rows: [] });
    expect(await d.env.count("users")).toBeGreaterThanOrEqual(6);
  });
});
