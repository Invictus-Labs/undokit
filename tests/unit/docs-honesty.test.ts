// Documentation must not claim behavior the code does not have (found by the independent review). These checks pin the
// corrected wording; each fails against the earlier text.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const ops = read("docs/OPERATIONS.md");
const runbook = read("docs/RUNBOOK.md");
const readme = read("README.md");

describe("docs do not overclaim", () => {
  it("the key file is documented as living in the data directory by default, with a recommendation to keep it elsewhere", () => {
    expect(ops).toMatch(/by default the key file lives inside the data directory/);
    expect(ops).toMatch(/tar.{0,80}includes the key/s);
    expect(ops).toContain("UNDOKIT_KEY_FILE");
    expect(ops).not.toMatch(/kept \*\*outside\*\* the database\. Losing/);
    expect(readme).toMatch(/by default the key file is inside the data directory/);
  });

  it("retention, 24-hour deletion, capacity pre-checks and personal-field log redaction are marked NOT IMPLEMENTED, not promised", () => {
    expect(ops).toMatch(/Retention: NOT IMPLEMENTED/);
    expect(ops).toMatch(/NOT IMPLEMENTED/);
    expect(ops).not.toMatch(/Work fails before starting when capacity is insufficient/);
    expect(ops).not.toMatch(/Capacity check fails before work starts/);
    expect(ops).not.toMatch(/Logs redact credentials, authorization headers and personal fields/);
    expect(ops).not.toMatch(/primary deletion completes within 24 hours of a deletion\s+request;/);
    expect(ops).toMatch(/no application logger is enabled/i);
  });

  it("the backup path is described as untested, with no CLI command, and PostgreSQL guidance is explicitly untested", () => {
    expect(ops).toMatch(/not exercised by any automated\s+test/);
    expect(ops).toMatch(/no CLI command/);
    expect(ops).toMatch(/PostgreSQL/);
    expect(ops).toMatch(/This guidance is untested/);
    expect(readme).toMatch(/not covered by an\s+automated test/);
  });

  it("the runbook and operations guide describe the uncertainty contract: applying recovers to unknown, and NOT_APPLIED waits for the quiet period", () => {
    expect(runbook).toMatch(/becomes `unknown`/);
    expect(runbook).not.toMatch(/Wait for lease reclaim, then re-read the state\. Never re-issue the write\.\s*\|$/m);
    expect(runbook).toMatch(/quiet period/);
    expect(runbook).not.toMatch(/\| `failed` \| Confirmed non-effect\. Nothing to undo\. \|/);
    expect(ops).toMatch(/quiet period/);
  });

  it("the TLS proxy setting, the minimums and the key-over-existing-data refusal are documented", () => {
    expect(ops).toContain("UNDOKIT_TRUST_PROXY=1");
    expect(ops).toMatch(/\*\*overwrite\*\* `X-Forwarded-Proto`/);
    expect(ops).toMatch(/already holds data/);
    expect(ops).toMatch(/at least 5/);
    expect(ops).toMatch(/13500/);
  });

  it("bundle integrity is described as tamper-evident only, the daemon-stopped requirement and the quiet reconcile failure are stated", () => {
    for (const doc of [readme, ops]) expect(doc).toMatch(/tamper-evident only/);
    expect(ops).toMatch(/recomputes every\s+hash verifies and imports/);
    expect(ops).toContain("POST /api/v1/exports");
    expect(runbook).toContain("POST /api/v1/exports");
    expect(runbook).toMatch(/needs the daemon stopped/);
    expect(runbook).not.toMatch(/reconciliation fails explicitly \(503/);
    expect(runbook).toMatch(/still returns 202/);
    expect(ops).not.toMatch(/Connector check fails with 503 \/ exit 3/);
  });

  it("the late-result reopening and the one-unresolved-operation-per-record guard are documented", () => {
    for (const term of ["LATE_RESULT", "apply.reopened", "UNRESOLVED_OPERATION"]) expect(ops, term).toContain(term);
    expect(runbook).toContain("UNRESOLVED_OPERATION");
    expect(runbook).toContain("LATE_RESULT");
    expect(ops).toMatch(/one consistent snapshot/);
  });

  it("the resolve endpoint, hop-based proxy trust and the concurrency limits are documented", () => {
    for (const term of ["/resolve", "OPERATOR_RESOLVED", "call the provider"]) expect(ops, term).toContain(term);
    expect(runbook).toContain("/resolve");
    expect(ops).toMatch(/only after a\s+reconcile run has read the provider/);
    for (const code of ["STATE_AMBIGUOUS", "RECORD_MISSING", "QUIET_PERIOD"]) expect(ops, code).toContain(code);
    expect(ops).toMatch(/never trusts "every hop"/);
    expect(ops).toContain("UNDOKIT_TRUST_PROXY=1");
    const kl = read("docs/KNOWN-LIMITATIONS.md");
    for (const term of ["No maximum job runtime", "application clock", "provider-side delay after the client gave up", "embedded database only", "fails before dispatch", "host name"]) expect(kl.toLowerCase(), term).toContain(term.toLowerCase());
  });

  it("the human drill names the exact kit, the expected outputs, the cleanup receipt and what the participant sends back", () => {
    const drill = read("docs/HUMAN-DRILL.md");
    expect(existsSync(join(ROOT, "scripts/make-drill-kit.sh"))).toBe(true);
    for (const term of ["make-drill-kit.sh", "DRILL-KIT.txt", "Typical output", "Cleanup receipt", "what the participant must send back", "PENDING_HUMAN_RECEIPT"]) expect(drill, term).toContain(term);
    expect(drill).toMatch(/Checks: 7\/7 passed/);
  });

  it("known limitations exist, each with a severity, and the README points to them and warns that the gate exits 0 with AC-07 NOT RUN", () => {
    expect(existsSync(join(ROOT, "docs/KNOWN-LIMITATIONS.md"))).toBe(true);
    const kl = read("docs/KNOWN-LIMITATIONS.md");
    for (const term of ["mismatch", "Idempotency-Key", "Resolving an UNKNOWN by hand", "tamper-evident only", "exits 0 with AC-07 NOT RUN", "Outbound allowlist", "worker does not restart"]) expect(kl, term).toContain(term);
    expect(kl.match(/\| P[23] \|/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(readme).toContain("docs/KNOWN-LIMITATIONS.md");
    expect(readme).toMatch(/exits 0 when every automated step passes/);
  });
});
