# UndoKit Definition of Done (verbatim from the product requirements)

Copied unchanged from PRD sections 5, 5b and 5c. Planned test pointers in 5b are predictions; the reconciled, real test IDs live in docs/qa/AC-MATRIX.md.

## 5. Acceptance Criteria

- [ ] **AC-01** — Allow only configured scalar CRM fields; reject deletion, sends, unknown fields and records outside connector scope before any write.
- [ ] **AC-02** — Persist before state and approved plan hash before dispatch; changed intent or expired approval invalidates authorization.
- [ ] **AC-03** — Use provider conditional writes; concurrent record modification returns CONFLICT without overwriting external changes.
- [ ] **AC-04** — Crash after remote success but before local receipt yields UNKNOWN and read-only reconciliation; retries never blindly repeat the mutation.
- [ ] **AC-05** — Compensation previews exact fields and requires separate approval; changed current values or versions block compensation.
- [ ] **AC-06** — Duplicate idempotency key and identical intent returns one operation; changed intent with same key returns 409.
- [ ] **AC-07** — A live sandbox drill changes an allowlisted field and restores its original value; a planted intervening edit remains untouched.
- [ ] **AC-08** — A synthetic demo works without paid accounts or mandatory telemetry; an outbound-denied test completes the deterministic local core. Live connector operations fail explicitly when disconnected.
- [ ] **AC-09** — Validate size and schema before processing; planted secret tokens never appear in logs or exported reports; malicious HTML renders as text.
- [ ] **AC-10** — Export a versioned evidence bundle and restore/read it in a clean installation with matching hashes; truncated or unsupported exports fail without partial accepted state.
- [ ] **AC-11** — Release documentation includes installation, upgrade, backup, restore and failure diagnosis; a fresh operator can execute the synthetic smoke procedure.
- [ ] **AC-12** — Enforce workspace membership and admin/operator/viewer roles on reads, writes, jobs and exports; cross-workspace object IDs return 404 with no state change.
- [ ] **AC-13** — Worker restart reclaims leased jobs without discarding uncertain external outcomes; failed migrations stop readiness and a restored backup preserves references.

## 5b. Test Strategy

**SEC · 04c — Test Strategy & DoD**

**13 mapped ACs / 13 total ACs. All tests are PLANNED; none is claimed to pass.**

| AC | Level | Proven by — planned behavior | Execution | Status |
| --- | --- | --- | --- | --- |
| AC-01 | Unit + integration / E2E | `tests/undokit.spec.ts :: <mutation allowlist>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-02 | Unit + integration / E2E | `tests/undokit.spec.ts :: <approval binding>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-03 | Unit + integration / E2E | `tests/undokit.spec.ts :: <apply version conflict>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-04 | Unit + integration / E2E | `tests/undokit.spec.ts :: <ambiguous success>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-05 | Unit + integration / E2E | `tests/undokit.spec.ts :: <compensation conflict>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-06 | Unit + integration / E2E | `tests/undokit.spec.ts :: <idempotency>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-07 | Live sandbox + integration | `tests/undokit.spec.ts :: <real connector restore and negative control>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-08 | Unit + integration / E2E | `tests/undokit.spec.ts :: <offline demo>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-09 | Unit + integration / E2E | `tests/undokit.spec.ts :: <redaction and hostile input>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-10 | Unit + integration / E2E | `tests/undokit.spec.ts :: <portability and corruption>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-11 | Human + E2E | Non-builder follows supplied runbook in a fresh sandbox; record all assistance, step outcomes and cleanup receipt (§9 independent drill). | Human receipt + harness | PLANNED |
| AC-12 | Unit + integration / E2E | `tests/undokit.spec.ts :: <workspace isolation>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-13 | Unit + integration / E2E | `tests/undokit.spec.ts :: <restart and restore>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |

### Flow and failure coverage

| User-facing flow | Happy path | Sad path / boundary |
| --- | --- | --- |
| mutation allowlist | Allow only configured scalar CRM fields; reject deletion, sends, unknown fields and records outside connector scope before any write. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| approval binding | Persist before state and approved plan hash before dispatch; changed intent or expired approval invalidates authorization. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| apply version conflict | Use provider conditional writes; concurrent record modification returns CONFLICT without overwriting external changes. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| ambiguous success | Crash after remote success but before local receipt yields UNKNOWN and read-only reconciliation; retries never blindly repeat the mutation. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| compensation conflict | Compensation previews exact fields and requires separate approval; changed current values or versions block compensation. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| idempotency | Duplicate idempotency key and identical intent returns one operation; changed intent with same key returns 409. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| real connector restore and negative control | A live sandbox drill changes an allowlisted field and restores its original value; a planted intervening edit remains untouched. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |

### Fixtures and runners
Use deterministic UTC clocks, synthetic IDs and planted fake secrets. Default tests cannot access customer accounts. Unit tests cover decision rules and state boundaries. Integration tests exercise real persistence and adapters against controlled fixtures; browser tests exercise API-backed UI rather than route mocks. For a CLI, E2E invokes the packaged executable in a fresh temporary directory and checks exit codes plus report contents. Add a static-report browser smoke for escaping, readable tables and empty/error states.

Each service module requires meaningful normal, invalid and boundary cases; each API router requires success, authorization and conflict tests. Each implemented page receives an E2E smoke and render tests for loading, empty and failure. Target at least 90% branch/line coverage of new decision and service code, with exclusions documented. Coverage is supporting evidence, not a substitute for the matrix.

Live adapters need opt-in sandbox tests pinned to provider/version and sanitized evidence. If credentials or a supported provider are absent, mark BLOCKED; mock success does not satisfy a live criterion. A seeded mandatory failure must turn the release verdict red. QA reconciles planned behavior labels to real test IDs in the implementation PR.

The final receipt records every repository SHA, dirty-tree status, environment, command, exit code, run time, fixture version, artifact hashes, skipped tests and unresolved findings. Any required NOT RUN, PARTIAL or BLOCKED row prevents a claim that the matrix passed.


## 5c. Definition of Done

Reference the canonical **CLAUDE.md → Quality Gate Standard (ALL repos)** at implementation time; resolve its actual workspace path in the build handoff and follow the current local/swarm runner policy. Do not introduce a competing universal gate in this PRD.

Feature-specific release conditions: every numbered acceptance criterion has current evidence; live criteria have live sandbox receipts; independent review of the final tested revision has zero P0/P1; seeded negative controls fail as intended; documentation explains unknown/partial states. Provider APIs may not support safe conditional writes. A connector lacking atomic compare-and-set is read-only in MVP; a local check followed by an unconditional write is insufficient.

This document is a requirements draft, not an implementation or release receipt.
