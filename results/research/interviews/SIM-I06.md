# SIM-I06 interview record

> Data source: an authored interview scenario. See Section 2 of the research report for the generation method.

- Profile: Second-year exchange student who relies on email rather than local group chats
- Role: participant
- Consent: not applicable to generated scenarios

## A. Background and concrete episode
Misses a backfill message sent only to an infrequently checked group and must find a group administrator to cancel.

## B. Current workflow
Bookmarks the event link, checks email and contacts the organiser when the current state is unclear.

## C. Needs and trade-offs
Email links should return to the current state; cancellation should show a clear ending and remove obsolete confirmation controls.

## D. Counterexamples and limitations
Does not want to join a chat group; one notification channel cannot suit everyone.

## E. Quantitative assumptions

Annual events: 9; multi-session events: 3; baseline coordination: 0.3 hours/event. Participant and organiser effort refer to their respective protocol roles.
Assumed too-cheap / bargain / expensive / too-expensive prices: [0, 0, 2, 4] SGD; unit: per event. These are not purchasing commitments.

## F. Scripted statements
- `SIM-I06-Q1` (scripted statement, not a transcript): The email should take me straight back to my current status.
- `SIM-I06-Q2` (scripted statement, not a transcript): If I still see the old seat after cancelling, I worry the cancellation did not work.

## G. Coding and design implications
STATE; RELAY; HOLD

The coding unit is the full profile script; theme co-occurrence is retained. This record does not establish population prevalence, thematic saturation or causal effects.
