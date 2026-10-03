// Shared fixture helpers (QA-owned). Everything here is synthetic and deterministic.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Fixed UTC clock for every default test. */
export const FIXED_NOW_ISO = "2026-01-15T12:00:00.000Z";
export const FIXED_NOW = new Date(FIXED_NOW_ISO);

export function fixedClock(offsetMs = 0): { now: () => Date } {
  return { now: () => new Date(FIXED_NOW.getTime() + offsetMs) };
}

/**
 * Deterministic synthetic UUID (version 4 shape) derived from a seed name.
 * Fixtures store seed names, not UUID literals, so no raw UUID is committed.
 */
export function syntheticUuid(seed: string): string {
  const h = createHash("sha256").update(`undokit-fixture:${seed}`).digest("hex");
  const variant = (parseInt(h.slice(16, 17), 16) & 0x3) | 0x8;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant.toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface DemoActor {
  seed: string;
  workspace: "A" | "B";
  role: "admin" | "operator" | "viewer";
  label: string;
}

export interface DemoFixture {
  fixture_version: string;
  clock_utc: string;
  approval_ttl_seconds: number;
  workspaces: { seed: string; name: string }[];
  actors: DemoActor[];
  connector: { seed: string; kind: string; name: string; allowlist: string[]; scope_prefix: string };
  records: { record_ref: string; version: string; fields: Record<string, unknown>; note?: string }[];
  scenarios: Record<string, { record_ref: string; patch: Record<string, unknown>; idempotency_key?: string; expected_before?: Record<string, unknown> }>;
  rejected_patches: { name: string; record_ref: string; patch: Record<string, unknown> }[];
}

export interface SecretsFixture {
  fixture_version: string;
  planted: { label: string; key: string; value: string }[];
  needles: string[];
}

export interface HostileFixture {
  fixture_version: string;
  html_payloads: { name: string; value: string }[];
  limits: { oversize_body_bytes: number; long_string_length: number };
  malformed_json_bodies: string[];
  path_traversal_entries: string[];
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", name), "utf8")) as T;
}

export const loadDemo = (): DemoFixture => load<DemoFixture>("demo.json");
export const loadSecrets = (): SecretsFixture => load<SecretsFixture>("planted-fakes.json");
export const loadHostile = (): HostileFixture => load<HostileFixture>("hostile.json");

export function workspaceId(which: "A" | "B"): string {
  const demo = loadDemo();
  const ws = demo.workspaces[which === "A" ? 0 : 1];
  if (!ws) throw new Error("fixture workspace missing");
  return syntheticUuid(ws.seed);
}

export function actorId(label: string): string {
  const actor = loadDemo().actors.find((a) => a.label === label);
  if (!actor) throw new Error(`fixture actor missing: ${label}`);
  return syntheticUuid(actor.seed);
}

export const connectorId = (): string => syntheticUuid(loadDemo().connector.seed);

/** Names of the planted fake secrets that appear in `haystack` (empty array means clean). */
export function leakedNeedles(haystack: string): string[] {
  return loadSecrets().needles.filter((n) => haystack.includes(n));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
