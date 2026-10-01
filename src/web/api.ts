/**
 * Thin client for the real /api/v1 backend. No route mocks live in production
 * code: every page loads through this module.
 */
import type { Role, SessionView } from "./model";

export type { Role };

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  workspace_id: string;
  workspace_name: string;
  role: Role;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: { code: string; field?: string; message: string }[],
  ) {
    super(requestId ? `${message} (reference ${requestId})` : message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
let baseUrl = "";
let fetchImpl: typeof fetch | undefined;

/**
 * Test and embedding seam. A browser uses the defaults (same-origin relative URLs and the global fetch).
 * A jsdom test points `baseUrl` at a real daemon and may pass a fetch that keeps cookies.
 */
export function configureApi(options: { baseUrl?: string; fetch?: typeof fetch } = {}): void {
  baseUrl = options.baseUrl ?? "";
  fetchImpl = options.fetch;
  csrfToken = null;
}

function send(path: string, init: RequestInit): Promise<Response> {
  return (fetchImpl ?? fetch)(`${baseUrl}/api/v1${path}`, init);
}

interface ErrorBody {
  error?: { code?: string; message?: string; request_id?: string; details?: { code: string; field?: string; message: string }[] };
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: ErrorBody | null;
  try {
    data = text ? (JSON.parse(text) as ErrorBody) : null;
  } catch {
    throw new ApiError(response.status, "invalid_response", "The server returned an unreadable response");
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.code ?? "error", data?.error?.message ?? `HTTP ${response.status}`, data?.error?.request_id, data?.error?.details);
  }
  return data as T;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function api<T>(method: Method, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const all: Record<string, string> = { ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) all["x-csrf-token"] = csrfToken;
  let response: Response;
  try {
    response = await send(path, { method, headers: all, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network_error", "UndoKit is unreachable; check that the server is running and retry");
  }
  return parse<T>(response);
}

/** Mutations carry an Idempotency-Key so a double click or retry cannot create a second operation. */
export function mutate<T>(path: string, body: unknown, key: string = crypto.randomUUID()): Promise<T> {
  return api<T>("POST", path, body, { "idempotency-key": key });
}

/** Download an authenticated file (evidence export) and hand it to the browser as a save-as. */
export async function download(method: "GET" | "POST", path: string, filename: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  let response: Response;
  try {
    response = await send(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network_error", "UndoKit is unreachable; check that the server is running and retry");
  }
  if (!response.ok) await parse<unknown>(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toUser(session: SessionView): User {
  return {
    id: session.user.id,
    email: session.user.email,
    display_name: session.user.display_name,
    workspace_id: session.workspace.id,
    workspace_name: session.workspace.name,
    role: session.role,
  };
}

/** Returns null when not signed in; throws for any other failure (unreachable server, 5xx). */
export async function loadSession(): Promise<User | null> {
  try {
    const session = await api<SessionView>("GET", "/auth/me");
    csrfToken = session.csrf_token;
    return toUser(session);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      csrfToken = null;
      return null;
    }
    throw error;
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  const session = await api<SessionView>("POST", "/auth/login", { email, password });
  csrfToken = session.csrf_token;
  return toUser(session);
}

export async function signOut(): Promise<void> {
  await api("POST", "/auth/logout", {});
  csrfToken = null;
}

export const canOperate = (user: User) => user.role === "admin" || user.role === "operator";
export const isAdmin = (user: User) => user.role === "admin";
