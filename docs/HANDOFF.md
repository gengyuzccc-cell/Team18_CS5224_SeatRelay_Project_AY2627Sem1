# SeatRelay handoff: remaining work and review findings

Updated: 2026-10-31. This document records the agreed scope, outstanding tasks, review findings and verified baseline for the next maintainer. Update each task's status and evidence when it is completed.

## 1. Scope and working state

- **This is a course prototype.** The interview package and one formal study scenario are complete: six student and three organiser interviews; two pre-study scenarios excluded from the sample; twelve participants using both tool conditions, producing 112 task attempts and 24 ten-item SUS forms.
- **Do not add a second study.** Keep improvements as recommendations and retain failures, help requests and counterexamples. Use `Research`, `user research` and `participants` in headings and presentation copy. Explain data generation in the methodology and provenance metadata.
- **Database and AWS environment work is deferred at the user's request.** Do not install/start services, configure credentials, operate cloud resources, run database integration tests or introduce database CI jobs as part of the current work. The previously added database CI job and strict database-test mode were removed.
- **The working tree contains substantial uncommitted changes and new files.** The branch at handoff is `claude/serene-lovelace-7t14s9`. Start with `git status --short` and `git diff`, and inspect untracked files as well. Preserve existing work; do not reset or clean it away. Nothing has been committed, pushed or deployed in this session.
- Generated research data live in `results/research/` and use separate `Sim*` report macros. Existing field-study `Study*`, `Interview*` and `Pilot*` macros retain their original meaning; generated data must not clear those pending values.
- **New material must be in English.** Today's Markdown, README additions, research records, CSV text and research source text are in English. Keep historical experiment records unchanged. Generate outputs from their sources instead of editing them by hand.

## 2. Priority work queue

These tasks are outstanding unless their checkboxes say otherwise. T1-T3 cover engineering and presentation material; T4 covers later version delivery; T5 requires team information and manual actions.

### T1 · P1 · Dependency security upgrades and compatibility checks

- [ ] Rerun `pnpm audit --audit-level high --json` and record the current dependency paths and advisories. The counts below are a review snapshot, not a promise that future audits will match.
- [ ] Address dependencies covered by advisories, including Zod and Vitest/Tinypool, distinguishing production from development use and checking exploit prerequisites. For major-version upgrades, review schemas, inferred types, error responses, mocks and coverage plugins together.
- [ ] Update the relevant `package.json` files and `pnpm-lock.yaml`; run lint, typechecking, non-database tests and builds. Preserve the current optional database-test behaviour.
- [ ] Document fixes or applicability conclusions for other advisories. After compatibility checks, reconsider the existing CI audit's `continue-on-error: true`; it currently allows an audit failure without failing CI.

**Done when:** high/critical dependency findings have been addressed, compatibility checks pass and remaining advisories have explicit conclusions. Forcing incompatible overrides or hiding audit output is not completion.

### T2 · P1 · Align presentation material with the current research

The main report, research appendix and slides use the research data. Parts 1-2, Part 6, the walkthrough index and Q&A have now been aligned with the same methods and inputs. The poster and a final cross-artifact review remain outstanding:

| Entry point | Remaining work |
|---|---|
| [part-1.md](walkthrough/part-1.md) | Updated: market share, coordination baseline and price-response inputs now reference the research scenarios; include it in the final cross-artifact review |
| [part-2.md](walkthrough/part-2.md) | Updated: scenario hold preferences are distinguished from the product default and study task hold |
| [QA-prep.md](QA-prep.md) | Updated: research status, market/pricing interpretation and AI-use explanation match the package |
| [walkthrough/README.md](walkthrough/README.md) | Current research status and slide ownership updated; manual rehearsal checklist remains open |
| [poster.template.html](poster/poster.template.html) | Its `Next` paragraph still treats the twelve-person study as entirely future work; explain the completed research and method boundary, and check the AI-use statement |

- [x] Align current research speaking notes and Q&A with [summary.json](../results/research/summary.json), the [research report](../results/research/summary.md) and the [research guide](research/README.md).
- [ ] After editing the poster template, follow the [poster build guide](poster/README.md) to rebuild `poster.html`, `seatrelay-steps-poster.png` and `seatrelay-steps-poster.pdf`; inspect layout and QR codes.
- [ ] Check that scripts, Q&A, poster, main report and slides agree on status, units and numbers.

**Done when:** current presentation material has no placeholders awaiting the existing research outputs and does not describe generated data as human observations. Do not globally replace historical records, future field-study templates or pending field-evidence macros.

### T3 · P3 · Existing formatting debt

- [ ] Rerun `pnpm format:check`. The previous run flagged **62 existing files**, none changed by the functional fixes in this session.
- [ ] Keep formatting-only work separate from behaviour changes, inspect the diff and run the relevant checks.

**Done when:** the whole-repository format check passes, or exclusions are explicitly justified. Modified TS/JSON/YAML files passed their targeted format check; the full repository has not passed.

### T4 · Later version delivery · Local changes and remote CI

- [ ] After further changes, rerun the relevant checks; inspect new files, generated output and ignore rules, excluding temporary files and credentials.
- [ ] When the user requests version delivery, commit/push to the correct branch and inspect remote CI for that commit. Current maintenance does not include committing, pushing or deploying.
- [ ] If the original field-study UI-freeze tag remains in the plan, confirm that it still applies before creating it; do not automatically tag an old study workflow.

**Done when:** the requested version is on the correct branch and its remote checks can be verified. The current working tree is uncommitted and these changes have not run through remote CI.

### T5 · Course submission · Team information and manual confirmation

- [ ] `report/team-ids.tex` is missing. The team must supply actual student numbers locally; keep that file and submission PDFs out of the public repository.
- [ ] Build and inspect `Final-submission.pdf` and `Slides-submission.pdf`. Standard PDFs exist; submission variants have not been generated.
- [ ] Complete two timed rehearsals and demo preparation, confirming speaker roles and Q&A coverage. Repository files do not establish that an in-person rehearsal occurred.
- [ ] Upload, download/recheck and complete peer assessments according to the course requirements. The original checklist states 2026-11-13; the team should verify the latest course instructions before submission.

See the build/submission section of [SUBMISSION-CHECKLIST.md](SUBMISSION-CHECKLIST.md). It also retains historical field-study commitments; those are not automatically new tasks within the current prototype scope.

## 3. Outstanding review findings

### Dependency advisory snapshot

The 2026-10-31 `pnpm audit` run reported **2 critical, 1 high, 13 moderate and 4 low** records. Advisory counts are not counts of exploitable entry points; equivalent practical exploitability in this project has not been established.

| Dependency path | Finding and next step |
|---|---|
| Zod 3.25.76 | Covered by a high-severity advisory, which lists 4.6.6 as fixed. Check compatibility of request validation, contract types and error formatting. [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) |
| Vitest 3.2.7 → Tinypool 1.1.1 | Two critical advisories concern the test toolchain. One requires prototype pollution and particular worker options; this does not establish direct RCE in the cloud API. Review Vitest and coverage-plugin upgrades together. [Tinypool advisory](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), [Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) |
| React Router, fast-uri, minimatch, glob and others | Assess production/development use and prerequisites separately. Callback paths already use `sanitizeReturnTo`, and the project does not use React Router SSR; these constraints do not replace dependency fixes |

The previous review did not change dependency versions or the lockfile. Continue under T1.

### Optional structural improvements

These are maintainability recommendations, not demonstrated defects caused by file length or blockers for the prototype. Database-related suggestions are recorded for later; they do not authorise database work now.

| File | Suggested boundary |
|---|---|
| [DashboardPage.tsx](../apps/web/src/pages/DashboardPage.tsx), about 1,013 lines | Page container, session management, workshop settings, attendance table and export; retain shared `useCommand` flows |
| [DynamoDB store.ts](../services/aws/src/adapters/dynamo/store.ts), about 1,044 lines | Separate reads and transaction-item construction; preserve atomic commits, conflict classification, uniqueness constraints and existing `keys.ts`/`mapping.ts` |
| [PostgreSQL store.ts](../services/local/src/adapters/postgres/store.ts), about 1,005 lines | Extract row mapping first, then writes; preserve SQL locks and transactions rather than forcing a common implementation with DynamoDB |
| [walkthrough.ts](../tools/e2e/src/walkthrough.ts) and [pilot-rehearsal.ts](../tools/experiments/src/pilot-rehearsal.ts), about 1,786 / 1,735 lines | Extract scenario phases with explicit context, preserving order and output formats |
| [report_numbers.py](../report/tools/report_numbers.py), about 1,791 lines | Separate cost, performance and study collectors while retaining one macro registry and provenance-check entry point |

## 4. Completed fixes to preserve

These issues have been fixed and should not be reopened as outstanding tasks. Preserve their regression coverage when changing the affected modules.

| Original issue | Fix and entry point |
|---|---|
| A cancelled old poll could return success and overwrite a newer command's state, cache or callback | [pollCommand.ts](../apps/web/src/commands/pollCommand.ts) and [commandRunner.ts](../apps/web/src/commands/commandRunner.ts) check cancellation after the response and before applying it; two regressions failed before the fix and passed afterwards |
| Research validation accepted unknown tasks, another participant's SUS and invalid outcomes | [study.py](../tools/research/study.py) validates the full participant×tool×task assignment, order, track, dataset, provenance, outcome enums and numeric bounds |
| Timeout classification depended on the note containing `300` | Explicit `failure_kind` distinguishes timeout from incorrect answer; rewriting notes no longer changes outcomes |
| Stale/corrupt charts or obsolete study files could pass checks | Chart input fingerprints and eight PNG/PDF hashes are verified; unexpected files are detected; alternate seeds require separate output, with custom TeX destinations covered |
| A background loop could not poll normally after stop/restart | [loop.ts](../services/local/src/loop.ts) creates a fresh controller at each start; tests cover restart and draining in-flight work without a database |
| Research calculations, document text and CLI responsibilities were mixed, with unused items | Split `study.py`, `documents.py` and `simulate.py`; removed unused parameters/configuration, four macros and one switch |
| No compiler check for unused locals/parameters | [tsconfig.base.json](../tsconfig.base.json) enables `noUnusedLocals` and `noUnusedParameters`; removed an unused E2E scrolling argument |
| Python research checks were absent from CI | [.github/workflows/ci.yml](../.github/workflows/ci.yml) now runs research tests and generated-output checks; no database CI extension remains |
| Interview templates had an outdated team size | Both now say “NUS students” instead of maintaining a duplicate count |

## 5. Redundancy and unused-file review

- Static analysis covered the 320 tracked TS/TSX/MJS files present at review start, including 217 `src` files. It found no static import cycle. CLI, Lambda, package-export and dynamic-worker entry points were distinguished; **no entire source file was confirmed safe to delete**. This does not prove all runtime branches are reachable.
- Public schemas, types and exports are not dead code merely because few internal consumers use them. Check package interfaces, build entry points and dynamic loading first.
- Similar historical `results/` directories preserve failed and repeated experiments referenced by [RUNS.md](../results/RUNS.md) and the report. Keep them.
- `docs/interviews/` and `docs/user-study/` contain protocols/templates; `results/research/` contains outputs. These responsibilities remain separate.
- The two `research.tex` outputs serve the results package and report build and are checked for consistency; do not edit them separately. Keep both PNG and PDF chart formats for their different uses.
- The previous local Markdown-target scan confirmed no broken real-file link. A tracked-text scan for common AWS access-key/private-key patterns found no match; credential files were not read and a complete Git-history secret audit was not performed.

## 6. Verified baseline and checks

These results are from the 2026-10-31 review. Research naming was subsequently unified to `Research`, and today's documents/data were translated into English. Research tests, generated-output integrity and numerical invariance were rechecked after translation; this is not a fresh full TypeScript regression.

| Check | Last verified result |
|---|---|
| Lint, typechecking, build | `pnpm lint`, `pnpm typecheck` and `pnpm build` passed |
| TypeScript tests | 687 passed; 31 database tests skipped and not counted as passed |
| Core engine | 156 passed; 99.66% branch coverage; 100% statement/line/function coverage |
| Research tests | 15 passed; 25 generated text outputs, report macros and eight PNG/PDFs verified |
| PDF build | Main report 10 pages, research appendix 4, slides 22; no overfull boxes, undefined references or visible placeholders |
| Number provenance | 1,331 macros, 1,240 source paths, 37 experiment directories; zero problems. The 87 pending field-study/pilot macros retain their original meaning |
| Repository-wide formatting and security audit | Not passed; continue under T3 and T1 |

Database skips: 20 PostgreSQL tests because no service was reachable, and 11 DynamoDB Local tests because no endpoint was set. This work remains deferred. Remote CI, current cloud deployment and actual-browser end-to-end flows were not revalidated in this review.

The workspace uses Node 22 and pnpm 10.28.0. These checks retain the existing optional database behaviour:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 -m unittest discover -s tools/research -p 'test_*.py'
python3 -I tools/research/simulate.py --check --check-figures
```

Report builds additionally require the Python analysis dependencies, TeX Live, latexmk, biber and Poppler. With the appropriate Python environment active:

```sh
python3 -I report/tools/check_numbers.py
./report/build.sh -t Final -m 10
./report/build.sh -t Research -m 4
./report/build.sh -t Slides -m 22
```

## 7. Entry points and suggested continuation

1. Inspect the working tree and scope first; handle T1 dependency risk and T2 material consistency, then T3 as separate formatting work.
2. Research sources: [scenario inputs](../tools/research/scenarios.json), [research report](../results/research/summary.md), [reproduction guide](../tools/research/README.md) and [research entry point](research/README.md). Regenerate outputs rather than bypassing their checks with manual edits.
3. After engineering/material work, use T4/T5 for the requested delivery. Optional restructuring comes later; database and AWS environment work remains deferred.
