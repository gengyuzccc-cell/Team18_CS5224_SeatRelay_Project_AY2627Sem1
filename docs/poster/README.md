# STePS poster (A1)

| File | What it is |
|---|---|
| `seatrelay-steps-poster.png` | The poster image for the STePS registration: A1 portrait at 150 dpi, 3508 × 4967 px |
| `seatrelay-steps-poster.pdf` | The same poster as a vector A1 PDF (594 × 841 mm), for the free A1 print by SoC Technical Services |
| `poster.template.html` | The source: layout, text, the comparison illustration and the architecture diagram (HTML + inline SVG) |
| `build.py` | Fills the numbers into the template and draws the two charts, then calls `render.mjs` |
| `render.mjs` | Prints `poster.html` with Chromium (Playwright from `tools/e2e`) to the PNG and the PDF |
| `img/ui-*.png` | Contiguous crops (nothing edited in or out; the poster fades each crop's right edge with a CSS mask) of the deployed web app at 3× pixel density: a staged walkthrough on dev with test accounts on 24 Oct 2026, after the web redesign, `E2E_SCALE=3 pnpm --filter @seatrelay/e2e walkthrough -- --stage dev --no-publish --no-results --no-video` (44 checks passed; not a measurement run, so not in `results/`; the published 1× run of the same day is `results/2026-10-24-web-walkthrough-dev/`) |
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
| 3.9 → 0 second seats held at the end, 5.1 → 3.4 min to refill a freed seat (median workshop, including people's reply time; means 15.7 → 4.3), 88.6 % → 95.0 % of seats given to different people | `ReplayDupConfirmed*Mean`, `ReplayRefillMean*Median` (`*Mean` in the note), `ReplayFillRate*Mean`, `ReplaySeeds`, `ReplayRefillMeanN` | `results/replay/` (simulation, labelled as such; the baseline is an automatic waitlist per session) |
| 8/8 scripted experiments from the proposal's Table 3 (the user study and pilot rows are not among them) | `SeriesPassed`, `SeriesExperiments` | the quoted Table 3 series pinned in `report/series.json` |
| 0 overbooked sessions or people with two seats (672 checks) | `CorrectnessChecksTotal` | `results/2026-10-17-correctness-2/` |
| 50 accounts raced for 5 seats, every invariant held (39 checks) | `ConcurrencyAccounts`, `ConcurrencySeats`, `ConcurrencyChecksTotal` | `results/2026-10-17-concurrency-2/` |
| 0.10 s from a hold expiring to the next person's hold (p95 of 300) | `BackfillExpiredPNinetyFiveS` | `results/2026-10-17-backfill-2/` |
| 3/3 forced worker crashes, each request applied once on the queue's 2-min retry (the configured 120 s SQS visibility timeout) | `FailureBeforeCommitPassed`, `FailureBeforeCommitCases`, `FailureBeforeCommitSettleMedianS` (120.1 s) | `results/2026-10-17-failure-recovery-2/` |
| Load-test chart (p95 time to the final answer), 0.00 % errors | `PerfDev{Cross,Hotspot}VU{Ten,TwentyFive,Fifty}SettlePNinetyFiveMs`, `PerfDevHotspotVUFiftyErrorPct` | `results/loadtest/2026-10-17/` (run `20261017T192002Z`) |
| US$13.30 / US$5.91 per 1,000 registrations at 1k / 100k a month; an own server cheaper above about 57,000 a month if fully costed, or about 3,900 if one is already running | `CostUnitOneKCloudListUsd`, `CostUnitHundredKCloudListUsd`, `CostCrossoverListFullRegs`, `CostCrossoverListIncrementRegs` | `results/cost/model-summary.md` (cost model, not a bill) |

Product facts (15-minute default hold, one FIFO message group per workshop, one DynamoDB transaction
per decision, a timer per offer plus a five-minute sweep, the notifier Lambda between the table's stream and SES) are
from the code and `docs/ARCHITECTURE.md`. The names in the illustration are invented examples, not participants;
the same twelve people appear on both sides.

## Design notes

- STePS guidelines (Poster Design Guidelines, 28th STePS): A1; title ~72–100 pt (here 100 pt), headings
  36–48 pt (42 pt), body 24–32 pt (23–27 pt; figure labels 18–25 pt, the footer 17 pt); 2–3 columns;
  2–3 colours (NUS blue for structure, one orange for held seats and time, a lighter blue as the chart
  series; SeatRelay's seats in the illustration use the same blue as its bars), visuals first, AI use disclosed.
- The two chart colours were checked with the dataviz palette validator (colour-blind separation and
  contrast against the paper colour); every chart has a legend (inside the empty corner of the load chart)
  and direct end labels.
- `render.mjs` fails the build if a column runs past the grid or into the footer, or if a figure is drawn
  narrower than its set width, and prints the space left under each column; both QR codes were decoded
  from the rendered PNG.
- Reviewed by independent design, accuracy and guideline reviews; the changes they asked for (simulation
  metrics that match what was modelled, wording that does not overstate the measurements, an AI-use
  statement matching the Final report's declaration, larger figure text) are in this version, and a second
  round checked each of those fixes (it led to the scripted-experiment wording, the 3/3 crash row, both cost
  crossovers, one cast across the illustration and balanced columns).
