import { createHash } from "node:crypto";

/**
 * UndoKit canonical JSON v1 (compatible with RFC 8785 for the value domain used here):
 * UTF-8 text, no insignificant whitespace, object keys sorted by UTF-16 code unit order,
 * strings and numbers serialized exactly as ECMAScript JSON.stringify does, `-0` normalized
 * to `0`. `undefined`, functions, symbols, bigint, NaN and Infinity are rejected rather than
 * silently dropped so two different documents can never hash alike.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonical JSON: non-finite number at ${path}`);
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonical JSON: non-plain object at ${path}`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const child = record[key];
        if (child === undefined) throw new TypeError(`canonical JSON: undefined at ${path}.${key}`);
        parts.push(`${JSON.stringify(key)}:${serialize(child, `${path}.${key}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON: unsupported ${typeof value} at ${path}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Content hash of a document: `sha256:` + hex over its canonical JSON. */
export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
