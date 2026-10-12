#!/usr/bin/env node
// Builds the gate receipt JSON from the step TSV written by scripts/verify-quality.sh.
//   node scripts/write-receipt.mjs <steps.tsv> <out.json> <key=value>...
// TSV columns: name, status, exit_code, started_utc, seconds, command
import { readFileSync, writeFileSync } from "node:fs";

const [tsv, out, ...kv] = process.argv.slice(2);
if (!tsv || !out) {
  console.error("usage: write-receipt.mjs <steps.tsv> <out.json> [key=value...]");
  process.exit(2);
}
const meta = {};
for (const pair of kv) {
  const i = pair.indexOf("=");
  if (i > 0) meta[pair.slice(0, i)] = pair.slice(i + 1);
}
const steps = readFileSync(tsv, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, status, exit_code, started_utc, seconds, command] = line.split("\t");
    return { name, status, exit_code: Number(exit_code), started_utc, seconds: Number(seconds), command };
  });
writeFileSync(out, `${JSON.stringify({ receipt_version: 1, ...meta, steps }, null, 2)}\n`);
console.log(`receipt written: ${out}`);
