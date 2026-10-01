# UndoKit development boundary

- Independent, self-hostable open-source product (MIT). Contract: `docs/PRD.md`; Definition of Done: `docs/DOD.md` (verbatim PRD sections 5, 5b, 5c); team territories: `docs/TEAM.md`.
- Uncertainty never becomes success: UNKNOWN, CONFLICT, partial and unsupported states stay visible and never pass a gate.
- A connector without atomic compare-and-set is read-only. A local check followed by an unconditional write is not acceptable.
- Never label a simulator or fixture as live. Live criteria need a real local provider receipt; otherwise BLOCKED.
- AC-11 needs a human receipt. No agent marks it PASS; record `PENDING_HUMAN_RECEIPT`.
- Synthetic data, fixed UTC clocks, planted fake secrets only. No telemetry, vendor account, license server or paid provider. No outbound network from the deterministic core.
- Use `localhost` in user-facing demo URLs. No personal paths, hostnames, emails or credentials in source, docs, logs or fixtures.
- No GitHub Actions workflows. Stage explicit paths; never `git add -A`.
- Work inside your file territory only. Need a change elsewhere: message the territory owner.
