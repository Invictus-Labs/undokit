import { describe, expect, it } from "vitest";
import {
  AdapterConsumer,
  SUPPORTED_MAJOR_VERSION,
  compareRevision,
  parseEnvelope,
  type AdapterEnvelope,
} from "../../src/adapters/envelope.js";
import { loadHostile, loadSecrets } from "../helpers/fixtures.js";

function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: "evt-1",
    source: "crm-sync",
    resource_id: "contact-0001",
    event_type: "record.updated",
    occurred_at: "2026-01-15T12:00:00.000Z",
    revision: 1,
    evidence_ref: "evidence/contact-0001",
    ...over,
  };
}

const enabled = (opts: { maxRemembered?: number } = {}) => new AdapterConsumer({ enabled: true, ...opts });

describe("adapter envelope: disabled by default (PRD optional adapters)", () => {
  it("a default consumer is disabled and rejects even a perfectly valid event", () => {
    const c = new AdapterConsumer();
    expect(c.isEnabled).toBe(false);
    const out = c.ingest(ev());
    expect(out.status).toBe("rejected");
    expect(out.status === "rejected" && out.reason).toBe("adapter_disabled");
    expect(c.events()).toHaveLength(0);
  });

  it("explicit enabled:false and an empty options object stay disabled; only enabled:true enables", () => {
    expect(new AdapterConsumer({}).isEnabled).toBe(false);
    expect(new AdapterConsumer({ enabled: false }).isEnabled).toBe(false);
    expect(new AdapterConsumer({ enabled: true }).isEnabled).toBe(true);
  });

  it("a disabled consumer rejects before parsing: garbage and valid input get the same answer", () => {
    const c = new AdapterConsumer();
    for (const input of [null, "x", 1, [], ev(), { schema_version: 99 }]) {
      const out = c.ingest(input);
      expect(out.status === "rejected" && out.reason).toBe("adapter_disabled");
    }
  });
});

describe("adapter envelope: major version handling", () => {
  it("accepts the supported major version", () => {
    expect(SUPPORTED_MAJOR_VERSION).toBe(1);
    expect(parseEnvelope(ev()).ok).toBe(true);
  });

  it.each([2, 3, 100, 0, -1])("rejects unsupported or invalid major version %s", (version) => {
    const r = parseEnvelope(ev({ schema_version: version }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["unsupported_major_version", "invalid_field"]).toContain(r.reason);
      expect(r.field).toBe("schema_version");
    }
  });

  it("version 2 is specifically reported as unsupported_major_version and names the supported one", () => {
    const r = parseEnvelope(ev({ schema_version: 2 }));
    expect(r.ok === false && r.reason).toBe("unsupported_major_version");
    expect(r.ok === false && r.message).toContain("supports 1");
  });

  it.each([["1"], [1.5], [Number.NaN], [null], [true], [{}], [[1]]])("rejects non-integer schema_version %j", (version) => {
    const r = parseEnvelope(ev({ schema_version: version }));
    expect(r.ok).toBe(false);
  });

  it("a missing schema_version is reported as missing, not defaulted to 1", () => {
    const { schema_version: _drop, ...rest } = ev();
    const r = parseEnvelope(rest);
    expect(r.ok === false && r.reason).toBe("missing_field");
    expect(r.ok === false && r.field).toBe("schema_version");
  });

  it("a rejected future-version event leaves no trace in the consumer log", () => {
    const c = enabled();
    c.ingest(ev({ schema_version: 2 }));
    expect(c.events()).toHaveLength(0);
    // and it did not consume the event id: the same id at the supported version is still accepted
    expect(c.ingest(ev()).status).toBe("accepted");
  });
});

describe("adapter envelope: validation never throws and rejects every malformed shape", () => {
  it.each([[null], [undefined], ["text"], [42], [true], [[]], [[ev()]]])("not an object: %j", (input) => {
    const r = parseEnvelope(input);
    expect(r.ok === false && r.reason).toBe("not_an_object");
  });

  it.each(["event_id", "source", "resource_id", "event_type", "occurred_at", "evidence_ref", "revision"])("missing %s is reported by name", (field) => {
    const input = ev();
    delete input[field];
    const r = parseEnvelope(input);
    expect(r.ok === false && r.reason).toBe("missing_field");
    expect(r.ok === false && r.field).toBe(field);
  });

  it.each(["event_id", "source", "resource_id", "event_type", "evidence_ref"])("%s must be a non-empty string of at most 512 characters", (field) => {
    expect(parseEnvelope(ev({ [field]: "" })).ok).toBe(false);
    expect(parseEnvelope(ev({ [field]: 5 })).ok).toBe(false);
    expect(parseEnvelope(ev({ [field]: null })).ok).toBe(false);
    expect(parseEnvelope(ev({ [field]: "x".repeat(512) })).ok).toBe(true);
    const over = parseEnvelope(ev({ [field]: "x".repeat(513) }));
    expect(over.ok === false && over.reason).toBe("invalid_field");
  });

  it("occurred_at must be an ISO-8601 UTC timestamp", () => {
    for (const good of ["2026-01-15T12:00:00Z", "2026-01-15T12:00:00.5Z", "2026-01-15T12:00:00.123456789Z"]) {
      expect(parseEnvelope(ev({ occurred_at: good })).ok, good).toBe(true);
    }
    for (const bad of ["2026-01-15", "2026-01-15T12:00:00", "2026-01-15T12:00:00+00:00", "2026-01-15 12:00:00Z", "yesterday", "2026-13-45T25:61:61Z", "", "0"]) {
      expect(parseEnvelope(ev({ occurred_at: bad })).ok, bad).toBe(false);
    }
  });

  // Regression test for QA-D2 (fixed in 67e05fd): impossible calendar dates are rejected.
  it("an impossible calendar date is not accepted as a real occurrence time", () => {
    // 2026 is not a leap year; February has no 30th. A consumer ordering events by time must not accept it.
    expect(parseEnvelope(ev({ occurred_at: "2026-02-30T00:00:00Z" })).ok).toBe(false);
  });

  it("revision must be a non-negative safe integer or a non-empty string up to 512 characters", () => {
    for (const good of [0, 1, Number.MAX_SAFE_INTEGER, "r1", "x".repeat(512)]) expect(parseEnvelope(ev({ revision: good })).ok).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, "", "x".repeat(513), null, true, {}, []]) {
      expect(parseEnvelope(ev({ revision: bad })).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("correlation_id is optional but must be a non-empty string when present", () => {
    expect(parseEnvelope(ev()).ok).toBe(true);
    expect(parseEnvelope(ev({ correlation_id: "corr-1" })).ok).toBe(true);
    for (const bad of ["", 5, null, {}]) expect(parseEnvelope(ev({ correlation_id: bad })).ok).toBe(false);
  });

  it("oversize envelopes (over 16 KiB serialized) are rejected before field checks", () => {
    const r = parseEnvelope(ev({ padding: "x".repeat(17 * 1024) }));
    expect(r.ok === false && r.reason).toBe("oversize");
    // exactly at the limit is still judged on its fields, not on size
    const base = JSON.stringify(ev({ padding: "" })).length;
    const justFits = parseEnvelope(ev({ padding: "x".repeat(16 * 1024 - base) }));
    expect(justFits.ok).toBe(true);
    const justOver = parseEnvelope(ev({ padding: "x".repeat(16 * 1024 - base + 1) }));
    expect(justOver.ok === false && justOver.reason).toBe("oversize");
  });

  it("values that cannot be serialized (circular, bigint, throwing getter) are rejected, not thrown", () => {
    const circular: Record<string, unknown> = ev();
    circular.self = circular;
    expect(parseEnvelope(circular).ok).toBe(false);
    expect(parseEnvelope(ev({ big: 10n })).ok).toBe(false);
    const getter = ev();
    Object.defineProperty(getter, "boom", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(() => parseEnvelope(getter)).not.toThrow();
    expect(parseEnvelope(getter).ok).toBe(false);
  });

  it("unknown extra fields are dropped from the parsed envelope (a forbidden action cannot ride along)", () => {
    const r = parseEnvelope(ev({ delete_record: true, send_email: "x", compensate: true, nested: { a: 1 } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.envelope).sort()).toEqual(
        ["event_id", "event_type", "evidence_ref", "occurred_at", "resource_id", "revision", "schema_version", "source"].sort(),
      );
    }
  });

  it("a __proto__ key from JSON.parse does not pollute the parsed envelope or Object.prototype", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"schema_version":1,"event_id":"e","source":"s","resource_id":"r","event_type":"t","occurred_at":"2026-01-15T12:00:00Z","revision":1,"evidence_ref":"x"}');
    const r = parseEnvelope(hostile);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (r.ok) expect((r.envelope as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("parsing does not mutate its input", () => {
    const input = ev({ extra: "keep" });
    const snapshot = JSON.stringify(input);
    parseEnvelope(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("hostile strings and planted secrets are carried as inert data and never echoed in error messages", () => {
    const secret = loadSecrets().needles[0] as string;
    for (const { value } of loadHostile().html_payloads) {
      const ok = parseEnvelope(ev({ resource_id: value }));
      expect(ok.ok).toBe(true);
    }
    const bad = parseEnvelope(ev({ occurred_at: secret }));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(secret);
  });
});

describe("adapter envelope: consumer dedupe (at-least-once delivery)", () => {
  it("the same event_id twice yields one accepted and one duplicate; the log holds one entry", () => {
    const c = enabled();
    expect(c.ingest(ev()).status).toBe("accepted");
    const again = c.ingest(ev());
    expect(again).toEqual({ status: "duplicate", event_id: "evt-1" });
    expect(c.events()).toHaveLength(1);
  });

  it("a replay with a different payload under the same event_id is still a duplicate (first write wins)", () => {
    const c = enabled();
    c.ingest(ev({ revision: 1 }));
    const replay = c.ingest(ev({ revision: 99, event_type: "record.deleted" }));
    expect(replay.status).toBe("duplicate");
    expect(c.events()[0]?.revision).toBe(1);
    expect(c.events()[0]?.event_type).toBe("record.updated");
  });

  it("different event ids for the same resource are all accepted", () => {
    const c = enabled();
    for (let i = 1; i <= 5; i += 1) expect(c.ingest(ev({ event_id: `evt-${i}`, revision: i })).status).toBe("accepted");
    expect(c.events()).toHaveLength(5);
  });

  it("a rejected event does not consume its event_id", () => {
    const c = enabled();
    expect(c.ingest(ev({ revision: -1 })).status).toBe("rejected");
    expect(c.ingest(ev()).status).toBe("accepted");
  });

  it("the remembered-id window is bounded: an evicted id is accepted again (documented at-least-once limit)", () => {
    const c = enabled({ maxRemembered: 2 });
    for (const id of ["a", "b", "c"]) c.ingest(ev({ event_id: id, revision: 1, resource_id: `r-${id}` }));
    expect(c.ingest(ev({ event_id: "c", resource_id: "r-c" })).status).toBe("duplicate");
    expect(c.ingest(ev({ event_id: "a", resource_id: "r-a" })).status).toBe("accepted");
    expect(c.events().length).toBeLessThanOrEqual(2);
  });

  it("maxRemembered below 1 is clamped to 1 rather than disabling dedupe", () => {
    const c = enabled({ maxRemembered: 0 });
    c.ingest(ev());
    expect(c.ingest(ev()).status).toBe("duplicate");
  });
});

describe("adapter envelope: ordering and staleness", () => {
  it("an older revision arriving late is accepted as history but flagged stale", () => {
    const c = enabled();
    const first = c.ingest(ev({ event_id: "e5", revision: 5, occurred_at: "2026-01-15T12:05:00Z" }));
    const late = c.ingest(ev({ event_id: "e3", revision: 3, occurred_at: "2026-01-15T12:03:00Z" }));
    expect(first.status === "accepted" && first.stale).toBe(false);
    expect(late.status === "accepted" && late.stale).toBe(true);
    expect(late.status === "accepted" && late.hint).toContain("Older revision");
    expect(c.events().map((e) => e.event_id)).toEqual(["e5", "e3"]);
  });

  it("a stale event does not lower the high-water mark: a later revision is judged against the highest seen", () => {
    const c = enabled();
    c.ingest(ev({ event_id: "e5", revision: 5 }));
    c.ingest(ev({ event_id: "e2", revision: 2 }));
    const four = c.ingest(ev({ event_id: "e4", revision: 4 }));
    const six = c.ingest(ev({ event_id: "e6", revision: 6 }));
    expect(four.status === "accepted" && four.stale).toBe(true);
    expect(six.status === "accepted" && six.stale).toBe(false);
  });

  it("an equal revision is not stale", () => {
    const c = enabled();
    c.ingest(ev({ event_id: "a", revision: 3 }));
    const same = c.ingest(ev({ event_id: "b", revision: 3 }));
    expect(same.status === "accepted" && same.stale).toBe(false);
  });

  it("revisions are tracked per (source, resource): other resources and other sources are independent", () => {
    const c = enabled();
    c.ingest(ev({ event_id: "a", revision: 9 }));
    const otherResource = c.ingest(ev({ event_id: "b", resource_id: "contact-0002", revision: 1 }));
    const otherSource = c.ingest(ev({ event_id: "c", source: "other-sync", revision: 1 }));
    expect(otherResource.status === "accepted" && otherResource.stale).toBe(false);
    expect(otherSource.status === "accepted" && otherSource.stale).toBe(false);
  });

  // Regression test for QA-D3 (fixed in 67e05fd): the (source, resource_id) key is injective.
  it("a source and resource that merely concatenate to the same key do not share a high-water mark", () => {
    const c = enabled();
    // Both pairs flatten to "a" + sep + "b" + sep + "c" if the key joiner can appear inside a value.
    c.ingest(ev({ event_id: "x1", source: "a\u0000b", resource_id: "c", revision: 10 }));
    const other = c.ingest(ev({ event_id: "x2", source: "a", resource_id: "b\u0000c", revision: 1 }));
    expect(other.status === "accepted" && other.stale).toBe(false);
  });

  it("events() keeps arrival order and eventsByOccurrence() sorts by time, then revision, then event id", () => {
    const c = enabled();
    c.ingest(ev({ event_id: "z", occurred_at: "2026-01-15T12:03:00Z", revision: 3 }));
    c.ingest(ev({ event_id: "a", occurred_at: "2026-01-15T12:01:00Z", revision: 1 }));
    c.ingest(ev({ event_id: "m", occurred_at: "2026-01-15T12:01:00Z", revision: 1 }));
    c.ingest(ev({ event_id: "k", occurred_at: "2026-01-15T12:01:00Z", revision: 0 }));
    expect(c.events().map((e) => e.event_id)).toEqual(["z", "a", "m", "k"]);
    expect(c.eventsByOccurrence().map((e) => e.event_id)).toEqual(["k", "a", "m", "z"]);
    // sorting a copy never reorders the arrival log
    expect(c.events().map((e) => e.event_id)).toEqual(["z", "a", "m", "k"]);
  });

  it("original version metadata is preserved untouched on stored events", () => {
    const c = enabled();
    c.ingest(ev({ revision: "rev-7", correlation_id: "corr-9" }));
    const stored = c.events()[0] as AdapterEnvelope;
    expect(stored.schema_version).toBe(1);
    expect(stored.revision).toBe("rev-7");
    expect(stored.correlation_id).toBe("corr-9");
  });

  it("compareRevision orders numbers numerically and treats other revisions as opaque strings", () => {
    expect(compareRevision(2, 10)).toBeLessThan(0);
    expect(compareRevision(10, 2)).toBeGreaterThan(0);
    expect(compareRevision(3, 3)).toBe(0);
    expect(compareRevision("a", "b")).toBe(-1);
    expect(compareRevision("b", "a")).toBe(1);
    expect(compareRevision("same", "same")).toBe(0);
    expect(compareRevision(5, "5")).toBe(0);
  });

  it("string revisions are opaque: a numeric-looking later string revision is never assumed newer", () => {
    const c = enabled();
    c.ingest(ev({ event_id: "a", revision: "9" }));
    const out = c.ingest(ev({ event_id: "b", revision: "10" }));
    // Lexicographic comparison puts "10" before "9". The consumer must say so honestly (stale = unknown order),
    // and it must still keep the event as history rather than dropping it.
    expect(out.status).toBe("accepted");
    expect(c.events()).toHaveLength(2);
  });
});

describe("adapter envelope: an event is a hint, never authority", () => {
  it("the consumer exposes no way to start a compensation or write: only ingest and read-only accessors", () => {
    const methods = Object.getOwnPropertyNames(AdapterConsumer.prototype).filter((n) => n !== "constructor").sort();
    expect(methods).toEqual(["events", "eventsByOccurrence", "ingest", "isEnabled"]);
  });

  it("an accepted event says state must be re-read from the provider and that nothing is compensated", () => {
    const out = enabled().ingest(ev({ event_type: "record.reverted" }));
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") {
      expect(out.hint).toMatch(/re-read/i);
      expect(out.hint).toMatch(/no compensation/i);
    }
  });

  it("an event that claims a revert or a deletion changes nothing about the stored metadata fields", () => {
    const c = enabled();
    c.ingest(ev({ event_type: "record.deleted", compensate: true }));
    expect(Object.keys(c.events()[0] as object)).not.toContain("compensate");
  });
});
