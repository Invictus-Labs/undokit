# UndoKit

Recover an approved CRM field change without overwriting later work. TypeScript (strict, ESM), Node >= 22.12, Fastify API/worker, PostgreSQL semantics via PGlite (default) or `pg`, React plan/diff UI, CLI.

## Stack
- `src/domain`, `src/services`, `src/api`, `src/workers`, `src/connectors`, `src/db`, `src/evidence`: core (state machine, plans, hashing, evidence bundles, connectors)
- `src/cli`, `src/web`, `src/report`, `src/adapters`, `templates/`: CLI, UI, static report, optional ecosystem envelope
- `tests/`, `fixtures/`, `docs/qa/`, `scripts/verify-quality.sh`: tests, evidence matrix, local gate

## GitHub
NEVER commit to main directly. Always feature branch -> PR -> merge. No GitHub Actions workflows; the gate is local.

## Quality Gate
- Coverage floor 90% lines and branches on decision/service code (`npm run test:coverage`).
- Local gate: `bash scripts/verify-quality.sh` (typecheck, build, tests, coverage, secret scan, negative controls, browser smoke).
- Release also needs independent code review and QA on the exact final revision with zero P0/P1, and real-provider receipts for live criteria.

## Rules
- See `AGENTS.md`, `docs/DOD.md`, `docs/TEAM.md`.
