# Core engine tests and property test — 2026-10-17

`packages/core` unit tests and the model-based property test (`test/property.test.ts`: 2,000 random
command sequences, `checkInvariants` after every step), run with `npx vitest run --coverage
--reporter=verbose` in `packages/core` at the commit in `commit.txt`.

- That commit's `packages/core` and `packages/contracts` are identical to `e05c037`, the commit whose
  build is deployed on `dev` and served the quoted Table 3 re-run
  (`results/2026-10-17-table3-dev-q1000-provenance.md`).
- `run.log`: the full verbose output, exit code on its last line. `coverage-summary.json`: v8 coverage
  (`coverage.include = src/**`).
- Run on the experiment machine after the k6 matrix had finished, so it did not share CPU with the load generator.
