import { describe, expect, it } from "vitest";
import { REDACTED, SecretRegistry, redactDeep, redactText } from "../../src/domain/redact.js";
import { escapeHtml } from "../../src/domain/html.js";
import { leakedNeedles, loadHostile, loadSecrets } from "../helpers/fixtures.js";

const secrets = loadSecrets();
const registryNeedles = secrets.planted.filter((p) => p.kind === "registry").map((p) => p.value);
const patternNeedles = secrets.planted.filter((p) => p.kind === "pattern").map((p) => p.value);

describe("AC-09 redaction (unit)", () => {
  it("authorization headers, bearer tokens and planted fake keys are redacted", () => {
    const text = `request failed. Authorization: Bearer ${patternNeedles[0]} note: ${patternNeedles[1]}`;
    const out = redactText(text);
    expect(leakedNeedles(out)).toEqual([]);
    expect(out).toContain(REDACTED);
  });

  it("auth schemes are redacted even when the credential has no recognisable shape", () => {
    const out = redactText("sent Bearer abcd1234wxyz and Basic dXNlcjpwYXNzd29yZA== and Token zz99yy88xx");
    expect(out).not.toContain("abcd1234wxyz");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("zz99yy88xx");
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(redactText("Authorization: Bearer abcd1234wxyz")).not.toContain("abcd1234wxyz");
  });

  it("key=value credentials in logs and urls are redacted: password, api_key, cookie", () => {
    const out = redactText("login password=hunter2hunter2 api_key: qwertyuiop12 cookie=sessionvalue99 user=alice");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).not.toContain("qwertyuiop12");
    expect(out).not.toContain("sessionvalue99");
    expect(out).toContain("user=alice");
  });

  it("registered exact secrets are scrubbed even though they carry no recognisable shape", () => {
    const registry = new SecretRegistry();
    for (const s of registryNeedles) registry.add(s);
    const text = `connector login failed for ${registryNeedles.join(" and ")}`;
    const out = redactText(text, registry);
    expect(leakedNeedles(out)).toEqual([]);
  });

  it("sensitive object keys are always redacted regardless of content, nested and in arrays", () => {
    const input = {
      name: "ok",
      authorization: "anything at all",
      nested: { password: "hunter2hunter2", list: [{ api_key: "short" }, { fine: "value" }] },
      token: null,
    };
    const out = redactDeep(input);
    expect(out.authorization).toBe(REDACTED);
    expect(out.nested.password).toBe(REDACTED);
    expect(out.nested.list[0]).toEqual({ api_key: REDACTED });
    expect(out.nested.list[1]).toEqual({ fine: "value" });
    expect(out.name).toBe("ok");
    expect(out.token).toBeNull();
  });

  it("redactDeep scrubs planted secrets in any string leaf and does not mutate its input", () => {
    const registry = new SecretRegistry();
    for (const s of registryNeedles) registry.add(s);
    const input = { note: `see ${patternNeedles[1]}`, deep: { arr: [`x ${registryNeedles[0]} y`] } };
    const snapshot = JSON.stringify(input);
    const out = redactDeep(input, registry);
    expect(leakedNeedles(JSON.stringify(out))).toEqual([]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is idempotent and keeps harmless text intact", () => {
    const text = "Contact contact-0001 moved from lead to customer on 2026-01-15";
    expect(redactText(text)).toBe(text);
    const once = redactText(`token: ${patternNeedles[0]}`);
    expect(redactText(once)).toBe(once);
  });

  it("depth guard: a pathologically deep value is replaced, not recursed forever", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 100; i += 1) deep = { child: deep };
    const out = JSON.stringify(redactDeep(deep));
    expect(out).toContain(REDACTED);
  });

  it("a 100,000-character hostile string is redacted in bounded time (no catastrophic backtracking)", () => {
    const evil = `${"a-".repeat(50_000)}${patternNeedles[1]}`;
    const t0 = performance.now();
    const out = redactText(evil);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(leakedNeedles(out)).toEqual([]);
  });

  it("ignores registry entries shorter than 4 characters (no mass-replace of common substrings)", () => {
    const registry = new SecretRegistry();
    registry.add("ab");
    registry.add("");
    registry.add(undefined);
    registry.add(null);
    expect(redactText("a table about cabs", registry)).toBe("a table about cabs");
  });
});

describe("AC-09 hostile HTML renders as text (unit)", () => {
  it.each(loadHostile().html_payloads.map((p) => [p.name, p.value] as const))("escapeHtml neutralizes: %s", (_name, payload) => {
    const out = escapeHtml(payload);
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
    // Round trip: the original text is still fully recoverable for display.
    const decoded = out
      .replace(/&#96;/g, "`")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
    expect(decoded).toBe(payload);
  });
});
