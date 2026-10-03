// Helpers for jsdom UI tests (QA-owned). The UI talks to a REAL in-process daemon (real Fastify app, real worker, real database)
// over localhost. The only thing added here is a cookie jar around fetch, which is what a browser does for the session cookie.
import { cleanup } from "@testing-library/react";
import { configureApi, signIn } from "../../src/web/api.js";
import { startDaemon, type Daemon } from "./daemon.js";
import type { EnvOptions } from "./kit.js";

export type Who = "admin" | "operator" | "viewer" | "adminB" | "operatorB";

export function jarFetch(): typeof fetch {
  let cookie = "";
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(input, { ...init, headers });
    const set = res.headers.get("set-cookie");
    const match = set ? /undokit_session=[^;]*/.exec(set) : null;
    if (match) cookie = match[0];
    return res;
  };
}

/** Point the web client at the daemon with a fresh cookie jar (a new "browser"). */
export function freshBrowser(d: Daemon): void {
  configureApi({ baseUrl: d.url, fetch: jarFetch() });
  window.location.hash = "";
}

export async function webDaemon(opts: EnvOptions & { worker?: boolean } = {}): Promise<Daemon> {
  const d = await startDaemon(opts);
  freshBrowser(d);
  return d;
}

export async function signInAs(d: Daemon, who: Who): Promise<void> {
  freshBrowser(d);
  await signIn(d.env.emails[who], d.env.passwords[who]);
}

export function tidy(): void {
  cleanup();
  window.location.hash = "";
}

export function go(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
