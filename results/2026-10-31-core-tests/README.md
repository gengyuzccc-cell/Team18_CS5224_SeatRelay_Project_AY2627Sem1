# Core engine tests and property tests — 2026-10-31

`packages/core` unit tests and the two model-based property tests (`test/property.test.ts`, 2,000
random command sequences with `checkInvariants` after every step; `test/audit-engine.test.ts`, the
30 Oct audit's second property test with a skewed clock, duplicate commands, ticks and
continuations), run with `npx vitest run --coverage --reporter=verbose` in `packages/core` at the
commit in `commit.txt` (`8ace25c`, the audit-fix commit).

- Supersedes `results/2026-10-17-core-tests/` as the record of the shipped engine: that run covered
  `d121145`; since then `packages/core` changed in `7432ebe` (display times) and in `8ace25c`
  (capacity bound `MAX_CAPACITY` in `apply.ts`; one `WORKSHOP_CANCELLED` notice per user across a
  drain that spans several decisions in `drain.ts`), and `packages/contracts` in `8ace25c`
  (`CapacitySchema`). Three new test files: `audit-engine.test.ts`, `drainNotices.test.ts`
  (core) and `audit-bounds.test.ts` (contracts, counted in that package's own suite).
- Deployment: the `8ace25c` bundles (this engine) run on `dev` since 2026-10-31 05:26 UTC and on
  `pilot` since 05:31 UTC (`docs/deployment-state.md`, 31 Oct); the dev regression after the redeploy
  passed (`results/2026-10-31-{smoke,correctness,access-control}/`).
- `run.log`: the full verbose output. `coverage-summary.json`: v8 coverage (`coverage.include = src/**`).
- Run in the development container, no load generator running alongside.
