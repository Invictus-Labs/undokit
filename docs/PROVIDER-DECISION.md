# Provider decision: local live connector for AC-07

Status: decided and empirically verified for the compare-and-set property (see "Verification record").
Research date: 2026-09-30 (documents accessed that day; empirical run timestamp below).

## Requirement

UndoKit's contract (PRD section 6, 5c): the provider itself must enforce the version precondition
atomically. `conditionalWrite(record, patch, expectedVersion)` may never be a local check followed by an
unconditional write. A connector without an atomic compare-and-set is read-only in the MVP. The live
provider must run locally via Docker, with no account, credential purchase or spend.

## Decision

**Apache CouchDB 3.5.2.1 (`apache/couchdb:3.5.2.1`, digest `sha256:078affa27ab6b6f99da17137f6aaabe70f598f1a5b1808ab065874672208f89a`)
holding contact records, version token = the document `_rev`.**

Honest scope statement: CouchDB is a **record-store provider, not a CRM product**. AC-07 evidence from this
connector proves that UndoKit's apply and compensation paths work against a real database server that
enforces optimistic concurrency atomically, including a planted intervening edit that must survive. It does
**not** prove integration with any CRM vendor API, vendor-specific field semantics, rate limits or auth
models. No CRM was selected because none met the bar inside the research time-box (table below). The
simulator connector is deterministic test infrastructure and is never labelled live.

## Candidates

| Candidate | Precondition mechanism | Server-enforced and atomic? | Status on mismatch | Local footprint | Verdict | Primary source |
| --- | --- | --- | --- | --- | --- | --- |
| Apache CouchDB 3.5 | MVCC: every update must carry the current `_rev` (body, `rev` query parameter or `If-Match`) | Yes: stale revision rejected by the database; 20 parallel writers with one `_rev` produced exactly one success (verified below) | 409 Conflict | one container, one env-configured admin, no external account | **Selected** | https://docs.couchdb.org/en/stable/api/document/common.html (PUT: "the current document revision must be included"; 409 "specified revision is not latest for target document"); https://docs.couchdb.org/en/stable/intro/consistency.html (optimistic concurrency) |
| Frappe framework / Frappe CRM | `modified` timestamp compared in `Document.check_if_latest` after loading the row with `for_update=True` (row lock), raises `TimestampMismatchError` | Plausibly yes (row-locked compare inside the save transaction). UNVERIFIED over the REST API: whether `PUT /api/resource/...` with a `modified` value in the body is honoured as the precondition was not tested | UNVERIFIED (framework error is `TimestampMismatchError`) | multi-container bench stack (database, cache, web, worker, scheduler, site bootstrap) plus a CRM app image | Not selected: heavy for a shared machine and the REST precondition path is unproven within the time-box. Recommended first candidate if a real CRM is wanted later | https://raw.githubusercontent.com/frappe/frappe/develop/frappe/model/document.py (`check_if_latest`, `load_doc_before_save`) |
| EspoCRM | Optimistic concurrency control (v7.0+) opt-in per entity type, resolved through a conflict dialog | UNVERIFIED for API clients; documented as a user-interface conflict-resolution feature, on by default only for Knowledge Base and templates (not Contacts) | UNVERIFIED | PHP app plus database container | Not selected: no documented API precondition contract | https://docs.espocrm.com/user-guide/optimistic-concurrency-control/ |
| Odoo (CRM app) | ORM `write` runs `_check_concurrency` when a `__last_update` map is passed in the context | UNVERIFIED (comparison happens in the ORM; atomicity against a concurrent writer not established) | UNVERIFIED (ORM concurrency exception) | application plus PostgreSQL, database initialisation, admin bootstrap | Not selected: atomicity unproven, only secondary-source evidence found | https://www.odoo.com/forum/help-1/problems-about-last-update-field-in-check-form-view-concurrency-166645 (secondary, forum) |
| Twenty, SuiteCRM, Dolibarr, Krayin | No `If-Match`/ETag/version precondition on record update was found in documentation during the time-box | Not established | n/a | n/a | Not selected | search only; no primary document found. Treated as UNVERIFIED, not as a claim of absence |

No competitor-absence claim is made: "UNVERIFIED" means not established in the time-box, not that the
feature does not exist.

## Verification record (empirical)

Run on 2026-10-01T01:32:42Z (output of `date -u`; the local calendar date was 2026-09-30). Throwaway container named
`undokit-sandbox-research-couch`, `docker run -d --rm -p 127.0.0.1::5984`, random admin password generated at runtime
and never stored, no volumes. The container was removed afterwards (`docker rm -f` on that name only).

| Check | Observed |
| --- | --- |
| Server version | 3.5.2 |
| Create database and document | 201, `_rev` generation 1 |
| (a) PUT with the current `_rev` | 201 |
| (b) PUT with the now-stale `_rev` | 409 `{"error":"conflict","reason":"Document update conflict."}`; document unchanged (value from step (a) intact) |
| (c) 20 parallel PUTs carrying the same `_rev` | exactly one 201 and nineteen 409; the stored document equals the single winner's value |
| (d) PUT without `_rev` on an existing document | 409 |

This verifies the property UndoKit needs: concurrent or stale writes are rejected by the provider, so
there is no window between a check and a write that UndoKit controls.

## Connector contract used by UndoKit (`src/connectors/couchdb.ts`)

- Records are CouchDB documents in one configured database; `record_ref` is the document id (no leading
  underscore; the allowlist and scope prefixes reject provider-internal ids). Scalar fields are top-level
  document members; the allowlist limits which members may be patched.
- Version token = `_rev`. `read(record)` is `GET /{db}/{id}` and returns `{version: _rev, fields}`.
- `conditionalWrite(record, patch, expectedVersion)`:
  1. `GET` the document. If its `_rev` differs from `expectedVersion`, return `conflict` without writing.
  2. Merge only the patched allowlisted members into the document that was read (CouchDB `PUT` replaces the
     whole document, so the merge needs the document at that revision).
  3. `PUT /{db}/{id}` with `_rev = expectedVersion`. Any change between steps 1 and 3 makes the provider
     return 409, which UndoKit reports as `conflict` and records as `CONFLICT`. The step-1 comparison is only
     an early exit; correctness rests on the provider rejecting the stale `_rev` in step 3.
- Outcomes: 201 means written with the new `_rev`; 409 means conflict; connection refused before the request
  was sent means unavailable and nothing was written (explicit failure); a timeout, reset or 5xx after the
  request may have been delivered, so the outcome is ambiguous and UndoKit records `UNKNOWN` and requires
  read-only reconciliation. There is no blind retry.
- Credentials (admin user and password for the sandbox) are stored encrypted with the operator-managed key
  and are never logged or exported. The configured base URL must pass the outbound allowlist (default:
  loopback hosts only) including redirects and DNS resolution.

## Sandbox operation

- Docker service and any containers or volumes are named with the prefix `undokit-sandbox-`, bound to
  `127.0.0.1` only, and are ephemeral. The sandbox service lives in `compose.yaml` (QA/packaging territory).
- Image tag is pinned to `3.5.2.1`; record the digest in the evidence receipt of each run.
- Required environment: `COUCHDB_USER` and `COUCHDB_PASSWORD` set to operator-generated values (placeholders
  only in examples). CouchDB refuses to start without an admin in 3.x.

## Risks and limits

- A record store is not a CRM: field typing, permissions and side effects of a real CRM are out of scope.
- `_rev` changes on every write by anyone, including writes to unrelated fields, so a compensation after any
  later edit is blocked by design (conservative, matches "changed versions block compensation").
- A third party writing identical values still changes `_rev`; reconciliation of an ambiguous apply therefore
  infers (does not prove) authorship when current values equal the intended values. The evidence labels this
  `inferred`.
- A real CRM connector remains possible later; Frappe is the first candidate to evaluate (REST precondition
  behaviour must be tested before any claim).

## Connector-level run (backend, 2026-10-01T02:02:03Z)

The real `CouchdbConnector` was driven through the full service stack against a throwaway `apache/couchdb:3.5.2.1`
container (`undokit-sandbox-live-drill`, loopback only, random admin password, removed afterwards). Observed: apply
produced `applied` with a new `_rev` and the stored value changed; an approved compensation restored the original
value; a stale `expected_version` at plan time returned `VERSION_CONFLICT`; an intervening edit between approval and
apply ended as `conflict` with the planted edit intact; a planted edit after the apply made the compensation plan
`conflict` (`VERSION_CHANGED`) and the approval attempt `COMPENSATION_BLOCKED` with the planted edit intact; stopping
the container before the worker ran produced `failed` / `CONNECTOR_UNAVAILABLE` with attempts `started`, `failed` and
no retry; a second run injected an edit between the connector's read and its PUT (only the provider can catch that) and the provider's 409 became `conflict` with the planted edit intact; a PUT whose response was dropped (connection reset after the provider committed) left the operation `unknown` and read-only reconciliation resolved it to `applied` with a single revision bump and no second write; the credential never appeared in an exported bundle. This is a developer smoke run, not the recorded AC-07
receipt, which the QA drill must produce under `docs/qa`.

## What remains for AC-07

AC-07 can only be marked PASS from a recorded run of the live drill against this container: apply an allowlisted
field change, restore the original value through approved compensation, and, as a negative control, plant an
intervening edit and show compensation is blocked with the planted edit intact. Until such a run is recorded in
`docs/qa`, AC-07 is NOT RUN. Mock or simulator results never satisfy it.
