# Research

This folder generates the **simulated interviews and usability study** (records, analysis, charts and
reports in `results/research/`).
Method: interview scenarios are authored and task/SUS responses are generated; no recruitment or
human observation took place. Raw rows retain `source_type=SIMULATED`; field-evidence directories
and the report's existing `Study*` / `Interview*` macros remain independent.

The package follows the original scope: six student and three organiser interviews, two pre-study
walkthrough scenarios excluded from analysis, and one formal study with 12 participants. Each
participant uses both tools, producing 112 task rows and 24 SUS forms in total. Design improvements
are recommendations from this study; no second study or evaluated interface revision is claimed.

## Build and verify

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r tools/experiments/requirements.txt
.venv/bin/python tools/research/simulate.py --plots
.venv/bin/python -m unittest discover -s tools/research -p 'test_*.py'
.venv/bin/python tools/research/simulate.py --check --check-figures
PATH="$PWD/.venv/bin:$PATH" ./report/build.sh -t Research -m 4
```

CSV/JSON/Markdown/TeX generation and the tests need only Python's standard library. Plot rendering
uses matplotlib and numpy (installed by the existing experiments requirements); PDFs use the
repository's existing TeX toolchain. There is no new Node dependency or product behaviour change.

## Sources and outputs

- `scenarios.json`: nine authored interview profiles, six qualitative codes, twelve study profiles,
  adverse events and timing/action/SUS assumptions. A scripted statement is never called a transcript.
- `docs/user-study/counterbalance.csv`: original study assignment, reused unchanged (8 participant,
  4 organiser profiles; 6 first use each condition; equivalent A/B datasets).
- `study.py`: study assignment, scenario generation, input/record validation, SUS arithmetic and
  participant-level paired calculations.
- `documents.py`: interview records, research report, speaking notes and separately named `Sim*` macros.
- `simulate.py`: CLI, generation orchestration, CSV/JSON output and integrity manifests.
- `plot.py`: PNG/PDF charts; methodology and provenance remain available beside the plots.
- `test_research.py`: SUS arithmetic, outcome denominators, pairings, counterbalance, negative cases,
  provenance and reproducibility.
- `results/research/`: complete generated research package and detailed research report.
- `report/Research.tex`: standalone English companion report; the main report and slides
  also show the prototype results with their simulated evidence status.

All generated Markdown, CSV and JSON text is in English. `summary.md` is the research report. To
change wording, edit `scenarios.json` or the module that writes the text (mostly `documents.py`; a
few fixed strings in `study.py`, chart labels in `plot.py`) and regenerate; never edit the
generated files.

The default seed is fixed at 20261031; there is no search for favourable results. Use `--seed` and
`--out /tmp/...` for another scenario without changing the default report. `--check` is read-only
and verifies every generated text file plus the report macros against the source assumptions,
including unexpected stale files. `--check-figures` also verifies the chart input fingerprints and
all eight PNG/PDF hashes against `figures/manifest.json`, without importing matplotlib. Rebuild with
`--plots` after changing inputs or plot code. CI runs the research tests and both integrity checks.

## Interpretation

Completion is unassisted successes divided by all attempted tasks; assisted completion is reported
separately. Within each participant, task times (including failures) are summed by condition
before calculating percentage reduction. The reported reduction is the median of those 12 ratios,
not a test treating 112 repeated task rows as independent people. SUS comes from all ten items,
with reverse scoring. No population confidence interval, significance claim, thematic saturation,
recruitment, consent or validated demand is inferred from simulated records.

Price units are per event for students and per organisation-month for organisers. Coordination
baseline is not time saved. Theme frequency is script coverage, not population prevalence.
