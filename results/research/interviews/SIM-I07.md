# SIM-I07 interview record

> Data source: an authored interview scenario. See Section 2 of the research report for the generation method.

- Profile: Events lead of a student technology club whose team shares a spreadsheet
- Role: organiser
- Consent: not applicable to generated scenarios

## A. Background and concrete episode
Three training sessions share a pool of registrants. Two committee members handle cancellations separately and contact the same waitlisted person twice.

## B. Current workflow
Creates three forms, merges email addresses, flags duplicates, checks queue order, contacts people individually and updates all three sheets after acceptance.

## C. Needs and trade-offs
All committee members need the same current state; the backfill log should identify the release, the new hold and whether it was accepted.

## D. Counterexamples and limitations
A monthly fee is unattractive in quiet months; export and permission controls are prerequisites for adoption.

## E. Quantitative assumptions

Annual events: 12; multi-session events: 6; baseline coordination: 4.0 hours/event. Participant and organiser effort refer to their respective protocol roles.
Assumed too-cheap / bargain / expensive / too-expensive prices: [2, 8, 15, 25] SGD; unit: per organisation per month. These are not purchasing commitments.

## F. Scripted statements
- `SIM-I07-Q1` (scripted statement, not a transcript): The difficult part is two people editing the sheet at once without knowing who has contacted whom.
- `SIM-I07-Q2` (scripted statement, not a transcript): Ten dollars may work when we run events every month, but I do not want to keep paying during the break.

## G. Coding and design implications
DUPLICATE; RELAY; GOVERNANCE; TRUST

The coding unit is the full profile script; theme co-occurrence is retained. This record does not establish population prevalence, thematic saturation or causal effects.
