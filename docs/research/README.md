# SeatRelay Research (simulated): interviews and usability study

The package contains **nine authored interview profiles (six student, three organiser) and a generated usability study for twelve participant profiles; no people took part**.

Method and data source: interview scenarios are authored and task/questionnaire responses are generated; no people were recruited or observed. The scenario share p = 37.0 % uses the three organiser profiles only (SIM-I07 to SIM-I09, 20 of 54 events); the student profiles carry event counts for context and are excluded from p. Section 2 of the full research report documents generation, interpretation limits and provenance metadata.

## Materials within one research programme

Interviews and the usability comparison belong to the same research programme. Directories separate their responsibilities:

| Directory | Content and relationship |
|---|---|
| [docs/interviews](../interviews/README.md) | Interview guides, question design, coding rules and record templates: method materials |
| [docs/user-study](../user-study/README.md) | Usability protocol, task cards, control setup, SUS and counterbalancing: method materials |
| `docs/research` | The overall entry point connecting methods, results, analysis and reports |
| [results/research](../../results/research/) | Interview records, theme coding, task/questionnaire responses, analysis, charts and provenance manifests |
| [Final research section](../../report/sections/04-evaluation.tex) | Methods, key results and conclusions within the main project report |

## Reading order

There is one formal study. Each participant uses SeatRelay and forms plus a spreadsheet, giving 112 task attempts and 24 ten-item SUS forms. Two pre-study scenarios are excluded from the formal sample. Design improvements remain recommendations; no second evaluation is included.

1. [Full research report](../../results/research/summary.md): methods, outcomes, negative cases, priorities and limitations.
2. [Individual interview records](../../results/research/interviews/): SIM-I01 to SIM-I09, each covering a concrete episode, workflow, needs, counterexamples, quantitative assumptions, scripted statements and codes.
3. [Analysis summary](../../results/research/summary.json), [paired timing by participant](../../results/research/paired-subjects.csv) and [SUS item responses](../../results/research/sus-sheet.csv).
4. [English companion report source](../../report/Research.tex), built as `report/Research.pdf`. The main report and slides use the same data.
5. [Generation, validation and reproduction](../../tools/research/README.md).

`Final.pdf` already contains the methods, key findings and conclusions. `Research.pdf` is an optional detailed appendix based on the same data, not a separate study.

## Presentation guidance

“The research uses nine interview scenarios and twelve participants' task responses, following the existing task cards and counterbalanced control order. It demonstrates how task records produce completion rates, paired timing and SUS scores. Failures and opposing views help identify held-versus-confirmed confusion, ranking, date-entry and short-window problems. The numbers reflect declared model assumptions rather than observed user validation.”

Show the completion chart and explain why assisted success is separate from unassisted success. Then show paired timing and explain why one person's repeated tasks are not independent participants. Use SIM-I04's simple-form counterexample and SIM-I09's procurement constraint to explain the limits of adoption and pricing conclusions.

## Relationship to the field-study plan

`docs/interviews/` and `docs/user-study/` retain protocols and blank templates for future fieldwork. Generated records do not populate `results/interviews/` or `results/user-study/`. Existing field-evidence macros retain their meaning; this package uses separate `Sim*` macros. Natural pilot observations and existing system experiments remain separate evidence.
