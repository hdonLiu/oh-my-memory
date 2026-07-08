# Memory Governance Completion Plan

Goal: finish the v1 governance implementation from the approved specification and commit it.

Scope:

- Add architecture milestone docs for the Governance Plane.
- Add run snapshot metadata columns and finite governance budget configuration.
- Extend L1 planner inputs and plans with due Corrections.
- Validate handled L1 Corrections and atomically move them to `ready_l2`.
- Extend L2 planner/synthesizer inputs with ready Corrections.
- Validate handled L2 Corrections and atomically move them to `applied`.
- Support direct L2 Statement `replace` and `retract` corrections with system-owned Statement IDs and lineage edges.
- Enrich Recall responses with `usagePolicy`, statement IDs/status/conflicts, authority, correction evidence, and watermarks.
- Cover migration/defaults, API errors, restart discovery, correction lifecycle, statement lineage, freshness, and docs with tests.
- Run typecheck and tests, then commit all resulting changes.

Verification:

- `npm run typecheck`
- `npm test`
- `git diff --check`
- `git status --short`
- `git commit`
