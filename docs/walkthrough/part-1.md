# Part 1: problem, market, business model

- **Speaker:** LI ZONGZE (product and front end). You also operate the participant browser in the
  live demo ([part-4.md](part-4.md)).
- **Clock:** 0:00–2:00 (2:00)
- **Slides:** 1 Title, 2 Problem and market, 3 Business model (`report/Slides.tex`)
- **Hands over to:** Part 2 (mechanism and rules)

## What to say (about 285 spoken words, 1:54 at 150 words a minute)

**Slide 1, title (5 s).** Good afternoon. We are Team 18, and this is SeatRelay.

**Slide 2, problem and market.**
Many campus workshops run the same content several times. Typically the organiser opens one form per
session and keeps a spreadsheet. A student who could attend two sessions can sign up for both to be
safe, so one person holds two seats, and the organiser finds the duplicates by hand. When someone drops out, the seat stays empty
unless somebody e-mails the waiting list.

SeatRelay replaces this with one registration per workshop. You rank every session you can attend and
join one queue, and you hold at most one seat. A freed seat is offered to the next person in the queue
who accepts that session, for a limited time; unanswered, it moves on by itself.

Repeats do happen: on the NUS Libraries calendar from August to mid-October, 11 of 37 workshop events were repeats. Five universities list at least 713 student organisations, a lower bound. The campus-market formula is 713 times p times S$120 per year. In the three organiser research scenarios, p is 20 multi-session events out of 54 annual events, or 37.0 percent. This illustrates the formula; it does not estimate real market demand.

**Slide 3, business model.**
Organisers pay; participants never do. The proposal is a free tier and an organiser plan at S$10 a month. The three organiser scenarios have a median coordination baseline of four hours per event and assumed bargain/expensive monthly prices of S$8/S$15. Baseline work is not time saved, and these responses are not purchasing commitments. In the separate mechanism simulation, per-session forms left 3.87 duplicate confirmed seats per workshop, while one queue left none. Eventbrite relays tickets within one date; our mechanism connects acceptable sessions to one queue place. The proposed first users are NUS student organisations.

Next, CHEN YANG explains the rules that make this work.

## Key numbers

| Number | Value | Source |
|---|---|---|
| Autonomous universities / polytechnics in Singapore | 6 / 5 | `docs/market-sizing.md` §2 rows 1–2 (`moe-au`, `moe-psei` in `report/references.bib`) |
| Student organisations at five universities (lower bound) | ≥ 713 (NUS 200, NTU 113, SMU 150, SUTD 80, SIT 170) | `docs/market-sizing.md` §2 rows 3–7. The NUS, SMU and SIT counts were confirmed with dated browser screenshots on 2026-10-24 (`results/market/screenshots/`); SIT's page now says 170 (it said 150 on 17 Oct). |
| Repeats on the NUS Libraries calendar, 1 Aug–16 Oct 2026 | 11 of 37 events tagged Workshop: two titles, a library tour 8 times and an orientation workshop 3 times | `results/market/2026-10-17/summary.md` (`tools/market/count.py` over the captures in `raw/`; `nus-libcal`) |
| CET training providers (context, 2016) | more than 700 | `docs/market-sizing.md` §2 row 10 (`ssg-credit-progress-2016`) |
| Price | S$10/month = S$120 per organisation per year | plan §1.1 (a design decision, not data) |
| Campus TAM | 713 × p × S$120 ≈ S$85,600 × p per year (three significant figures; a lower bound like the 713) | `results/market/2026-10-17/counts.json` (`\MarketTamCampusSgd`); `docs/market-sizing.md` §3 |
| p (event-weighted share of multi-session events in organiser scenarios) | 20/54 = 37.0%; scenario input | `results/research/summary.json`, `interview_scenario.event_weighted_multi_session_pct` |
| Interview scenarios (organisers / students) | 3 / 6 | `results/research/interviews.csv`; source method in `results/research/summary.md` section 2 |
| Baseline coordination per event | median 4.0 hours; not time saved | `results/research/summary.json`, `interview_scenario.baseline_coordination_hours_median` |
| Assumed price responses (organisers) | bargain median S$8, expensive median S$15 per organisation-month | `results/research/interviews.csv`; no empirical pricing claim |
| Free tier and plan details | free tier: one open workshop at a time; organiser plan S$10/month (S$120/year) with any number of open workshops and co-organisers; the prototype does not enforce plan limits | Final report §2 (a design decision, not data) |
| Duplicate confirmed seats left for the organiser, per workshop (simulation) | 3.87 with per-session forms, 0.00 with one queue | `results/replay/summary.md` (headline table) |

Do not quote the illustrative p = 0.2 / 0.4 rows of `docs/market-sizing.md` §4. They are not data.

## Likely questions

**Q1. How did you get p, and how reliable is it?**
p is the event-weighted share: sum of multi-session events divided by sum of annual events. The three organiser scenarios specify 20/54, or 37.0 percent. These inputs are authored, not observed interviews; they show how the market formula works. Official organisation counts remain independently sourced lower bounds, with SUSS and the polytechnics excluded.

**Q2. Why would an organiser pay S$10 a month when Google Forms is free?**
The proposed annual price must be justified by time saved per event times the value of an hour times events per year. The research scenarios assume a four-hour coordination baseline and bargain/expensive monthly prices of S$8/S$15; neither establishes actual time saved or purchasing intent. The separate mechanism simulation exposes duplicate-seat cleanup as one potential source of manual effort. Price and adoption require field validation.

**Q3. Doesn't Eventbrite already do this?**
Partly. Eventbrite's waitlist offers a released ticket to the next person with a claim window, but
inventory and waitlist are per ticket type or date, and its documentation says "People can't see
where they rank on the waitlist" (`docs/market-sizing.md` §5, vendor documentation read on
2026-10-17). No scanned tool enforces one seat per person across the sessions of one workshop, and
that rule is what removes duplicate holds. SignUpGenius relays without a hold. Luma and Peatix have
no automatic relay.
