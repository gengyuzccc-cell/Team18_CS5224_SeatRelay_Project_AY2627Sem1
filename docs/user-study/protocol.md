# Session protocol (facilitator + note-taker script)

> 团队摘要：每位参与者约 40 分钟，先后使用 SeatRelay 和对照（每场一个 Google Form + 电子表格），顺序与数据集按 `counterbalance.csv` 分配。
> 主持人逐字读任务卡，读完开始计时，参与者说 "done" 停表，5 分钟封顶计失败；提示只按"提示阶梯"给，给了提示算 assisted。
> 每个任务结束后记录员立刻在 `session-sheet.csv` 写一行；每个条件后立刻做 SUS；最后 4 分钟简短访谈，记录到 `interview-notes.md`。

Total ≈ 40 min. Times are cumulative targets, not hard limits, except the per-task 5-minute cap.

## 0. Before the participant arrives (10 min, not counted)

| Check | Done |
|---|---|
| `counterbalance.csv` row for this ID: track, order (SR_first / CTRL_first), dataset for round 1 and round 2 | ☐ |
| SeatRelay reset to the round-1 dataset for this track (`tasks-participant.md` §1 / `tasks-organiser.md` §1 state tables); persona logged in on the participant laptop | ☐ |
| Control reset to the round-1 dataset (`control-condition-setup.md` §6 checklist); persona Gmail inbox empty; organiser Gmail drafts present | ☐ |
| Task cards for this track, both conditions, both datasets, in the right order | ☐ |
| 2 consent forms, 2 SUS sheets, stopwatch, note-taker CSV open with a blank block of rows | ☐ |
| Facilitator laptop: organiser dashboard + "other participant" account (organiser track only) | ☐ |

The reset for round 2 happens while the participant fills in the first SUS sheet (2 min). Prepare it so it is one command / one version-restore.

## 1. Welcome and consent — 0:00–5:00

Say (verbatim is fine, natural tone is better):

> "Thanks for coming. We are evaluating two ways of signing up for workshops that run several identical sessions. You will try both tools, one after the other, doing the same kind of small tasks in each. We are testing the tools, not you — if something is confusing, that is a finding for us. There are no right or wrong ways to proceed. You can stop at any time without giving a reason. Please read and sign this form."

- Hand over `consent.md`. Answer questions. Both copies signed; participant keeps one.
- Write the participant ID on the consent form, the SUS sheets and the task cards. Never write the name anywhere else.
- "During tasks, please say **'done'** out loud when you think you have finished. Thinking aloud is welcome but not required. I will not be able to help much; if you are stuck, just say so."

## 2. Background questions — 5:00–8:00

Note-taker types the answers into `interview-notes.md` under the participant ID (template in §9).

| # | Question | Record |
|---|---|---|
| B1 | Faculty and year of study? | text |
| B2 | In the last 2 years, how many events with sign-ups have you **organised**? Which tools (Google Forms, Eventbrite, Telegram poll, Luma, other)? | number + tools |
| B3 | How often do you **sign up** for workshops or events via Google Forms? (never / a few times a year / monthly / weekly) | category |
| B4 | How comfortable are you with spreadsheets, 1 (not at all) to 5 (very)? | 1–5 |
| B5 | Have you ever registered for the same event twice "just in case" (two sessions, two forms)? | yes/no + one line |

## 3. Round 1 tasks — 8:00–20:00

Condition = first entry of the `order` column. Dataset = `dataset_1`.

1. **Orientation (max 60 s, identical wording for both tools):**
   - SeatRelay: "This is SeatRelay, a workshop sign-up tool. You are logged in as *Jordan Lee* (participant track) / *Riley Tan*, organiser of *NUS Data Club* (organiser track). The two bookmarks you need are in the folder on the bookmark bar."
   - Control: "This is how the workshop is run today: the organiser posted an announcement with one Google Form per session; the organiser keeps a Google Sheet. You are *Jordan Lee* / *Riley Tan*. Your Gmail inbox is open in the second tab. The bookmarks you need are in the folder on the bookmark bar."
   - Do not demonstrate anything. Do not explain words like "waitlist", "hold", "offer".
2. For each task card, in order (T1–T5 or O1–O4):
   1. Facilitator reads the card aloud, verbatim, including the scenario. Hands the card to the participant (they may re-read it).
   2. **Start the stopwatch the moment the last word of the card is read.**
   3. Observe. Apply the hint ladder (§6) only when triggered.
   4. **Stop the stopwatch at the participant's verbal "done"** (or, for interpretation tasks T3/O3/O4-count, at the moment they state their final answer). If the participant says "done" but then continues, the time is the *last* "done".
   5. At **5:00 stop the task**: "Let's move on to the next one." Record `time_s = 300`, `success = 0`.
   6. Facilitator checks the success criterion on the answer key (and, if needed, on the facilitator laptop), says nothing about the result, and dictates to the note-taker: success, time, errors, help requests, manual steps.
   7. Note-taker writes the row **now**, before the next card.
3. Organiser track, task O2 only: the facilitator performs the "other participant" action on the facilitator laptop exactly as the task card says (`tasks-organiser.md`), then keeps silent.
4. Control condition, participant track only: right after T1 is recorded, the facilitator sends the pre-written "seat held" e-mail from the organiser Gmail to the persona inbox (`control-condition-setup.md` §4). Do this silently; it is part of the control's normal behaviour.

If the round runs past 20:00 because of 5-minute caps, continue; the session may run to ~45 min. Never skip a task to save time; if a task cannot be attempted (e.g. an offer expired before T4), record `success = 0`, `time_s` empty and explain in `notes`.

## 4. SUS for round 1 — 20:00–22:00

- Hand the SUS sheet (`sus.md` §3) with the condition name written on it. "Please rate the tool you just used. Answer quickly; first impressions are fine. If you cannot decide, tick the middle."
- Facilitator and note-taker **do not look** at the answers while the participant writes.
- Meanwhile the facilitator resets the participant laptop to round 2 (other condition, other dataset) — bookmark folder "B".

## 5. Round 2 tasks — 22:00–34:00, then SUS for round 2 — 34:00–36:00

Same as §3–§4 with the other condition and the other dataset. Repeat the orientation sentence for the second tool. Do not say "this is the same task as before".

## 6. Timing, success and counting rules (apply identically in both conditions)

### 6.1 Timing

| Rule | Detail |
|---|---|
| Start | Last word of the task card read aloud. |
| Stop | Participant's verbal "done" / final stated answer. |
| Cap | **300 s**. Task stopped, `time_s = 300`, `success = 0`. |
| Pauses | None. If something outside the study interrupts (fire alarm, system outage), stop the stopwatch, note the deviation in `notes`, and decide with the note-taker whether to discard the task (`time_s` empty, `notes = "interrupted"`). |
| Rounding | Whole seconds. |
| Think-aloud | Talking counts as task time; do not pause for it. |

### 6.2 Success

| `success` | Meaning |
|---|---|
| `1` | Success criterion on the answer key met **within the cap** and **without any level-1 or level-2 hint**. Level-0 prompts ("what would you try?") do not count as hints. |
| `assisted` | Criterion met within the cap, but after at least one level-1 or level-2 hint. |
| `0` | Criterion not met: cap reached, participant gave up ("I don't know how"), or final state/answer wrong even if they said "done". Also `0` when the task could not be attempted — explain in `notes`. |

A task whose final state is wrong is `0` even if the participant was confident. The facilitator verifies the state on the answer key (`tasks-*.md`) before dictating.

### 6.3 Errors (`errors`, integer)

Count one error for each of:

| Type | Example |
|---|---|
| Wrong navigation | Opens a page/tab/form that cannot lead to the goal and has to go back (e.g. opens Monday's form when Monday is not acceptable; opens the organiser dashboard of the wrong workshop). |
| Wrong action | Submits a form for a non-acceptable session; clicks Decline instead of Accept; marks the wrong row; sends the e-mail to the wrong person; downloads the wrong tab. |
| Wrong answer, then corrected | States a wrong queue position / count / name and corrects it before "done". (If not corrected, it is `success = 0`, not an error.) |
| Duplicate submission (control) | Submits a second form for the same workshop when the scenario did not call for it. Record also in `notes` as `duplicate`. |

Not errors: scrolling, hovering, reading, opening a page that *could* lead to the goal, asking a clarifying question about the scenario text.

### 6.4 Help requests (`help_requests`, integer) and the hint ladder

Count **every** time the participant asks for help ("what do I do?", "where is it?", "is this right?"), whether or not a hint is given.

| Level | Trigger | Facilitator says | Effect |
|---|---|---|---|
| 0 | First help request, or 90 s with no progress | "What would you try?" / "Do what you think is right, then say done." | not a hint; `success` unaffected |
| 1 | Second help request, or 150 s with no progress | Points to the *area* without naming the action: "Have a look at the *My registrations* page." / "The answer is on the status board." / "Check the Summary tab." | task becomes `assisted` if later completed |
| 2 | Third help request, or 240 s with no progress | Names the exact action: "Click Accept on the Tuesday card." | task becomes `assisted` if later completed |
| — | 300 s | "Let's move on." | `0` |

"No progress" = no state-changing action and no new page opened. Use the same ladder in both conditions. Never answer "is this right?" with yes/no.

### 6.5 Manual steps (`manual_steps`, organiser tasks only)

One step = one discrete, state-changing or page-opening action the organiser performs: opening a form/tab/page, typing or editing a cell/field, sending or drafting an e-mail, downloading a file, creating/copying a form, linking a sheet. Reading is not a step. `tasks-organiser.md` lists the expected minimal steps per condition; count the actual ones (extra or repeated actions count). Leave empty for participant tasks.

### 6.6 Facilitator do / don't

| Do | Don't |
|---|---|
| Read cards verbatim; same tone, same pace in both conditions | Explain how either tool works before or during tasks |
| Stay neutral: "mm-hm", "take your time" | React to errors (sighs, smiles, "almost!") |
| Use the hint ladder exactly | Give a hint because *you* are impatient |
| Verify the final state before dictating | Tell the participant whether they succeeded |
| Re-read the card if asked | Rephrase the scenario in your own words |
| Note anything unusual for `notes` | Fix the system mid-task (if it breaks: stop, note it, move on) |
| Keep the "other participant" actions (O2) exactly as scripted | Improvise extra cancellations or data |

## 7. Short interview — 36:00–40:00

Note-taker types answers verbatim-ish into `interview-notes.md`. Ask all four; skip follow-ups if out of time.

| # | Question |
|---|---|
| I1 | "Which tool would you rather use for a workshop with several sessions, as a participant / as an organiser? Why?" |
| I2 | "Was there a moment in either tool where you were unsure what had happened or what to do next? What was it?" |
| I3 | "In SeatRelay, was it clear what *held seat* and the countdown meant, and what would happen if you did nothing?" (organiser track: "…was it clear who got the freed seat and why?") |
| I4 | "If this were a real workshop you cared about, would you trust the waitlist order in each tool? Anything you would change?" |

Thank the participant. Remind them they can withdraw by e-mail quoting their ID (not their name).

## 8. Immediately after the session (10 min)

| Step | Who |
|---|---|
| Transcribe both SUS sheets into `sus-sheet.csv` (one row per condition; `sus_score` may be left empty — `analysis.py` computes it and warns on mismatch) | note-taker |
| Re-read the day's `session-sheet.csv` rows for typos; every row has `success`, `time_s` (or empty + explanation), `errors`, `help_requests` | note-taker |
| Complete the `interview-notes.md` block | note-taker |
| Reset SeatRelay and the control for the next participant (`control-condition-setup.md` §6); delete the participant's rows/e-mails/drafts/forms | facilitator |
| Note any deviation in `results/user-study/study-log.md` | facilitator |
| Shred or lock away paper with names; the signed consent forms go in the team folder | facilitator |

## 9. `interview-notes.md` block template

```markdown
## P07 — 2026-11-03 — track: participant — order: CTRL_first — datasets: B then A
### Background
B1: … | B2: … | B3: … | B4: … | B5: …
### Observations during tasks (facilitator)
- SR T3: read the countdown correctly but asked whether "held" meant confirmed.
- CTRL T2: submitted all three forms "to be safe".
### Interview
I1: … I2: … I3: … I4: …
```

## 10. Deviations that must be logged

- A reset that was incomplete when the participant started (data visible from the previous participant) → log, and consider discarding the affected task.
- SeatRelay outage or a bug that blocks a task → `success = 0`, `notes = "system error: …"`, log the commit/stack; such tasks are reported separately, not silently removed.
- The hold countdown expired before T4 → `notes = "offer expired before T4"`, T4 `success = 0`, `time_s` empty.
- Participant turned out to be a team member's close collaborator or had seen SeatRelay before → finish the session, log it, and decide as a team whether to exclude (decision logged).
