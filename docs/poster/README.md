# STePS poster (A1)

| File | What it is |
|---|---|
| `seatrelay-steps-poster.png` | The poster image for the STePS registration: A1 portrait at 150 dpi, 3508 × 4967 px |
| `seatrelay-steps-poster.pdf` | The same poster as a vector A1 PDF (594 × 841 mm), for the free A1 print by SoC Technical Services |
| `poster.template.html` | The source: layout, text, the comparison illustration and the architecture diagram (HTML + inline SVG) |
| `build.py` | Fills the numbers into the template and draws the two charts, then calls `render.mjs` |
| `render.mjs` | Prints `poster.html` with Chromium (Playwright from `tools/e2e`) to the PNG and the PDF |
| `img/ui-*.png` | Contiguous crops (nothing edited in or out) of the deployed web app at 3× pixel density: a staged walkthrough on dev with test accounts on 21 Oct 2026, `E2E_SCALE=3 pnpm --filter @seatrelay/e2e walkthrough -- --stage dev --no-publish --no-results --no-video` (44 checks passed; not a measurement run, so not in `results/`) |
| `img/qr-*.svg` | QR codes: the live demo (`https://d2ni5e1z674t04.cloudfront.net`) and this repository |
| `fonts/` | Source Serif 4 (Fontsource WOFF2) and Inter (converted from the Inter OTFs to TrueType outlines and subset, so the print PDF embeds CID TrueType fonts, not Type 3), both under the SIL Open Font License (licence files included) |

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
| 3.9 → 0 second seats held at the end, 5.1 → 3.4 min to refill a freed seat (median workshop; means 15.7 → 4.3), 88.6 % → 95.0 % of seats given to different people | `ReplayDupConfirmed*Mean`, `ReplayRefillMean*Median` (`*Mean` in the note), `ReplayFillRate*Mean`, `ReplaySeeds`, `ReplayRefillMeanN` | `results/replay/` (simulation, labelled as such; the baseline is an automatic waitlist per session) |
| 8/8 acceptance tests | `SeriesPassed`, `SeriesExperiments` | the quoted Table 3 series pinned in `report/series.json` |
| 0 overbooked sessions or people with two seats (672 checks) | `CorrectnessChecksTotal` | `results/2026-10-17-correctness-2/` |
| 50:5 accounts racing for seats, every rule held | `ConcurrencyAccounts`, `ConcurrencySeats` | `results/2026-10-17-concurrency-2/` (39/39 checks) |
| 0.10 s from a hold expiring to the next person's hold (p95 of 300) | `BackfillExpiredPNinetyFiveS` | `results/2026-10-17-backfill-2/` |
| 2 min to apply a request once after a worker crash (the 120 s SQS visibility timeout) | `FailureBeforeCommitSettleMedianS` (120.1 s) | `results/2026-10-17-failure-recovery-2/` (3/3) |
| Load-test chart, 0.00 % errors | `PerfDev{Cross,Hotspot}VU{Ten,TwentyFive,Fifty}SettlePNinetyFiveMs`, `PerfDevHotspotVUFiftyErrorPct` | `results/loadtest/2026-10-17/` (run `20261017T192002Z`) |
| US$13.30 → US$5.91 per 1,000 registrations; self-hosting cheaper above about 57,000 a month | `CostUnitOneKCloudListUsd`, `CostUnitHundredKCloudListUsd`, `CostCrossoverListFullRegs` | `results/cost/model-summary.md` (cost model, not a bill) |

Product facts (15-minute default hold, one FIFO message group per workshop, one DynamoDB transaction
per decision, a timer per offer plus a five-minute sweep) are from the code and
`docs/ARCHITECTURE.md`. The names in the illustration are invented examples, not participants.

## Design notes

- STePS guidelines (Poster Design Guidelines, 28th STePS): A1; title ~72–100 pt (here 100 pt), headings
  36–48 pt (42 pt), body 24–32 pt (22–27 pt; figure labels 16–24 pt, the footer 17 pt); 2–3 columns;
  2–3 colours (NUS blue for structure, one orange for held seats and time, a lighter blue as the chart
  series), visuals first, AI use disclosed.
- The two chart colours were checked with the dataviz palette validator (colour-blind separation and
  contrast against the paper colour); every chart has a legend and direct end labels.
- `render.mjs` fails the build if anything in the three columns reaches into the footer or if a figure is
  drawn narrower than its set width; both QR codes were decoded from the rendered PNG.
- Reviewed by independent design, accuracy and guideline reviews; the changes they asked for (simulation
  metrics that match what was modelled, wording that does not overstate the measurements, an AI-use
  statement matching the Final report's declaration, larger figure text) are in this version.
