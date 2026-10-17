# Market sizing — worked template for Final §1

> 团队摘要：按 plan §1.1 自底向上估算新加坡「会遇到多场次报名问题的组织者」数量 × p × S$120/年。§2 的表列出计划里初步检索到的候选数字，**每个数字在引用前都要回到官方页面核实日期并截图**（`results/market-sizing/`）；p 和每场人工小时来自访谈（`results/interviews/summary.md`）。§4 是带占位符的算例，§5 是 Final §1 的 120 词草稿，占位符用 `[ ]` 标出，提交前必须零命中。

Plan reference: `docs/plan/execution-plan.md` §1.1 (method, candidate figures, TAM/SAM/SOM, 4-row table + ~120 words), §7.1 (Final §1 page budget), §10 (placeholder check). Interview inputs: `docs/interviews/README.md` §5.

## 1. Method (bottom-up, plan §1.1)

1. Count the **organisers** in Singapore who could run multi-session sign-ups, in three groups: (a) registered student organisations of the 6 autonomous universities and 5 polytechnics; (b) institutional units that run workshops (libraries, career centres, IT services, teaching-support units, faculty offices); (c) SkillsFuture / CET training providers.
2. Multiply by **p**, the share of their events with ≥ 2 equivalent sessions, measured in the organiser interviews (A2 ÷ A1, event-weighted). Interpretation: the fraction of organiser-years in which the problem occurs; the report says so explicitly.
3. Price: **S$120 per organisation per year** (S$10/month, plan §1.1). Value check: person-hours saved per event × hourly rate × multi-session events per year must exceed S$120 for the price to be defensible.
4. Direct evidence of the multi-session phenomenon: a dated count of "same title, several sessions" entries in two public workshop calendars and one event platform.
5. Every count is an **estimate with a source and a year**, presented as such. No figure is cited from memory: it is verified on the official page, screenshotted with the date, and logged in `results/market-sizing/sources.csv` (`figure,value,url,quoted_phrase,page_date,verified_on,verified_by`).

## 2. Candidate figures (from plan §1.1) — all **to be re-verified on the official page before citing**

| # | Population | Candidate count | Source as found (plan §1.1) | Year of figure | How to verify | Status |
|---|---|---|---|---|---|---|
| 1 | NUS registered student organisations | > 200 | NUS Office of Student Affairs, student organisations page: "more than 200 student organisations" | undated web page | Open the OSA student-organisations page, quote the exact phrase, screenshot with date; cross-check by counting the NUSync / OSA directory | to re-verify |
| 2 | NTU student organisations | 103 | NTU official bulletin / news (older figure) | older (year to be found) | Count the NTU Student Affairs Office clubs-and-societies directory on the verification day; cite both the old figure with its year and the count | to re-verify |
| 3 | SMU clubs and societies | > 100 | SMU Office of Student Life: "over 100 clubs and societies" | undated web page | Open the SMU student-life page, quote, screenshot | to re-verify |
| 4 | SUTD student groups | > 80 | SUTD Student Life ("Fifth Row"): "over 80 student groups" | undated web page | Same | to re-verify |
| 5 | SIT clubs, chapters, interest groups | > 150 | SIT student-life page: "more than 150 student clubs, chapters and interest groups" | undated web page | Same | to re-verify |
| 6 | SUSS student organisations | [to find] | — | — | Count the SUSS student-life directory | missing |
| 7 | Polytechnic CCAs / student groups (SP, NP, TP, NYP, RP) | [to find] | — | — | Count each polytechnic's CCA directory; sum | missing |
| 8 | Institutional units that run workshops (libraries, career centre, IT, teaching support, faculties) per institution | [placeholder: ~10 per institution] | own estimate | — | List the units with a public workshop calendar at NUS (Libraries, Centre for Future-ready Graduates, NUS IT, CDTL, faculties) and extrapolate; state it as an assumption | assumption |
| 9 | SkillsFuture / CET training providers | > 700 | SSG announcement at SkillsFuture Credit launch: courses "by over 700 training providers" | 2016 | Search the MySkillsFuture course directory for the current provider count, or the latest SSG annual report; cite the newer number if found | to re-verify (old) |
| 10 | SSG-funded courses | > 30,000 | MOE parliamentary reply: "over 30,000 courses funded by SSG" | 2018 | Hansard / MOE parliamentary replies page; quote and date | to re-verify (old) |
| 11 | Trainees in SSG-supported training | 555,000 | SSG year-in-review / press release | 2024 | SSG newsroom; quote and date | to re-verify |
| 12 | Multi-session evidence: NUS Libraries workshop calendar | [count on date] | own count | date of count | Count titles with ≥ 2 sessions ÷ all titles in the visible month; screenshot | to collect |
| 13 | Multi-session evidence: Centre for Future-ready Graduates workshop calendar | [count on date] | own count | date of count | Same | to collect |
| 14 | Multi-session evidence: Eventbrite / Luma, Singapore, "workshop", one day | [count on date] | own count | date of count | Count listings and those with multiple dates; screenshot | to collect |
| 15 | Regional upper bound: universities in ASEAN | [to find] (e.g. ASEAN University Network member count) | — | — | AUN or UNESCO figure with year; one sentence only | missing |

Rows 1–5 together give the "about 600+ student organisations across five universities (polytechnics not included)" figure in plan §1.1. Rows 9–11 are order-of-magnitude context for group (c) only; the organiser count used in the formula is row 9.

## 3. Definitions and formulas

| Symbol | Meaning | Source |
|---|---|---|
| `N_clubs` | student organisations (rows 1–7) | verified counts |
| `N_units` | workshop-running institutional units (row 8 × institutions) | assumption, stated |
| `N_cet` | CET training providers (row 9) | verified count |
| `N_org = N_clubs + N_units + N_cet` | organisers in Singapore | — |
| `p` | share of events with ≥ 2 equivalent sessions | `results/interviews/summary.md` (organiser, event-weighted) |
| `P` | price, S$120 / organisation / year | plan §1.1 |
| `s` | share of organisers not locked into a closed institutional system and using free / SaaS tools today | interviews F2–F3, B1; stated assumption |
| `a` | year-1 adoption among reachable organisers | assumption (e.g. 0.10) |
| `h`, `w`, `k` | person-hours per multi-session event, hourly rate (S$), multi-session events per organiser per year | interviews C1; `[citation]` for `w`; interviews A2 |

```
TAM = N_org × p × P
SAM = TAM × s
SOM = (N_NUS_clubs + N_pilot_units) × p × a × P        # year 1: NUS student organisations + pilot departments
Value per organiser-year = h × w × k ;  defensible if  h × w × k ≥ P
```

## 4. Worked example (placeholders, **not** report numbers)

Inputs: `N_clubs ≈ 600` (rows 1–5; SUSS and polytechnics excluded), `N_units ≈ 60` (10 × 6 universities, row 8), `N_cet ≈ 700` (row 9, 2016), `p = [0.30]`, `s = [0.50]`, `a = [0.10]`, `h = [6 h]`, `w = [S$15/h]`, `k = [3]`.

| Step | Calculation | Result |
|---|---|---|
| Organisers | 600 + 60 + 700 | 1,360 |
| Organisers with the problem | 1,360 × 0.30 | 408 |
| **TAM** | 408 × S$120 | **≈ S$49,000 / year** |
| **SAM** | 49,000 × 0.50 | **≈ S$24,500 / year** |
| **SOM** (year 1) | (200 + 3) × 0.30 × 0.10 × S$120 | **≈ S$730 / year** |
| Value per organiser-year | 6 h × S$15 × 3 | S$270 ≥ S$120 |

Reading: a small, well-defined niche; the business case rests on hours saved, not on market size, and the report says so. Replace every bracketed input with the verified figure or the interview value before use; keep three significant figures at most.

## 5. Draft paragraph for Final §1 (≈ 120 words; placeholders must be resolved)

> We size the market bottom-up. Singapore's five largest universities list over 600 registered student organisations [citation NUS; NTU; SMU; SUTD; SIT], institutional units such as libraries and career centres run recurring workshops [citation], and SkillsFuture-funded training is delivered by over 700 providers [citation, 2016] to 555,000 trainees in 2024 [citation]. In our organiser interviews (n = [n]), [p × 100]% of events had two or more equivalent sessions, each costing [h] person-hours of manual coordination. At S$120 per organisation per year this gives a TAM of about S$[TAM], a serviceable market of S$[SAM] among organisers on free or SaaS tools, and a year-one obtainable market of S$[SOM] at NUS. The value to an organiser, [h] h × S$[w]/h per event, exceeds the price after [k] events.

Accompanying 4-row table (plan §1.1): population / count / source / estimation basis — take rows 1–5 (summed), 8, 9 and the interview-derived p from §2–§3.

## 6. Checklist before the paragraph enters the report

- [ ] Every row 1–5, 9–11 re-verified on the official page; `results/market-sizing/sources.csv` filled; screenshots saved
- [ ] Rows 12–14 counted on a stated date
- [ ] `p`, `h` taken from `results/interviews/summary.md` (not from memory)
- [ ] `w` has a citation (e.g. a published student-assistant or administrative hourly rate)
- [ ] Row 15 sentence added or dropped
- [ ] Placeholder scan of the report finds zero `[` `]` placeholders (plan §10)
