// HTTP client over Fastify inject (QA-owned): real server, real routes, real cookies and CSRF.
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

export const HOST = "undokit.test";
export const ORIGIN = `http://${HOST}`;

export interface Reply {
  status: number;
  body: any;
  text: string;
  headers: LightMyRequestResponse["headers"];
}

export interface Client {
  cookie: string;
  csrf: string;
  token: string;
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<Reply>;
  post(url: string, payload?: unknown, opts?: { headers?: Record<string, string>; raw?: string; contentType?: string }): Promise<Reply>;
  del(url: string): Promise<Reply>;
}

function toReply(res: LightMyRequestResponse): Reply {
  let body: unknown = undefined;
  try {
    body = res.body.length > 0 ? JSON.parse(res.body) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.statusCode, body, text: res.body, headers: res.headers };
}

export function anon(app: FastifyInstance) {
  return {
    async get(url: string, headers: Record<string, string> = {}) {
      return toReply(await app.inject({ method: "GET", url, headers: { host: HOST, ...headers } }));
    },
    async post(url: string, payload?: unknown, headers: Record<string, string> = {}, remoteAddress?: string) {
      const base = { method: "POST" as const, url, headers: { host: HOST, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) };
      return toReply(await app.inject(remoteAddress ? { ...base, remoteAddress } : base));
    },
  };
}

export async function login(app: FastifyInstance, email: string, password: string, remoteAddress?: string): Promise<{ reply: Reply; client?: Client }> {
  const base = { method: "POST" as const, url: "/api/v1/auth/login", headers: { host: HOST }, payload: { email, password } };
  const res = await app.inject(remoteAddress ? { ...base, remoteAddress } : base);
  const reply = toReply(res);
  if (reply.status !== 200) return { reply };
  const setCookie = String(res.headers["set-cookie"] ?? "");
  const token = /undokit_session=([^;]*)/.exec(setCookie)?.[1] ?? "";
  const cookie = `undokit_session=${token}`;
  const csrf = reply.body.csrf_token as string;
  const send = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, opts: { headers?: Record<string, string>; raw?: string; contentType?: string } = {}) => {
    const headers: Record<string, string> = { host: HOST, cookie, ...(method === "GET" ? {} : { "x-csrf-token": csrf, origin: ORIGIN }), ...opts.headers };
    if (opts.raw !== undefined) headers["content-type"] = opts.contentType ?? "application/json";
    return toReply(
      await app.inject({
        method,
        url,
        headers,
        ...(opts.raw !== undefined ? { payload: opts.raw } : payload === undefined ? {} : { payload: payload as object }),
      }),
    );
  };
  return {
    reply,
    client: {
      cookie,
      csrf,
      token,
      get: (url, opts) => send("GET", url, undefined, opts ?? {}),
      post: (url, payload, opts) => send("POST", url, payload, opts ?? {}),
      del: (url) => send("DELETE", url),
    },
  };
}
