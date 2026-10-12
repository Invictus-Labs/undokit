// @vitest-environment jsdom
// App shell, login, routing and role gating against the real in-process daemon (no route mocks).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "../../src/web/App.js";
import { configureApi } from "../../src/web/api.js";
import type { Daemon } from "../helpers/daemon.js";
import { freshBrowser, go, signInAs, tidy, webDaemon } from "../helpers/web.js";

let d: Daemon;
beforeAll(async () => {
  d = await webDaemon({ sensitiveFields: ["owner_label"] });
}, 90_000);
afterAll(async () => {
  await d.close();
});
afterEach(tidy);

const text = () => document.body.textContent ?? "";

describe("login and session", () => {
  it("shows loading, then the sign-in form when nobody is signed in", async () => {
    freshBrowser(d);
    render(<App />);
    expect(screen.getByTestId("app-loading").textContent).toContain("Loading");
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    expect(text()).toContain("no default password");
  });

  it("a wrong password shows the server's error and no session; the right one signs in and shows who and which role", async () => {
    freshBrowser(d);
    render(<App />);
    const form = await screen.findByTestId("login-form");
    const email = form.querySelector('input[name="email"]') as HTMLInputElement;
    const password = form.querySelector('input[name="password"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: d.env.emails.operator } });
    fireEvent.change(password, { target: { value: "definitely-wrong-password" } });
    fireEvent.submit(form);
    expect((await screen.findByTestId("login-error")).textContent).toMatch(/incorrect/i);
    expect(screen.queryByTestId("whoami")).toBeNull();
    fireEvent.change(password, { target: { value: d.env.passwords.operator } });
    fireEvent.submit(form);
    expect((await screen.findByTestId("whoami")).textContent).toContain("(operator)");
  });

  it("sign out returns to the form and a reload stays signed out", async () => {
    await signInAs(d, "operator");
    render(<App />);
    fireEvent.click(await screen.findByTestId("sign-out"));
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    tidy();
    render(<App />);
    expect(await screen.findByTestId("login-form")).toBeTruthy();
  });

  it("an unreachable server shows an explicit error, not a blank page", async () => {
    configureApi({ baseUrl: "http://127.0.0.1:1" });
    render(<App />);
    expect((await screen.findByTestId("app-error")).textContent).toMatch(/unreachable/i);
  });

  it("a server that is not ready shows the app error with the server's reason", async () => {
    await signInAs(d, "operator");
    const before = d.env.kit.readiness;
    d.env.kit.readiness = { ...before, ok: false, error: "migration failed (test)" };
    try {
      render(<App />);
      expect((await screen.findByTestId("app-error")).textContent).toMatch(/not ready/i);
    } finally {
      d.env.kit.readiness = before;
    }
  });
});

describe("routing and role gating", () => {
  it("operator: the operations list, new plan form, connectors and an unknown route; no Members link", async () => {
    await signInAs(d, "operator");
    render(<App />);
    await screen.findByTestId("whoami");
    expect(screen.queryByText("Members")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Operations" })).toBeTruthy();
    go("#/operations/new");
    expect(await screen.findByTestId("plan-form")).toBeTruthy();
    go("#/connectors");
    expect(await screen.findByTestId("connectors-table")).toBeTruthy();
    go("#/members");
    expect((await screen.findByTestId("forbidden-note")).textContent).toMatch(/only admins/i);
    go("#/no/such/page");
    expect((await screen.findByTestId("not-found")).textContent).toContain("Page not found");
    go("#/operations");
    expect(await screen.findByRole("heading", { name: "Operations" })).toBeTruthy();
    go("#/");
    expect(await screen.findByRole("heading", { name: "Operations" })).toBeTruthy();
  });

  it("admin: sees the Members link and the members table", async () => {
    await signInAs(d, "admin");
    render(<App />);
    await screen.findByTestId("whoami");
    expect(screen.getByText("Members")).toBeTruthy();
    go("#/members");
    expect(await screen.findByTestId("members-table")).toBeTruthy();
    expect(screen.getAllByTestId("member-row").length).toBeGreaterThanOrEqual(3);
  });

  it("viewer: reads, sees the viewer note and no Members link", async () => {
    await signInAs(d, "viewer");
    render(<App />);
    expect((await screen.findByTestId("whoami")).textContent).toContain("(viewer)");
    expect(await screen.findByTestId("viewer-note")).toBeTruthy();
    expect(screen.queryByTestId("export-button")).toBeNull();
    expect(screen.queryByText("Members")).toBeNull();
  });

  it("a hash that is an operation id with extra path parts falls back to the list", async () => {
    await signInAs(d, "operator");
    render(<App />);
    await screen.findByTestId("whoami");
    go("#/operations/abc/def");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Operations" })).toBeTruthy());
  });
});
