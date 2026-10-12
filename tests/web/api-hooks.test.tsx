// @vitest-environment jsdom
// Web client (api.ts) and hooks. Page-level behavior is tested against the real daemon elsewhere; the transport-failure cases here
// (unreadable body, network error) use the documented `configureApi({ fetch })` seam, since a healthy real server cannot be made to send them.
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, api, canOperate, configureApi, download, isAdmin, loadSession, mutate, signIn, signOut, type User } from "../../src/web/api.js";
import { useHashPath, useResource } from "../../src/web/hooks.js";
import type { Daemon } from "../helpers/daemon.js";
import { go, jarFetch, signInAs, tidy, webDaemon } from "../helpers/web.js";

let d: Daemon;
beforeAll(async () => {
  d = await webDaemon();
}, 90_000);
afterAll(async () => {
  await d.close();
});
afterEach(() => {
  tidy();
  vi.restoreAllMocks();
});

const fetchReturning = (make: () => Response | Promise<Response>): typeof fetch => (async () => make()) as unknown as typeof fetch;

describe("api client against the real daemon", () => {
  it("session lifecycle: 401 is 'not signed in', sign in sets the CSRF token used by mutations, sign out clears it", async () => {
    configureApi({ baseUrl: d.url, fetch: jarFetch() });
    expect(await loadSession()).toBeNull();
    const user = await signIn(d.env.emails.operator, d.env.passwords.operator);
    expect(user).toMatchObject({ email: d.env.emails.operator, role: "operator" });
    expect(canOperate(user)).toBe(true);
    expect(isAdmin(user)).toBe(false);
    expect((await loadSession())?.email).toBe(d.env.emails.operator);
    const plan = await mutate<{ id: string }>("/operations", { connector_id: d.env.connectorId, record_ref: "contact-0001", patch: { lead_score: 45 }, expected_version: d.env.sim.snapshot("contact-0001")!.version });
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
    await signOut();
    await expect(api("POST", "/operations", {}, { "idempotency-key": "x" })).rejects.toMatchObject({ status: 401 });
  });

  it("canOperate and isAdmin by role", () => {
    const u = (role: User["role"]) => ({ id: "x", email: "e", display_name: null, workspace_id: "w", workspace_name: "n", role });
    expect([canOperate(u("admin")), canOperate(u("operator")), canOperate(u("viewer"))]).toEqual([true, true, false]);
    expect([isAdmin(u("admin")), isAdmin(u("operator")), isAdmin(u("viewer"))]).toEqual([true, false, false]);
  });

  it("an error body becomes an ApiError with status, code, details and the request reference in the message", async () => {
    await signInAs(d, "operator");
    const err = await api("POST", "/operations", { connector_id: d.env.connectorId, record_ref: "outside-0001", patch: { lifecycle_stage: "customer" }, expected_version: "sim-v1" }, { "idempotency-key": "api-1" }).catch((e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ name: "ApiError", status: 422, code: "RECORD_OUT_OF_SCOPE" });
    expect((err as ApiError).message).toMatch(/\(reference [0-9a-f-]{36}\)/);
    expect((err as ApiError).details?.[0]?.code).toBe("RECORD_OUT_OF_SCOPE");
  });

  it("loadSession rethrows anything that is not a 401 (an unready server is not 'signed out')", async () => {
    await signInAs(d, "operator");
    const before = d.env.kit.readiness;
    d.env.kit.readiness = { ...before, ok: false, error: "simulated outage" };
    try {
      await expect(loadSession()).rejects.toMatchObject({ status: 503, code: "NOT_READY" });
    } finally {
      d.env.kit.readiness = before;
    }
  });

  it("download: a refused export is an ApiError and triggers no save-as", async () => {
    await signInAs(d, "operator");
    const created = vi.fn();
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => {
      created();
      return "blob:x";
    };
    const before = d.env.kit.readiness;
    d.env.kit.readiness = { ...before, ok: false, error: "simulated outage" };
    try {
      await expect(download("POST", "/exports", "x.json", {})).rejects.toMatchObject({ status: 503 });
    } finally {
      d.env.kit.readiness = before;
    }
    expect(created).not.toHaveBeenCalled();
  });

  it("download: a GET download with no body saves the file under the given name", async () => {
    await signInAs(d, "operator");
    const names: string[] = [];
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await download("GET", "/status", "status.json");
    expect(names).toEqual(["status.json"]);
  });
});

describe("transport failures (documented fetch seam)", () => {
  it("an unreadable response body is 'invalid_response'", async () => {
    configureApi({ fetch: fetchReturning(() => new Response("<html>proxy error</html>", { status: 200 })) });
    await expect(api("GET", "/status")).rejects.toMatchObject({ status: 200, code: "invalid_response" });
  });

  it("an empty successful body is null, and an empty error body falls back to the HTTP status", async () => {
    configureApi({ fetch: fetchReturning(() => new Response(null, { status: 204 })) });
    expect(await api("POST", "/auth/logout", {})).toBeNull();
    configureApi({ fetch: fetchReturning(() => new Response("", { status: 502 })) });
    await expect(api("GET", "/status")).rejects.toMatchObject({ status: 502, code: "error", message: "HTTP 502" });
  });

  it("a network failure is 'network_error' with advice, for requests and downloads", async () => {
    configureApi({ fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch });
    await expect(api("GET", "/status")).rejects.toMatchObject({ status: 0, code: "network_error" });
    await expect(download("GET", "/status", "x")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("configureApi resets the CSRF token so a new browser never reuses an old one", async () => {
    await signInAs(d, "operator");
    configureApi({ baseUrl: d.url, fetch: jarFetch() });
    await expect(api("POST", "/auth/logout", {})).rejects.toMatchObject({ status: 401 });
  });
});

function Probe({ path, poll }: { path: string | null; poll?: (d: { id?: string }) => boolean }) {
  const [state, reload] = useResource<{ id?: string; status?: string }>(path, poll, 40);
  return (
    <div>
      <span data-testid="s">{state.status}</span>
      {state.status === "error" ? <span data-testid="m">{state.message}</span> : null}
      <button type="button" onClick={reload}>
        reload
      </button>
    </div>
  );
}

describe("hooks", () => {
  it("useResource: loading, ready, error (then reload recovers), and a null path never loads", async () => {
    await signInAs(d, "operator");
    const { rerender } = render(<Probe path={null} />);
    expect(screen.getByTestId("s").textContent).toBe("loading");
    rerender(<Probe path="/health-does-not-exist" />);
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("error"));
    expect(screen.getByTestId("m").textContent).toMatch(/no such route/i);
    rerender(<Probe path="/status" />);
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("ready"));
    fireEvent.click(screen.getByText("reload"));
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("ready"));
  });

  it("useResource polls while shouldPoll holds and stops when it no longer does; unmount cancels the timer", async () => {
    await signInAs(d, "operator");
    let polls = 0;
    const calls = vi.spyOn(globalThis, "fetch");
    const { unmount } = render(
      <Probe
        path="/status"
        poll={() => {
          polls += 1;
          return polls < 4;
        }}
      />,
    );
    await waitFor(() => expect(polls).toBe(4), { timeout: 3000 });
    const settled = calls.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.mock.calls.length).toBe(settled); // stopped polling
    polls = 0;
    unmount();
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.mock.calls.length).toBe(settled); // nothing after unmount
  });

  it("useResource ignores a slow earlier response after the path changed (last request wins)", async () => {
    await signInAs(d, "operator");
    const { rerender } = render(<Probe path="/status" />);
    rerender(<Probe path="/health-does-not-exist" />);
    await waitFor(() => expect(screen.getByTestId("s").textContent).toBe("error"));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId("s").textContent).toBe("error");
  });

  it("useHashPath reads the current hash, defaults to '/', and follows hashchange events", () => {
    window.location.hash = "";
    const { result } = renderHook(() => useHashPath());
    expect(result.current).toBe("/");
    act(() => go("#/operations/abc"));
    expect(result.current).toBe("/operations/abc");
    act(() => go("#"));
    expect(result.current).toBe("/");
  });
});
