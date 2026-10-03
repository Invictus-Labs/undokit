import type { Scalar } from "../domain/types.js";
import {
  ConnectorAmbiguousError,
  ConnectorRejectedError,
  ConnectorUnavailableError,
  type ConnectorRecord,
  type CrmConnector,
  type WriteResult,
} from "./crm.js";
import { assertOutboundAllowed } from "./outbound.js";

export interface CouchdbOptions {
  baseUrl: string;
  database: string;
  timeoutMs: number;
  credentials: { username: string; password: string };
  allowedHosts: readonly string[];
  fetchImpl?: typeof fetch;
}

const MAX_BODY_BYTES = 1024 * 1024;
const NEVER_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
  requestId: string | null;
}

/**
 * Real provider connector: records are CouchDB documents, the version token is the document `_rev`.
 * CouchDB rejects any update whose `_rev` is not the latest (409), atomically, so the version
 * precondition is enforced by the provider (docs/PROVIDER-DECISION.md has the empirical record).
 * This is a record-store provider, not a CRM product; it is labelled accordingly.
 */
export class CouchdbConnector implements CrmConnector {
  readonly kind = "couchdb" as const;
  readonly live = true;
  readonly label = "CouchDB provider (live record store; not a CRM product)";
  readonly supportsAtomicConditionalWrite = true;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;

  constructor(private readonly opts: CouchdbOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.authHeader = `Basic ${Buffer.from(`${opts.credentials.username}:${opts.credentials.password}`).toString("base64")}`;
  }

  private docUrl(recordRef: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    return `${base}/${encodeURIComponent(this.opts.database)}/${encodeURIComponent(recordRef)}`;
  }

  /**
   * One HTTP exchange inside the caller's deadline: the allowlist/DNS check, the request and the body read
   * all count against the same budget. Never follows redirects; re-validates the target against the allowlist.
   */
  private http(method: string, url: string, body: unknown, d: Deadline): Promise<HttpResult> {
    return Promise.race([this.exchange(method, url, body, d), d.expired]);
  }

  private async exchange(method: string, url: string, body: unknown, d: Deadline): Promise<HttpResult> {
    await assertOutboundAllowed(url, this.opts.allowedHosts);
    if (method === "PUT" && !d.fired) d.sent = true;
    const res = await this.fetchImpl(url, {
      method,
      redirect: "manual",
      signal: d.signal,
      headers: { authorization: this.authHeader, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await readLimited(res);
    let parsed: Record<string, unknown> | null = null;
    if (text.length > 0) {
      try {
        const j: unknown = JSON.parse(text);
        parsed = j !== null && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, body: parsed, requestId: res.headers.get("x-couch-request-id") };
  }

  async ping(): Promise<void> {
    const d = startDeadline(this.opts.timeoutMs);
    try {
      const res = await this.http("GET", this.opts.baseUrl.replace(/\/+$/, "") + "/", undefined, d);
      if (res.status !== 200) throw new ConnectorUnavailableError(`provider returned status ${res.status}`);
    } catch (err) {
      throw asUnavailable(err);
    } finally {
      d.clear();
    }
  }

  async read(recordRef: string): Promise<ConnectorRecord | null> {
    const d = startDeadline(this.opts.timeoutMs);
    try {
      return await this.readWithin(recordRef, d);
    } finally {
      d.clear();
    }
  }

  private async readWithin(recordRef: string, d: Deadline): Promise<ConnectorRecord | null> {
    let res: HttpResult;
    try {
      res = await this.http("GET", this.docUrl(recordRef), undefined, d);
    } catch (err) {
      throw asUnavailable(err);
    }
    if (res.status === 404) return null;
    if (res.status !== 200 || !res.body) throw new ConnectorUnavailableError(`provider returned status ${res.status}`);
    const rev = res.body["_rev"];
    if (typeof rev !== "string") throw new ConnectorUnavailableError("provider document has no revision");
    return { record_ref: recordRef, version: rev, fields: scalarFields(res.body) };
  }

  /** The whole conditional write (allowlist/DNS, read, PUT and the 409 re-read) shares one `timeoutMs` deadline. */
  async conditionalWrite(
    recordRef: string,
    patch: Readonly<Record<string, Scalar>>,
    expectedVersion: string,
    ctx: { requestId: string },
  ): Promise<WriteResult> {
    const d = startDeadline(this.opts.timeoutMs);
    try {
      return await this.writeWithin(recordRef, patch, expectedVersion, ctx, d);
    } finally {
      d.clear();
    }
  }

  private async writeWithin(
    recordRef: string,
    patch: Readonly<Record<string, Scalar>>,
    expectedVersion: string,
    ctx: { requestId: string },
    d: Deadline,
  ): Promise<WriteResult> {
    // Step 1 (early exit only): read the document at its current revision.
    let current: HttpResult;
    try {
      current = await this.http("GET", this.docUrl(recordRef), undefined, d);
    } catch (err) {
      throw asUnavailable(err); // nothing was sent that could change state
    }
    if (current.status === 404) throw new ConnectorRejectedError("record not found", 404);
    if (current.status !== 200 || !current.body) throw new ConnectorUnavailableError(`provider returned status ${current.status}`);
    const currentRev = current.body["_rev"];
    if (typeof currentRev !== "string") throw new ConnectorUnavailableError("provider document has no revision");
    if (currentRev !== expectedVersion) {
      return { outcome: "conflict", current_version: currentRev, provider_request_id: current.requestId ?? ctx.requestId };
    }
    // Step 2: merge only the patched members into the document read at that revision.
    const merged: Record<string, unknown> = { ...current.body, ...patch, _rev: expectedVersion };
    // Step 3: the provider evaluates `_rev` and the write as one atomic step. A 409 means someone else won.
    let res: HttpResult;
    try {
      res = await this.http("PUT", this.docUrl(recordRef), merged, d);
    } catch (err) {
      if (err instanceof DeadlineError || d.fired) {
        throw d.sent
          ? new ConnectorAmbiguousError("deadline exceeded after the request was sent; outcome unknown")
          : new ConnectorUnavailableError("deadline exceeded before the request was sent");
      }
      if (err instanceof ConnectorUnavailableError) throw err;
      const code = causeCode(err);
      if (code && NEVER_SENT_CODES.has(code)) throw new ConnectorUnavailableError("provider connection failed before the request was sent");
      if (err instanceof Error && err.name === "AppError") throw new ConnectorRejectedError("outbound request blocked by allowlist", 0);
      throw new ConnectorAmbiguousError("request may have reached the provider; outcome unknown");
    }
    const requestId = res.requestId ?? ctx.requestId;
    if (res.status === 201) {
      const rev = res.body?.["rev"];
      if (typeof rev !== "string") throw new ConnectorAmbiguousError("provider accepted the write but returned no revision");
      return { outcome: "written", new_version: rev, provider_request_id: requestId };
    }
    if (res.status === 409) {
      let latest = "unknown";
      try {
        const again = await this.readWithin(recordRef, d);
        if (again) latest = again.version;
      } catch {
        /* keep "unknown": the conflict itself is already certain */
      }
      return { outcome: "conflict", current_version: latest, provider_request_id: requestId };
    }
    if (res.status === 202 || res.status >= 500) {
      throw new ConnectorAmbiguousError(`provider returned status ${res.status}; outcome unknown`);
    }
    throw new ConnectorRejectedError(`provider rejected the write with status ${res.status}`, res.status);
  }
}

class DeadlineError extends Error {
  constructor() {
    super("connector deadline exceeded");
    this.name = "DeadlineError";
  }
}

interface Deadline {
  signal: AbortSignal;
  /** Rejects with DeadlineError when the budget is spent. */
  expired: Promise<never>;
  /** True once the PUT may have left this process. */
  sent: boolean;
  fired: boolean;
  clear(): void;
}

function startDeadline(ms: number): Deadline {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const d: Deadline = {
    signal: controller.signal,
    sent: false,
    fired: false,
    expired: new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        d.fired = true;
        controller.abort();
        reject(new DeadlineError());
      }, ms);
    }),
    clear: () => clearTimeout(timer),
  };
  d.expired.catch(() => undefined);
  return d;
}

function scalarFields(doc: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith("_")) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function causeCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const direct = (err as { code?: unknown }).code;
    if (typeof direct === "string") return direct;
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") return (cause as { code: string }).code;
  }
  return undefined;
}

function asUnavailable(err: unknown): Error {
  if (err instanceof ConnectorUnavailableError) return err;
  if (err instanceof Error && err.name === "AppError") return new ConnectorUnavailableError(err.message);
  return new ConnectorUnavailableError("provider is not reachable");
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ConnectorAmbiguousError("provider response exceeded the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
