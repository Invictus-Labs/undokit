#!/usr/bin/env node
// UndoKit secret and planted-needle scanner (QA-owned).
//
// Modes:
//   node scripts/secret-scan.mjs                 scan tracked and untracked-but-not-ignored repo files
//   node scripts/secret-scan.mjs --dir <path>    scan every file under <path> (build output, logs, extracted tarball)
//   node scripts/secret-scan.mjs --file <path>   scan one file
//
// Exit 0: clean. Exit 1: at least one finding. Exit 2: usage or read error.
// Findings print file:line and the rule name only. Matched values are never printed.
//
// Fixtures that intentionally hold FAKE secrets (fixtures/, tests/, docs/qa/) are excluded from the repo
// scan; the dedicated tests assert that those needles never reach logs, reports, bundles or the package.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const RULES = [
  ["aws-access-key-id", new RegExp("AK" + "IA[0-9A-Z]{16}")],
  ["github-token", new RegExp("gh[pousr]" + "_[A-Za-z0-9]{36,}")],
  ["slack-token", new RegExp("xox[baprs]" + "-[A-Za-z0-9-]{10,}")],
  ["private-key-block", new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")],
  ["bearer-token-literal", new RegExp("[Bb]earer\\s+[A-Za-z0-9._~+/-]{24,}={0,2}")],
  ["live-style-secret-key", new RegExp("\\bsk" + "_(?:live|test)_[A-Za-z0-9]{16,}")],
  [
    "assigned-secret-literal",
    new RegExp("(?:api[_-]?key|secret|passw(?:or)?d|token)[\"']?\\s*[:=]\\s*[\"'][A-Za-z0-9/+_.-]{20,}[\"']", "i"),
  ],
];

const EXCLUDED_PREFIXES = ["fixtures/", "tests/", "docs/qa/", "node_modules/", "dist/", "coverage/", ".undokit/"];
const EXCLUDED_FILES = new Set(["scripts/secret-scan.mjs", "package-lock.json"]);
const MAX_BYTES = 5 * 1024 * 1024;

function loadNeedles() {
  const file = join(root, "fixtures", "planted-fakes.json");
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed.needles) ? parsed.needles : [];
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return false;
  return true;
}

function scanText(label, text, needles, findings) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const [name, re] of RULES) {
      if (re.test(line)) findings.push(`${label}:${idx + 1} rule=${name}`);
    }
    for (const needle of needles) {
      if (line.includes(needle)) findings.push(`${label}:${idx + 1} rule=planted-fake-secret`);
    }
  });
}

function scanFile(abs, label, needles, findings) {
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    console.error(`secret-scan: cannot read ${label}: ${err.code ?? "error"}`);
    process.exit(2);
  }
  if (!st.isFile()) return;
  if (st.size > MAX_BYTES) {
    findings.push(`${label}:0 rule=file-too-large-to-scan`);
    return;
  }
  const buf = readFileSync(abs);
  if (!isProbablyText(buf)) {
    const hay = buf.toString("latin1");
    for (const needle of needles) if (hay.includes(needle)) findings.push(`${label}:0 rule=planted-fake-secret(binary)`);
    return;
  }
  scanText(label, buf.toString("utf8"), needles, findings);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
}

const args = process.argv.slice(2);
const needles = loadNeedles();
const findings = [];
let scanned = 0;

if (args[0] === "--dir" && args[1]) {
  const base = resolve(args[1]);
  const files = [];
  walk(base, files);
  for (const f of files) {
    scanFile(f, relative(base, f), needles, findings);
    scanned += 1;
  }
} else if (args[0] === "--file" && args[1]) {
  scanFile(resolve(args[1]), args[1], needles, findings);
  scanned = 1;
} else if (args.length === 0) {
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const rel of listed) {
    if (EXCLUDED_FILES.has(rel)) continue;
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    scanFile(join(root, rel), rel, needles, findings);
    scanned += 1;
  }
} else {
  console.error("usage: secret-scan.mjs [--dir <path> | --file <path>]");
  process.exit(2);
}

if (scanned === 0) {
  console.error("secret-scan: VACUOUS RUN, scanned 0 files");
  process.exit(2);
}
if (findings.length > 0) {
  console.error(`secret-scan: ${findings.length} finding(s) in ${scanned} file(s)`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`secret-scan: clean (${scanned} files, ${needles.length} planted needles checked)`);
