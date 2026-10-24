# Part 1: problem, market, business model

- **Speaker:** LI ZONGZE (product and front end). You also operate the participant browser in the
  live demo ([part-4.md](part-4.md)).
- **Clock:** 0:00–2:00 (2:00)
- **Slides:** 1 Title, 2 Problem and market, 3 Business model (`report/Slides.tex`)
- **Hands over to:** Part 2 (mechanism and rules)

## What to say (about 270 spoken words, 1:50 at 150 words a minute)

**Slide 1, title (5 s).** Good afternoon. We are Team 18, and this is SeatRelay.

**Slide 2, problem and market.**
Many campus workshops run the same content several times. Typically the organiser opens one form per
session and keeps a spreadsheet. A student who could attend two sessions can sign up for both to be
safe, so one person holds two seats, and the organiser finds the duplicates by hand. When someone drops out, the seat stays empty
unless somebody e-mails the waiting list.

SeatRelay replaces this with one registration per workshop. You rank every session you can attend and
join one queue, and you hold at most one seat. A freed seat is offered to the next person in the queue
who accepts that session, for a limited time; unanswered, it moves on by itself.

Repeats do happen: on the NUS Libraries calendar from August to mid-October, 11 of the 37 workshop
events were repeats. Five universities list at least 713 student
organisations, a lower bound. At our price the campus market is 713 times p times S$120, about S$85,600
times p a year, where p is the share of organisers with multi-session sign-ups, from our interviews:
[PENDING: p, from results/interviews/summary.md].

**Slide 3, business model.**
Organisers pay; participants never do. There is a free tier, and the organiser plan costs S$10 a
month. The market is small, so the case rests on the hours an organiser saves
per multi-session event: [PENDING: median hours per event and willingness to pay, from
results/interviews/summary.md]. In our simulation, per-session forms left 3.87 duplicate confirmed
seats per workshop to chase; one queue left none. Eventbrite relays tickets, but only within one date;
no tool we scanned ties sessions to one queue place. Our first users would be NUS student organisations, starting with our
planned pilot workshop (once the pilot has run, drop "planned").

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
events ÷ Σ events. On 2026-10-17 no interview had taken place; on the day, give the real number
([PENDING: n organisers]). They will be a convenience sample from our network, and the report states
that as a limitation. The organisation counts are lower bounds: "more than X"
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
