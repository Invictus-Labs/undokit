import { describe, expect, it } from "vitest";
import { isExactNumberLiteral, scanObject, spliceMembers } from "../../src/connectors/raw-json.js";

describe("raw-json: lossless member splicing for provider documents", () => {
  it("finds top-level members without converting values, skipping braces and quotes inside strings", () => {
    const text = ' { "a" : 9007199254740993 , "b":{"x":"}\\"]"},"c":[1,[2]],"d":"q"}';
    const { members } = scanObject(text);
    expect(members.map((m) => [m.key, m.raw])).toEqual([
      ["a", "9007199254740993"],
      ["b", '{"x":"}\\"]"}'],
      ["c", "[1,[2]]"],
      ["d", '"q"'],
    ]);
  });

  it("replaces only the named members and keeps every other byte, whitespace included", () => {
    const text = '{"a":1e400,\n  "b": "old" ,"n":{"big":18446744073709551615}}';
    expect(spliceMembers(text, new Map([["b", '"new"']]))).toBe('{"a":1e400,\n  "b": "new" ,"n":{"big":18446744073709551615}}');
  });

  it("appends absent members (with or without existing members) and rewrites every occurrence of a duplicated name", () => {
    expect(spliceMembers("{}", new Map([["a", "1"]]))).toBe('{"a":1}');
    expect(spliceMembers('{"x":2}', new Map([["a", "true"]]))).toBe('{"x":2,"a":true}');
    expect(spliceMembers('{"a":1,"a":2}', new Map([["a", "3"]]))).toBe('{"a":3,"a":3}');
  });

  it("rejects text that is not a JSON object", () => {
    for (const bad of ["[1]", '{"a" 1}', '{"a":1', '{"a":"x', "{a:1}", '{"a":}']) expect(() => scanObject(bad), bad).toThrow(SyntaxError);
  });

  it("classifies number literals by whether float64 holds their value exactly", () => {
    for (const ok of ["0", "-0", "42", "-17", "1.5", "1.50", "0.1", "1e2", "1.0e2", "9007199254740991", "-9007199254740991", "1e21", "5e-324", "123.456e-2"]) {
      expect(isExactNumberLiteral(ok), ok).toBe(true);
    }
    for (const bad of ["9007199254740993", "18446744073709551615", "-12345678901234567890123", "1e400", "-1e400", "1e-400", "0.1000000000000000055511151231257827"]) {
      expect(isExactNumberLiteral(bad), bad).toBe(false);
    }
  });
});
