# Market sizing and competitor scan: verified inputs for Final §1

> 团队摘要：§2 是 2026-10-17 逐项核实过的计数表（每行有出处键、页面日期、核实等级）；NUS / SIT / SMU 三校官网对自动抓取有防护，只能从搜索引擎摘录核对，**提交前请组员用浏览器打开并截图**（§6 清单）。p 还没有（访谈未做），所以 §3 的公式里 p 保持符号，§4 只给 p = 0.2 / 0.4 的**示意**算例。§5 是竞品表，§7 是可直接放进 Final §1 的约 120 词段落（用 `\pending{}` 标出缺的 p）。所有出处键在 `report/references.bib`，每条的用途和核实方式在 `report/sources.md`。

Plan reference: `docs/plan/execution-plan.md` §1.1 (method, candidate figures, TAM/SAM/SOM, 4-row table and about 120 words), §7.1 (Final §1 page budget), §10 (placeholder check). Interview inputs: `docs/interviews/README.md` §5 (`results/interviews/summary.md`, not yet produced). Citation keys: `report/references.bib`. Per-source claims and verification notes: `report/sources.md`.

## 1. Method (bottom-up, plan §1.1)

1. Count the **organisers** in Singapore who could run multi-session sign-ups: (a) registered student organisations of the autonomous universities and polytechnics; (b) institutional units that run workshops (libraries, career centres, IT and teaching-support units); (c) SkillsFuture / CET training providers.
2. Multiply by **p**, the share of organisers whose events include two or more equivalent sessions, measured in the organiser interviews (event-weighted A2 ÷ A1, `docs/interviews/guide-organiser.md`). p is not available yet and stays symbolic.
3. Price **P = S$120 per organisation per year** (S$10/month, plan §1.1). Value check: person-hours saved per event × hourly rate × multi-session events per year must be at least P.
4. Every count is a dated estimate with a source key and a verification level. Counts given as "more than X" or "X+" enter the sum as X, so the totals are **lower bounds**.

## 2. Verified inputs (all accessed 2026-10-17)

Verification levels:

- **fetched**: the official page was downloaded and the quote was copied from its text.
- **own count**: we counted entries listed on official pages downloaded on the access date.
- **official excerpt**: the page is on the institution's own domain, but direct download was blocked (bot protection, HTTP 403, or client-side rendering), so the quote was read from the search engine's excerpt of that page. **Team action:** open these pages in a browser and keep a dated screenshot before submission (§8).

| # | Population | Count used | Exact quote or basis | Source key(s) | Page date | Verification |
|---|---|---|---|---|---|---|
| 1 | Autonomous universities (AUs) | 6 | "The 6 autonomous universities provide a wide range of academic, research, work-learn, and student life programmes …" | `moe-au` | last updated 05 Mar 2026 | fetched |
| 2 | Polytechnics | 5 | "There are currently 5 polytechnics in Singapore" (NYP, NP, RP, SP, TP) | `moe-psei` | last updated 23 Jan 2026 | fetched |
| 3 | NUS student organisations | 200 | "NUS has more than 200 official student organisations. These are the only student organisations that are allowed to use the NUS name and trademarks." Also "network with over 200 student organisations" (Get NUSync) | `nus-osa-getstarted`, `nus-nusync` | undated | official excerpt |
| 4 | NTU student organisations | 113 | Own count: 71 clubs listed under "A myriad of exciting activities awaits you when you join one of NTU's student organisations" + 19 Students' Union constituent clubs ("The Union consists of 16 academic constituent clubs and 3 non-academic constituent clubs.") + 23 hall councils ("There are 23 Halls of Residence in NTU and each hall has its own council."). Excludes the 58 Varsity Sports Association teams and the Graduate Students' Council. **Replaces** the old figure of 103 (Nanyang Bulletin 2009/10, whose page now returns 404). | `ntu-special-interest-clubs`, `ntu-su-council`, `ntu-clubs-societies` | HTTP Last-Modified 16 Oct 2026 | own count |
| 5 | SMU student organisations | 150 | "out of the 150+ student organizations in SMU, more than 90 are overseen by OSL" (2022 orientation page). Fetched lower bound on the 2025 orientation page: 95 clubs (Arts & Cultural Fraternity 21, Sports Union 32, SICS 22, SMUX 6, ICON 14 cultural clubs). **Replaces** the plan's "over 100". | `smu-osl-2022` (150); `smu-cb-2025` (95) | 2022; 2025 | official excerpt (150); own count (95) |
| 6 | SUTD student groups | 80 | "There are over 80 student groups on campus, and they are grouped into 5 clusters" | `sutd-fifth-row` | modified 25 Sep 2026 | fetched |
| 7 | SIT student organisations | 150 | Find Your Tribe: "more than 150 student clubs, chapters and interest groups". Life@SIT gives a higher figure, "170+ Student Organisations"; we use the lower one. | `sit-find-your-tribe`, `sit-life` | undated | official excerpt |
| 8 | SUSS and polytechnic student groups | not counted | SUSS interest-group page returned HTTP 403; polytechnic CCA directories were not checked. Their absence makes N_clubs a lower bound. | none | none | not counted |
| 9 | Institutional units that run workshops | not counted | No official count exists; the earlier "about 10 per institution" was our own assumption and is dropped from the numbers. | none | none | not counted |
| 10 | CET training providers | 700 | "over 18,000 approved skills-related courses, provided by over 700 training providers" (end of 2016). No newer official provider count was found: SSG Annual Report FY2024/25, SWDA newsroom and MOE parliamentary replies 2025–26 were checked. | `ssg-credit-progress-2016` | 2016 | official excerpt (old) |
| 11 | SSG-funded courses (context) | > 30,000 | "Currently, over 30,000 courses are funded by SkillsFuture Singapore (SSG)." | `moe-pq-2018-ssg-courses` | 20 Nov 2018 | fetched (old) |
| 12 | Learners in SSG-supported training (context) | 606,000 (2025) | "2025 also saw a significant number of 606,000 (555,000 in 2024) individuals, and 23,000 (24,000 in 2024) enterprises, participating in SSG-supported training." **Replaces** 555,000 (2024), which `ssg-yir-2024` states as "increased from about 520,000 in 2023 to 555,000 in 2024". The annual report rounds 2024 to "550,000". | `ssg-10th-anniversary-2026`; `ssg-yir-2024`; `ssg-ar-fy2425` | 09 Feb 2026; 09 Apr 2025; Aug 2025 | fetched |
| 13 | Multi-session evidence: NUS Libraries calendar | 11 of 37 | Own count of events listed on each day from 1 Aug to 16 Oct 2026: 80 events, of which 37 are tagged "Workshop" (28 distinct titles). Two titles ran several sessions and account for 11 of the 37: "LARC Library Tours" × 8 (26 Aug, 2 Sep) and "Library Essentials: Orientation Workshop" × 3 (5, 6, 11 Aug). Across all 59 non-exhibition events, 4 titles repeat and account for 16 events (27 %). Registration for these sessions was not handled in LibCal. | `nus-libcal` | captured 2026-10-17 | own count |
| 14 | Multi-session evidence: SMU Libraries calendar | 4 of 44 | Own count, same window: 44 events with 42 distinct titles. Two titles ran twice: "Library Orientation for New Research Staff" (4 Aug, 15 Sep; further sessions listed for 3 Nov and 1 Dec 2026) and "Learning Bloomberg The Fun Way" (10, 11 Sep). | `smu-libcal` | captured 2026-10-17 | own count |
| 15 | Regional upper bound (ASEAN) | dropped | The ASEAN University Network site lists no fetchable member count, so the regional sentence is dropped. | none | none | dropped |

Derived counts:

- **N_clubs = 200 + 113 + 150 + 80 + 150 = 693** student organisations at five AUs (rows 3–7). SUSS and the polytechnics are excluded.
- Fetched or own-count rows alone give **288** (NTU 113 + SUTD 80 + SMU 95). We use this as the sensitivity case if the excerpt-only figures cannot be confirmed by screenshot.
- **N_cet = 700** (row 10, 2016). It is old and excerpt-only, so the TAM is reported with and without it.
- The library calendars (rows 13–14) show that same-content sessions occur in practice. They also show that most titles run once, so they do **not** estimate p. A third calendar we checked, the NUS Centre for Future-ready Graduates PG career-workshop list for AY2026/27 Sem 1, has six titles with one session each (`report/sources.md`, "checked, not cited").

## 3. Definitions and formulas

| Symbol | Meaning | Source |
|---|---|---|
| `N_clubs` | student organisations, rows 3–7 (693; 288 in the sensitivity case) | §2 |
| `N_cet` | CET training providers, row 10 (700, 2016) | §2 |
| `N_org` | `N_clubs` (campus TAM) or `N_clubs + N_cet` (campus + CET TAM) | §2 |
| `p` | share of organisers whose events include ≥ 2 equivalent sessions (event-weighted A2 ÷ A1) | `results/interviews/summary.md` (**pending**) |
| `P` | price, S$120 per organisation per year | plan §1.1 |
| `s` | share of organisers who use free or SaaS tools and are not locked into a closed institutional system | interviews B1, F2, F3 (**pending**) |
| `a` | year-1 adoption among reachable organisers | assumption, stated when used (**pending**) |
| `N_NUS` | NUS student organisations, row 3 (200) | §2 |
| `N_pilot` | pilot departments in year 1 | team decision (**pending**) |
| `h`, `w`, `k` | person-hours per multi-session event, hourly rate (S$), multi-session events per organiser per year | interviews C1, A2; `w` needs a citation (**pending**) |

```
TAM  = N_org × p × P
SAM  = TAM × s
SOM  = (N_NUS + N_pilot) × p × a × P          # year 1: NUS student organisations + pilot departments
Value per organiser-year = h × w × k ;  price is defensible if  h × w × k ≥ P
```

With the verified counts, and only p, s and a left symbolic:

```
TAM_campus        = 693   × p × S$120 = S$83,160  × p   per year
TAM_campus+CET    = 1,393 × p × S$120 = S$167,160 × p   per year
TAM_campus (288)  = 288   × p × S$120 = S$34,560  × p   per year   (fetched / own-count rows only)
SAM               = TAM × s
SOM (NUS only)    = 200 × p × a × S$120 = S$24,000 × p × a   per year   (+ N_pilot × p × a × S$120)
```

## 4. Illustrative computation: **illustrative, replace with interview estimate**

> The two p values below are **not data**. They show how the formula behaves. In the report, p comes only from `results/interviews/summary.md`; until that file exists the report shows `\pending{p from organiser interviews}`.

| Quantity | p = 0.2 (illustrative) | p = 0.4 (illustrative) |
|---|---|---|
| Organisers with the problem, campus (693 × p) | 138.6 | 277.2 |
| TAM_campus = 693 × p × S$120 | S$16,632 / year | S$33,264 / year |
| TAM_campus+CET = 1,393 × p × S$120 | S$33,432 / year | S$66,864 / year |
| TAM_campus, sensitivity (288 × p × S$120) | S$6,912 / year | S$13,824 / year |
| SAM = TAM × s (campus) | S$16,632 × s | S$33,264 × s |
| SOM (NUS only) = 200 × p × a × S$120 | S$4,800 × a | S$9,600 × a |

Reading: even at the illustrative upper value the campus market is a few tens of thousands of dollars a year. The business case therefore rests on the hours each organiser saves (`h × w × k ≥ P`), not on market size, and the report should say so. Once p, s, a and h are known, keep at most three significant figures.

## 5. Competitor scan (for the compact table in Final §1)

Columns: **multi-session** = one listing can offer several dated sessions; **waitlist** = a native waitlist; **timed relay** = a released seat goes automatically to the next person, who has a time limit to claim it; **one seat across sessions** = the tool enforces at most one seat per person across all sessions of the same workshop; **price** = organiser-side price on the official pricing page on 2026-10-17.

| Tool | Multi-session | Waitlist | Timed relay | One seat across sessions | Price (organiser) | Keys |
|---|---|---|---|---|---|---|
| Eventbrite | Yes: "Recurring event"; each instance has its own ticket quantity | Yes, triggered "when a specific ticket type sells out or when your event reaches capacity"; for recurring events, tickets are released per date and time | Yes: "When a spot opens, Eventbrite automatically offers the ticket to the next person on the list"; the organiser sets "the maximum amount of time someone on your waitlist has to claim a spot" | Not documented: inventory and waitlist are per ticket type or date. "People can't see where they rank on the waitlist." | "No fees for free events"; paid: 3.7 % + $1.79 service fee per ticket and 2.9 % processing per order, normally paid by buyers (eventbrite.sg) | `eventbrite-multidate`, `eventbrite-waitlist`, `eventbrite-waitlist-feature`, `eventbrite-pricing-sg` |
| Luma | Workaround: clone the event (up to 30 at once) or use one ticket type per session; "we don't support bulk registration for events" | Yes, "Over-Capacity Waitlist" | No: the host approves or declines waitlisted guests | No (separate events) | Free; 5 % platform fee on paid events; Luma Plus US$59/month billed annually | `luma-multisession`, `luma-waitlist`, `luma-pricing` |
| Google Forms + Sheets | Manual: one form per session, or a choice question | No | No | No (manual duplicate check in Sheets) | Pricing page not checked | `google-forms-responses` |
| Microsoft Forms | Manual: one form per session, or a choice question | No | No | Per form only: "One response per person" (organisation or specific-people audiences), with no per-session capacity | Pricing page not checked | `ms-forms-settings` |
| SignUpGenius | Yes: "Give each club or session its own slot and set the quantity to your real limit" | Yes, per slot (Gold plan and above) | Relay without a hold: "SignUpGenius moves the first person on that slot's waitlist into the open spot and emails them that they're in" | Partial: paid "Quantity Limits" cap slots per user (support page not fetchable, HTTP 403); not linked to the waitlists | Gold US$22.49/month billed annually (US$29.99 monthly) | `signupgenius-waitlist`, `signupgenius-pricing` |
| Calendly (group event type) | Yes: time slots with an invitee limit per slot (2–9,999) | Not documented | No | Not documented | Group events on "All paid plans"; Standard US$10/seat/month billed yearly | `calendly-group`, `calendly-pricing` |
| Peatix | Yes: "Recurring event", up to 50 dates/times, the same ticket quantity for each session | No: "Peatix does not have an automated waiting list feature" (manual workaround) | No | No | "Zero cost for free events & tickets"; paid: 4.9 % + 0.99 SGD per ticket | `peatix-recurring`, `peatix-waitlist`, `peatix-pricing-sg` |
| NUS NUSync (OSA) | Students "register for events" on NUSync | No public documentation found | No public documentation found | No public documentation found | Institutional | `nus-nusync` |
| **SeatRelay** | Yes: one workshop, 2–5 sessions, one queue | Yes | Yes: timed hold (default 900 s), automatic relay | Yes: at most one OFFERED or CONFIRMED seat per account per workshop (C2) | S$10/month (planned) | this report |

Reading: Eventbrite is the only scanned tool with automatic relay and a timed claim window, but it treats each date and ticket type as a separate inventory. No scanned tool ties several acceptable sessions to one queue position with a one-seat-per-person rule. These cells are the vendors' documentation as of 2026-10-17, not our tests.

## 6. Final §1 four-row table (plan §1.1)

| Population | Count | Source | Estimation basis |
|---|---|---|---|
| Student organisations, 5 AUs | ≥ 693 | `nus-osa-getstarted`, `ntu-special-interest-clubs`, `ntu-su-council`, `smu-osl-2022`, `sutd-fifth-row`, `sit-find-your-tribe` | official counts as lower bounds; NTU counted from its directory pages on 2026-10-17 |
| CET training providers | > 700 (2016) | `ssg-credit-progress-2016` | latest official count found; context, reported separately |
| Organisers with multi-session sign-ups | 693 × p | organiser interviews | `\pending{p from organiser interviews}` |
| Price | S$120 per organiser-year | plan §1.1 | S$10/month; justified by `h × w × k ≥ P` |

## 7. Paragraph for Final §1 (about 120 words, LaTeX)

```latex
We size the market bottom-up. Singapore has six autonomous universities and five
polytechnics~\cite{moe-au,moe-psei}; five of the universities alone list at least 693 student
organisations~\cite{nus-osa-getstarted,ntu-special-interest-clubs,ntu-su-council,ntu-clubs-societies,smu-osl-2022,sutd-fifth-row,sit-find-your-tribe},
and SSG-supported training reached 606{,}000 learners in 2025~\cite{ssg-10th-anniversary-2026}.
Repeated sessions occur in practice: 11 of 37 workshop events on the NUS Libraries calendar
(1~Aug--16~Oct 2026) were repeats of two titles~\cite{nus-libcal}. With \(p\) the share of
organisers running multi-session sign-ups (\pending{p from organiser interviews}) and S\$120 per
organiser-year, the campus TAM is \(693 \times p \times \text{S\$}120 \approx \text{S\$}83{,}000\,p\)
a year; SAM and SOM apply the shares on free or SaaS tools and adopting in year one. No scanned
tool combines one queue across sessions with timed relay (Table~\ref{tab:competitors}).
```

About 120 words of prose (citations excluded). The only placeholder is `\pending{…}` for p, which the build check counts until `results/interviews/summary.md` exists. `tab:competitors` is the label the report should give the §5 table.

## 8. Checklist before the paragraph enters the report

- [x] Rows 1, 2, 4, 6, 10–14 verified on 2026-10-17 (fetched or own count; row 10 is an excerpt of an old page)
- [ ] Rows 3, 5, 7 (NUS, SMU, SIT): a team member opens each official page in a browser and saves a dated screenshot. If a figure has changed, update §2 and the derived N_clubs.
- [ ] `p`, `h`, `s` taken from `results/interviews/summary.md` (not from memory); replace the illustrative §4 rows.
- [ ] `w` (hourly rate) has a citation.
- [ ] Optional: count SUSS and polytechnic student groups to raise the lower bound.
- [ ] Placeholder scan of the report finds no `\pending{}` left (plan §10).
