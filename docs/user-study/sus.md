# System Usability Scale (SUS)

Administered **twice** per participant, immediately after each condition (`protocol.md` §4, §5), on paper, then transcribed into `sus-sheet.csv`. Original wording from Brooke, J. (1996). *SUS: A "quick and dirty" usability scale.* In P. W. Jordan et al. (eds), *Usability Evaluation in Industry*, Taylor & Francis. Do not reword the items (the wording is what makes SUS scores comparable with the published benchmarks).

## 1. Items (Brooke 1996)

Response scale: 1 = Strongly disagree … 5 = Strongly agree. Positive items are odd, negative items even.

| # | Statement |
|---|---|
| 1 | I think that I would like to use this system frequently. |
| 2 | I found the system unnecessarily complex. |
| 3 | I thought the system was easy to use. |
| 4 | I think that I would need the support of a technical person to be able to use this system. |
| 5 | I found the various functions in this system were well integrated. |
| 6 | I thought there was too much inconsistency in this system. |
| 7 | I would imagine that most people would learn to use this system very quickly. |
| 8 | I found the system very cumbersome to use. |
| 9 | I felt very confident using the system. |
| 10 | I needed to learn a lot of things before I could get going with this system. |

## 2. Scoring

| Items | Contribution per item |
|---|---|
| Odd (1, 3, 5, 7, 9) | score − 1 |
| Even (2, 4, 6, 8, 10) | 5 − score |
| Total | (sum of the 10 contributions) × 2.5 → 0–100 |

Example: answers 4,2,4,1,4,2,5,2,4,2 → contributions 3,3,3,4,3,3,4,3,3,3 = 32 → **80**.

Rules:
- Every item must be answered. If one is blank, ask the participant to fill it in before they leave; if that is impossible, record the row with the blank cell empty and `analysis.py` will drop that row with a warning (no imputation).
- `analysis.py` recomputes `sus_score` from q1–q10 and warns if a transcribed `sus_score` differs; leaving `sus_score` empty in the CSV is fine.
- Interpretation for the report (state as context, not as a claim about our sample): the published mean across many systems is ≈ 68; the plan's target for SeatRelay is ≥ 75; report the mean with a 95 % CI and n, per condition, plus the paired difference.

## 3. Answer sheet (print two per participant; cut along the line)

```
----------------------------------------------------------------------------------------------
SeatRelay user evaluation — questionnaire        Participant ID: P____      Round: 1 / 2

Tool you just used (facilitator ticks):   [ ] SeatRelay      [ ] Google Forms + spreadsheet

In the statements below, "the system" means the sign-up tool you have just used.
Tick ONE box per line. Answer quickly; first impressions are fine.

                                                        Strongly                      Strongly
                                                        disagree                         agree
                                                           1       2       3       4       5
 1. I think that I would like to use this system
    frequently.                                           [ ]     [ ]     [ ]     [ ]     [ ]
 2. I found the system unnecessarily complex.             [ ]     [ ]     [ ]     [ ]     [ ]
 3. I thought the system was easy to use.                 [ ]     [ ]     [ ]     [ ]     [ ]
 4. I think that I would need the support of a
    technical person to be able to use this system.       [ ]     [ ]     [ ]     [ ]     [ ]
 5. I found the various functions in this system
    were well integrated.                                 [ ]     [ ]     [ ]     [ ]     [ ]
 6. I thought there was too much inconsistency in
    this system.                                          [ ]     [ ]     [ ]     [ ]     [ ]
 7. I would imagine that most people would learn to
    use this system very quickly.                         [ ]     [ ]     [ ]     [ ]     [ ]
 8. I found the system very cumbersome to use.            [ ]     [ ]     [ ]     [ ]     [ ]
 9. I felt very confident using the system.               [ ]     [ ]     [ ]     [ ]     [ ]
10. I needed to learn a lot of things before I could
    get going with this system.                           [ ]     [ ]     [ ]     [ ]     [ ]

Facilitator use only:  transcribed to sus-sheet.csv  [ ]     score (optional) ______
----------------------------------------------------------------------------------------------
```

## 4. Transcription into `sus-sheet.csv`

| Column | Value |
|---|---|
| `participant_id` | `P01` … `P12` |
| `condition` | `SR` or `CTRL` |
| `q1` … `q10` | 1–5 as ticked |
| `sus_score` | optional (0–100); leave empty to let the script compute it |

One row per participant per condition → 24 rows when all 12 participants are done.
