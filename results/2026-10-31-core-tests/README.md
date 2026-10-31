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
- Deployment: on 31 Oct the app stacks still run the `bcd7bd1` build (its engine is `7432ebe`'s); the
  change set for `8ace25c` is created and waits to be executed (`docs/deployment-state.md`, 31 Oct).
- `run.log`: the full verbose output. `coverage-summary.json`: v8 coverage (`coverage.include = src/**`).
- Run in the development container, no load generator running alongside.
