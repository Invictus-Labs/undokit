/**
 * Lossless helpers for provider documents. JSON.parse/JSON.stringify round-trips every number through float64, so a
 * write built from a parsed document silently rewrites members it never meant to touch (integers above 2^53 are
 * rounded, out-of-range literals become null). These helpers work on the provider's raw text instead: they locate
 * the top-level members and splice new values into only the members being patched, leaving every other byte as is.
 *
 * Inputs must already be valid JSON (callers run JSON.parse first); the scanner only finds boundaries.
 */

export interface RawMember {
  key: string;
  /** Raw source text of the member's value, exactly as the provider sent it. */
  raw: string;
  valueStart: number;
  valueEnd: number;
}

export interface RawObject {
  members: RawMember[];
  /** Index of the object's closing brace. */
  close: number;
}

function isWs(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i])) i += 1;
  return i;
}

function skipString(s: string, i: number): number {
  i += 1; // opening quote
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    else i += 1;
  }
  throw new SyntaxError("unterminated string");
}

function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        i = skipString(s, i);
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new SyntaxError("unterminated container");
  }
  const start = i;
  while (i < s.length && !isWs(s[i]) && s[i] !== "," && s[i] !== "}" && s[i] !== "]") i += 1;
  if (i === start) throw new SyntaxError("missing value");
  return i;
}

/** Locate the members of a top-level JSON object without converting any value. */
export function scanObject(text: string): RawObject {
  let i = skipWs(text, 0);
  if (text[i] !== "{") throw new SyntaxError("not a JSON object");
  i = skipWs(text, i + 1);
  const members: RawMember[] = [];
  if (text[i] === "}") return { members, close: i };
  for (;;) {
    if (text[i] !== '"') throw new SyntaxError("expected a member name");
    const keyStart = i;
    i = skipString(text, i);
    const key = JSON.parse(text.slice(keyStart, i)) as string;
    i = skipWs(text, i);
    if (text[i] !== ":") throw new SyntaxError("expected ':'");
    i = skipWs(text, i + 1);
    const valueStart = i;
    i = skipValue(text, i);
    members.push({ key, raw: text.slice(valueStart, i), valueStart, valueEnd: i });
    i = skipWs(text, i);
    if (text[i] === ",") {
      i = skipWs(text, i + 1);
      continue;
    }
    if (text[i] === "}") return { members, close: i };
    throw new SyntaxError("expected ',' or '}'");
  }
}

/**
 * Return `text` with each top-level member named in `replacements` set to the given (already serialized) JSON value.
 * Every occurrence of a replaced name is rewritten; names not present are appended before the closing brace. All
 * other bytes, including untouched members, nested values, `_attachments` stubs and whitespace, are kept verbatim.
 */
export function spliceMembers(text: string, replacements: ReadonlyMap<string, string>): string {
  const { members, close } = scanObject(text);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const present = new Set<string>();
  for (const m of members) {
    present.add(m.key);
    const value = replacements.get(m.key);
    if (value !== undefined) edits.push({ start: m.valueStart, end: m.valueEnd, text: value });
  }
  const added = [...replacements].filter(([k]) => !present.has(k)).map(([k, v]) => `${JSON.stringify(k)}:${v}`);
  if (added.length > 0) edits.push({ start: close, end: close, text: (members.length > 0 ? "," : "") + added.join(",") });
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const NUMBER_RE = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function normalizeDecimal(literal: string): string | null {
  const m = NUMBER_RE.exec(literal);
  if (!m) return null;
  const frac = m[2] ?? "";
  let digits = (m[1] + frac).replace(/^0+/, "");
  if (digits === "") return "0";
  let exp = Number(m[3] ?? "0") - frac.length;
  const trailing = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - trailing);
  exp += trailing;
  return `${literal.startsWith("-") ? "-" : ""}${digits}e${exp}`;
}

/**
 * True when a JSON number literal survives a float64 round trip with its value unchanged, i.e. when writing back the
 * parsed number would not alter it. 9007199254740993 (rounds to ...992) and 1e400 (becomes Infinity, written as null)
 * are not exact.
 */
export function isExactNumberLiteral(literal: string): boolean {
  const n = Number(literal);
  if (!Number.isFinite(n)) return false;
  const a = normalizeDecimal(literal);
  return a !== null && a === normalizeDecimal(String(n));
}
