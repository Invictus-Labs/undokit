/**
 * Optional ecosystem adapter boundary (PRD section 6).
 *
 * Versioned event envelope, consumer-side dedupe, major-version rejection and
 * ordering metadata. This module is self-contained: it has no dependency on any
 * sibling product and never triggers a compensation. An adapter event is a hint
 * to look at a resource; it is never evidence of current state.
 */

export const SUPPORTED_MAJOR_VERSION = 1;

export interface AdapterEnvelope {
  schema_version: number;
  event_id: string;
  source: string;
  resource_id: string;
  event_type: string;
  occurred_at: string;
  revision: number | string;
  evidence_ref: string;
  correlation_id?: string;
}

export type EnvelopeRejection = "not_an_object" | "missing_field" | "invalid_field" | "unsupported_major_version" | "oversize";

export type EnvelopeResult =
  | { ok: true; envelope: AdapterEnvelope }
  | { ok: false; reason: EnvelopeRejection; field?: string; message: string };

const REQUIRED_STRINGS = ["event_id", "source", "resource_id", "event_type", "occurred_at", "evidence_ref"] as const;
const MAX_FIELD_LENGTH = 512;
const MAX_ENVELOPE_CHARS = 16 * 1024;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/** True only for a real calendar instant: Date.parse alone rolls 2026-02-30 over to March 2. */
function isRealUtcInstant(text: string): boolean {
  const m = ISO_UTC.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (h > 23 || mi > 59 || sec > 59) return false;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function reject(reason: EnvelopeRejection, message: string, field?: string): EnvelopeResult {
  return field === undefined ? { ok: false, reason, message } : { ok: false, reason, field, message };
}

/** Validate an untrusted value as an adapter envelope. Never throws. */
export function parseEnvelope(input: unknown): EnvelopeResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return reject("not_an_object", "Envelope must be a JSON object");
  }
  let size: number;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return reject("invalid_field", "Envelope is not serialisable");
  }
  if (size > MAX_ENVELOPE_CHARS) return reject("oversize", `Envelope exceeds ${MAX_ENVELOPE_CHARS} characters`);
  const record = input as Record<string, unknown>;

  const version = record["schema_version"];
  if (version === undefined) return reject("missing_field", "schema_version is required", "schema_version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return reject("invalid_field", "schema_version must be a positive integer", "schema_version");
  }
  if (version !== SUPPORTED_MAJOR_VERSION) {
    return reject(
      "unsupported_major_version",
      `Unsupported schema_version ${version}; this consumer supports ${SUPPORTED_MAJOR_VERSION}`,
      "schema_version",
    );
  }

  for (const field of REQUIRED_STRINGS) {
    const value = record[field];
    if (value === undefined) return reject("missing_field", `${field} is required`, field);
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LENGTH) {
      return reject("invalid_field", `${field} must be a non-empty string up to ${MAX_FIELD_LENGTH} characters`, field);
    }
  }
  const occurredAt = record["occurred_at"] as string;
  if (!isRealUtcInstant(occurredAt)) {
    return reject("invalid_field", "occurred_at must be an ISO-8601 UTC timestamp", "occurred_at");
  }

  const revision = record["revision"];
  if (revision === undefined) return reject("missing_field", "revision is required", "revision");
  const revisionOk =
    (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) ||
    (typeof revision === "string" && revision.length > 0 && revision.length <= MAX_FIELD_LENGTH);
  if (!revisionOk) return reject("invalid_field", "revision must be a non-negative integer or non-empty string", "revision");

  const correlation = record["correlation_id"];
  if (correlation !== undefined && (typeof correlation !== "string" || correlation.length === 0 || correlation.length > MAX_FIELD_LENGTH)) {
    return reject("invalid_field", "correlation_id must be a non-empty string when present", "correlation_id");
  }

  const envelope: AdapterEnvelope = {
    schema_version: version,
    event_id: record["event_id"] as string,
    source: record["source"] as string,
    resource_id: record["resource_id"] as string,
    event_type: record["event_type"] as string,
    occurred_at: occurredAt,
    revision: revision as number | string,
    evidence_ref: record["evidence_ref"] as string,
  };
  if (typeof correlation === "string") envelope.correlation_id = correlation;
  return { ok: true, envelope };
}

/** Outcome of offering one event to the consumer. */
export type IngestOutcome =
  | { status: "accepted"; envelope: AdapterEnvelope; stale: boolean; hint: string }
  | { status: "duplicate"; event_id: string }
  | { status: "rejected"; reason: EnvelopeRejection | "adapter_disabled"; message: string; field?: string };

export interface AdapterConsumerOptions {
  /** Master switch. Adapters are disabled by default; a disabled consumer rejects everything. */
  enabled?: boolean;
  /** Bound on remembered event ids (oldest evicted first). */
  maxRemembered?: number;
}

/**
 * At-least-once consumer. Dedupes on event_id, rejects unsupported major
 * versions and keeps the highest revision seen per (source, resource_id) so
 * callers can see that an event is stale. It records metadata only: it never
 * stores or derives current record state from an event, and it has no way to
 * start a compensation. The `hint` text says so explicitly for operators.
 */
export class AdapterConsumer {
  private readonly enabled: boolean;
  private readonly maxRemembered: number;
  private readonly seen = new Set<string>();
  private readonly highest = new Map<string, { revision: number | string; occurred_at: string }>();
  private readonly log: AdapterEnvelope[] = [];

  constructor(options: AdapterConsumerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.maxRemembered = Math.max(1, options.maxRemembered ?? 10_000);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  ingest(input: unknown): IngestOutcome {
    if (!this.enabled) {
      return { status: "rejected", reason: "adapter_disabled", message: "Ecosystem adapter is disabled (default); enable it explicitly to accept events" };
    }
    const parsed = parseEnvelope(input);
    if (!parsed.ok) {
      return parsed.field === undefined
        ? { status: "rejected", reason: parsed.reason, message: parsed.message }
        : { status: "rejected", reason: parsed.reason, message: parsed.message, field: parsed.field };
    }
    const envelope = parsed.envelope;
    if (this.seen.has(envelope.event_id)) return { status: "duplicate", event_id: envelope.event_id };

    this.seen.add(envelope.event_id);
    if (this.seen.size > this.maxRemembered) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    // JSON array encoding is injective: no pair of values can produce another pair's key.
    const key = JSON.stringify([envelope.source, envelope.resource_id]);
    const previous = this.highest.get(key);
    const stale = previous !== undefined && compareRevision(envelope.revision, previous.revision) < 0;
    if (!stale) this.highest.set(key, { revision: envelope.revision, occurred_at: envelope.occurred_at });
    this.log.push(envelope);
    if (this.log.length > this.maxRemembered) this.log.shift();

    return {
      status: "accepted",
      envelope,
      stale,
      hint: stale
        ? `Older revision than one already seen; ignore for state, keep as history. Re-read the provider before acting.${
            typeof envelope.revision === "string" || typeof previous?.revision === "string" ? " Revisions are opaque strings, so their order is unknown; this comparison may be wrong." : ""
          }`
        : "Event recorded as a link only. Current record state must be re-read from the provider; no compensation is started by an event.",
    };
  }

  /** Events in arrival order, with their original version metadata untouched. */
  events(): readonly AdapterEnvelope[] {
    return this.log;
  }

  /** Same events ordered by (occurred_at, revision) for display; arrival order stays in events(). */
  eventsByOccurrence(): AdapterEnvelope[] {
    return [...this.log].sort(
      (a, b) => a.occurred_at.localeCompare(b.occurred_at) || compareRevision(a.revision, b.revision) || a.event_id.localeCompare(b.event_id),
    );
  }
}

/** Numbers compare numerically; mixed or string revisions compare as opaque strings (stable, never "newer" by guess). */
export function compareRevision(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
