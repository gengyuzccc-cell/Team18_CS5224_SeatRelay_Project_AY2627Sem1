# STePS poster (A1)

| File | What it is |
|---|---|
| `seatrelay-steps-poster.png` | The poster image for the STePS registration: A1 portrait at 150 dpi, 3508 × 4967 px |
| `seatrelay-steps-poster.pdf` | The same poster as a vector A1 PDF (594 × 841 mm), for the free A1 print by SoC Technical Services |
| `poster.template.html` | The source: layout, text, the comparison illustration and the architecture diagram (HTML + inline SVG) |
| `build.py` | Fills the numbers into the template and draws the two charts, then calls `render.mjs` |
| `render.mjs` | Prints `poster.html` with Chromium (Playwright from `tools/e2e`) to the PNG and the PDF |
| `img/ui-*.png` | Crops of the deployed web app at 3× pixel density (staged walkthrough on dev with test accounts, `E2E_SCALE=3 pnpm --filter @seatrelay/e2e walkthrough -- --stage dev --no-publish --no-results --no-video`) |
| `img/qr-*.svg` | QR codes: the live demo (`https://d2ni5e1z674t04.cloudfront.net`) and this repository |
| `fonts/` | Source Serif 4 and Inter, both under the SIL Open Font License (licence files included) |

Rebuild after the numbers change:

```bash
python3 -I report/tools/report_numbers.py     # results/ -> report/generated/numbers.tex
python3 -I docs/poster/build.py               # numbers.tex -> poster.html -> PNG + PDF
```

## Where the numbers come from

Every measured value on the poster is a macro of `report/generated/numbers.tex` (the same macros as the
Final report), filled in by `build.py`; `build.py` stops if a macro is still pending. Their sources:

| On the poster | Macro(s) | Source |
|---|---|---|
| 34.6 → 0 duplicate holds, 15.7 → 4.3 min refill, 54.0 → 58.1 people served | `ReplayDupHoldEvents*Mean`, `ReplayRefillMean*Mean`, `ReplayDistinct*Mean`, `ReplaySeeds` | `results/replay/` (simulation, labelled as such) |
| 8/8 acceptance tests | `SeriesPassed`, `SeriesExperiments` | the quoted Table 3 series pinned in `report/series.json` |
| 0 overbooked in 672 checks; 50 people, 5 seats | `CorrectnessChecksTotal`, `ConcurrencyAccounts`, `ConcurrencySeats` | `results/2026-10-17-correctness-2/`, `-concurrency-2/` |
| 0.10 s seat hand-over (p95 of 300) | `BackfillExpiredPNinetyFiveS`, `BackfillExpiredN` | `results/2026-10-17-backfill-2/` |
| 2 min crash recovery | `FailureBeforeCommitSettleMedianS` (120.1 s) | `results/2026-10-17-failure-recovery-2/` |
| Load-test chart, 0.00 % errors | `PerfDev{Cross,Hotspot}VU{Ten,TwentyFive,Fifty}SettlePNinetyFiveMs`, `PerfDevHotspotVUFiftyErrorPct` | `results/loadtest/2026-10-17/` (run `20261017T192002Z`) |
| US$13.30 → US$5.91 per 1,000 registrations | `CostUnitOneKCloudListUsd`, `CostUnitHundredKCloudListUsd` | `results/cost/model-summary.md` |

Product facts (15-minute default hold, one FIFO message group per workshop, one DynamoDB transaction
per decision, a timer per offer plus a five-minute sweep) are from the code and
`docs/ARCHITECTURE.md`. The names in the illustration are invented examples, not participants.

## Design notes

- STePS guidelines (Poster Design Guidelines, 28th STePS): A1; title ~72–100 pt (here 100 pt), headings
  36–48 pt (42 pt), body 24–32 pt (24–27 pt; chart labels and the fine print are smaller); 2–3 columns;
  2–3 colours (NUS blue for structure, one orange for held seats and time, a lighter blue as the chart
  series), visuals first, AI use disclosed.
- The two chart colours were checked with the dataviz palette validator (colour-blind separation and
  contrast against the paper colour); every chart has a legend and direct end labels.
