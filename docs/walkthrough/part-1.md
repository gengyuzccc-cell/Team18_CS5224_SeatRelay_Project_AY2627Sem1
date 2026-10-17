# Part 1: problem, market, business model

- **Speaker:** LI ZONGZE
- **Clock:** 0:00–2:00 (2:00)
- **Slides:** 1 Title, 2 Problem and market, 3 Business model (`report/Slides.tex`)
- **Hands over to:** Part 2 (mechanism and rules)

## What to say (about 330 words)

**Slide 1, title (5 s).** Good afternoon. We are Team 18, and this is SeatRelay.

**Slide 2, problem and market.**
Many campus workshops run the same content several times. A library orientation runs on three
mornings, and a career workshop runs on two evenings. Today the organiser usually opens one form per
session and keeps a spreadsheet. Students who could attend two sessions sign up for both, to be safe.
So one person holds two seats, and the organiser has to find the duplicates by hand. When someone
drops out, the seat stays empty unless somebody e-mails the next person on a waiting list.

SeatRelay replaces this with one registration per workshop. You list every session you can attend,
in order of preference, and you join one queue. You hold at most one seat at a time. When a seat
frees up, it is offered to the next person in the queue who accepts that session, and they have a
time limit to confirm. If they do not answer in time, the seat moves on by itself.

How many organisers have this problem? We sized the market bottom-up from official counts. Five of
Singapore's autonomous universities list at least 693 student organisations. That is a lower bound:
it leaves out the polytechnics and university departments. Repeated sessions do happen. On the NUS
Libraries calendar from August to mid-October, 11 of the 37 workshop events were repeats of just two
titles. The share of organisers who run multi-session sign-ups, which we call p, comes from our
interviews: [PENDING: p, from results/interviews/summary.md].

**Slide 3, business model.**
We plan a free tier with one open workshop at a time, and an organiser plan at S$10 per
organisation per month, S$120 a year. The campus market is then 693 × p × S$120, about S$83,200
times p per year. That market is small, so our case rests on the
hours an organiser saves on each multi-session event: [PENDING: median hours per event and
willingness to pay, from results/interviews/summary.md].

On competition, Eventbrite does relay a released ticket with a claim window, but only within one
date. *(optional)* None of the tools we scanned ties several acceptable sessions to one queue
position with one seat per person.

Next, CHEN YANG explains the rules that make this work.

## Key numbers

| Number | Value | Source |
|---|---|---|
| Autonomous universities / polytechnics in Singapore | 6 / 5 | `docs/market-sizing.md` §2 rows 1–2 (`moe-au`, `moe-psei` in `report/references.bib`) |
| Student organisations at five universities (lower bound) | ≥ 693 (NUS 200, NTU 113, SMU 150, SUTD 80, SIT 150) | `docs/market-sizing.md` §2 rows 3–7. The NUS, SMU and SIT counts were read from search excerpts and need dated screenshots (§8 checklist). Fetched and own-count rows alone give 288. |
| Repeats on the NUS Libraries calendar, 1 Aug–16 Oct 2026 | 11 of 37 events tagged Workshop: two titles, a library tour 8 times and an orientation workshop 3 times | `results/market/2026-10-17/summary.md` (`tools/market/count.py` over the captures in `raw/`; `nus-libcal`) |
| CET training providers (context, 2016) | more than 700 | `docs/market-sizing.md` §2 row 10 (`ssg-credit-progress-2016`) |
| Price | S$10/month = S$120 per organisation per year | plan §1.1 (a design decision, not data) |
| Campus TAM | 693 × p × S$120 ≈ S$83,200 × p per year (three significant figures; a lower bound like the 693) | `results/market/2026-10-17/counts.json` (`\MarketTamCampusSgd`); `docs/market-sizing.md` §3 |
| p (share of organisers with multi-session sign-ups) | [PENDING: from organiser interviews] | `results/interviews/summary.md` (`\InterviewPEventWeightedPct`) |
| Interviews held (organisers / participants) | [PENDING] | `results/interviews/summary.md` (`\InterviewN`, `\InterviewOrganisers`, `\InterviewParticipants`) |
| Hours of coordination per multi-session event | [PENDING] | `results/interviews/summary.md` (`\InterviewHoursMedian`) |
| Willingness to pay (van Westendorp medians) | [PENDING] | `results/interviews/summary.md` (`\InterviewWtpBargainMedian`, `\InterviewWtpExpensiveMedian`) |
| Free tier and plan details | free tier: one open workshop at a time; organiser plan S$10/month (S$120/year) with any number of open workshops and co-organisers; the prototype does not enforce plan limits | Final report §2 (a design decision, not data) |
| Duplicate confirmed seats left for the organiser, per workshop (simulation) | 3.87 with per-session forms, 0.00 with one queue | `results/replay/summary.md` (headline table) |

Do not quote the illustrative p = 0.2 / 0.4 rows of `docs/market-sizing.md` §4. They are not data.

## Likely questions

**Q1. How did you get p, and how reliable is it?**
p is the event-weighted share of organisers' events that run two or more equivalent sessions. It is
computed from interview questions A1 and A2 (`docs/interviews/guide-organiser.md`) as Σ multi-session
events ÷ Σ events. We interviewed [PENDING: n] organisers, a convenience sample from our network,
which the report states as a limitation. The organisation counts are lower bounds: "more than X"
counts as X, and SUSS and the polytechnics are excluded. That is why we give the TAM as a formula
in p instead of guessing it.

**Q2. Why would an organiser pay S$10 a month when Google Forms is free?**
The price has to be below the time it saves: hours per multi-session event × hourly rate × such
events per year must be at least S$120. The interview figures are [PENDING: hours, WTP from
results/interviews/summary.md]. Free forms leave duplicate detection and waitlist e-mails to the
organiser. In our simulation of 1,000 workshops, per-session forms left 3.87 duplicate confirmed
seats per workshop for the organiser to chase, against none with one queue
(`results/replay/summary.md`).

**Q3. Doesn't Eventbrite already do this?**
Partly. Eventbrite's waitlist offers a released ticket to the next person with a claim window, but
inventory and waitlist are per ticket type or date, and its documentation says "People can't see
where they rank on the waitlist" (`docs/market-sizing.md` §5, vendor documentation read on
2026-10-17). No scanned tool enforces one seat per person across the sessions of one workshop, and
that rule is what removes duplicate holds. SignUpGenius relays without a hold. Luma and Peatix have
no automatic relay.
