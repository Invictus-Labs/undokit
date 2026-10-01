# UndoKit build team: roles, exclusive file territories, interfaces

All builders, reviewers and QA run Sonnet 5.5 at high effort. Roles are separate agents; builders never certify independent gates.

| Role | Territory (exclusive write) |
| --- | --- |
| Coordinator | `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `lessons.md`, `.gitignore`, `docs/TEAM.md`, `docs/DOD.md`, `docs/PRD.md`, git remote/push/PR/merge, dependency changes |
| Backend (domain/core) | `src/domain/**`, `src/services/**`, `src/api/**`, `src/workers/**`, `src/connectors/**`, `src/db/**`, `src/evidence/**`, `schemas/**`, `migrations/**`, `docs/PROVIDER-DECISION.md`, `docs/ARCHITECTURE.md` |
| CLI / UI / integration | `src/cli/**`, `src/web/**`, `src/report/**`, `src/adapters/**`, `templates/**` |
| QA / packaging (independent) | `tests/**`, `fixtures/**`, `scripts/**`, `README.md`, `Dockerfile`, `compose.yaml`, `docs/qa/**`, `docs/RUNBOOK.md`, `docs/HUMAN-DRILL.md`, `docs/OPERATIONS.md`, `docs/DEPENDENCY-LICENSES.md` |

Rules
- Never edit a file outside your territory. Ask the owner via message (name the file and the exact change).
- Backend freezes `schemas/*.json` and exported TypeScript types in `src/domain/types.ts` first and announces the freeze; changes after the freeze go through the backend owner and a message to the other two.
- New dependencies: ask the coordinator (it edits `package.json` and runs install). Never run `npm install` yourself.
- Stage explicit paths only and commit only your own territory on branch `codex/undokit-mvp`. Retry on `index.lock`. Never push, merge or open PRs; the coordinator publishes.
- End commit messages with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Report exactly one status: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, with commands, exit codes and full 40-character SHAs.
