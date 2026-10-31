"""Study design, scenario generation, validation and paired descriptive analysis."""
from __future__ import annotations

import csv
import math
import random
import statistics as stats
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).with_name("scenarios.json")
BALANCE = ROOT / "docs/user-study/counterbalance.csv"
ORIGIN = "SIMULATED"
TASKS = {
    "participant": ("T1", "T2", "T3", "T4", "T5"),
    "organiser": ("O1", "O2", "O3", "O4"),
}


def pct(part, whole):
    return round(100 * part / whole, 2) if whole else None


def sus_score(items):
    if len(items) != 10 or any(type(q) is not int or not 1 <= q <= 5 for q in items):
        raise ValueError("SUS needs ten integer items in 1..5")
    return 2.5 * sum(q - 1 if i % 2 == 0 else 5 - q for i, q in enumerate(items))


def design_rows(source):
    profiles = {p["id"]: p for p in source["study_profiles"]}
    with BALANCE.open(newline="", encoding="utf-8") as f:
        balance = list(csv.DictReader(f))
    expected = {"SIM-" + row["participant_id"] for row in balance}
    if len(profiles) != len(source["study_profiles"]) or set(profiles) != expected:
        raise ValueError("Study profile IDs must match the counterbalance sheet exactly")
    return [
        {
            "source_type": ORIGIN,
            "participant_id": "SIM-" + row["participant_id"],
            "track": row["track"],
            "order": row["order"],
            "condition_1": row["condition_1"],
            "dataset_1": row["dataset_1"],
            "condition_2": row["condition_2"],
            "dataset_2": row["dataset_2"],
            "digital_familiarity": profiles["SIM-" + row["participant_id"]]["digital_familiarity"],
            "preferred_condition": profiles["SIM-" + row["participant_id"]]["preferred"],
            "scripted_concern": profiles["SIM-" + row["participant_id"]]["concern"],
            "consent": "not_applicable_simulated",
        }
        for row in balance
    ]


def validate_source(source):
    if source["source_type"] != ORIGIN:
        raise ValueError("Research scenarios must be explicitly simulated")
    design = design_rows(source)
    if len(design) != 12 or Counter(p["track"] for p in design) != {
        "participant": 8,
        "organiser": 4,
    }:
        raise ValueError("Expected eight participant and four organiser assignments")
    for track in TASKS:
        group = [p for p in design if p["track"] == track]
        if Counter(p["order"] for p in group) != {
            "SR_first": len(group) // 2,
            "CTRL_first": len(group) // 2,
        }:
            raise ValueError("Condition order must be balanced within each track")
    for person in design:
        if {person["condition_1"], person["condition_2"]} != {"SR", "CTRL"} or {
            person["dataset_1"],
            person["dataset_2"],
        } != {"A", "B"}:
            raise ValueError("Each participant needs both tools and different A/B datasets")
        if (person["condition_1"] == "SR") != (person["order"] == "SR_first"):
            raise ValueError("Condition order disagrees with its label")
    for track in TASKS:
        for condition in ("SR", "CTRL"):
            datasets = Counter(
                p[f"dataset_{period}"]
                for p in design
                if p["track"] == track
                for period in (1, 2)
                if p[f"condition_{period}"] == condition
            )
            if datasets["A"] != datasets["B"]:
                raise ValueError("A/B datasets must be balanced within track and condition")
    assumptions = source["assumptions"]
    positive = (
        "time_cap_seconds",
        "second_condition_time_factor",
        "dataset_b_time_factor",
        "minimum_time_seconds",
        "assisted_min_seconds",
        "assisted_time_factor",
        "wrong_answer_min_seconds",
        "wrong_answer_time_factor",
        "sus_item_sd",
    )
    for key in positive:
        value = assumptions[key]
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{key} must be a finite positive number")
    if assumptions["time_cap_seconds"] != 300:
        raise ValueError("The original task protocol requires a 300-second cap")
    for key in (
        "person_log_sd",
        "attempt_log_sd",
        "incidental_error_probability",
        "failure_help_probability",
        "adoption_share",
    ):
        value = assumptions[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"Invalid probability or variation: {key}")
    by_id = {p["participant_id"]: p for p in design}
    exception_keys = set()
    for event in source["study_exceptions"]:
        key = event["id"], event["condition"], event["task"]
        person = by_id.get(event["id"])
        if (
            key in exception_keys
            or person is None
            or event["condition"] not in {"SR", "CTRL"}
            or event["task"] not in TASKS[person["track"]]
        ):
            raise ValueError(f"Duplicate or unknown scenario exception: {key}")
        exception_keys.add(key)
        if event["success"] not in {"assisted", "0"}:
            raise ValueError(f"Invalid authored outcome: {key}")
        if (event.get("failure_kind") in {"timeout", "incorrect_answer"}) != (
            event["success"] == "0"
        ):
            raise ValueError(f"A failed task needs an explicit failure kind: {key}")
    interviews = source["interviews"]
    codes = {code["id"] for code in source["codebook"]}
    if len(codes) != len(source["codebook"]) or len({p["id"] for p in interviews}) != len(
        interviews
    ):
        raise ValueError("Interview and codebook IDs must be unique")
    if Counter(p["role"] for p in interviews) != {"participant": 6, "organiser": 3}:
        raise ValueError("Expected six student and three organiser interview scenarios")
    for person in interviews:
        if (
            not set(person["codes"]) <= codes
            or not 0 <= person["multi_session_events"] <= person["events_per_year"]
            or person["events_per_year"] <= 0
        ):
            raise ValueError(f"Invalid codes or annual event counts: {person['id']}")
    return design


def generate_study(source, seed, sr_time_factor=1.0):
    design = validate_source(source)
    if not math.isfinite(sr_time_factor) or sr_time_factor <= 0:
        raise ValueError("The sensitivity time factor must be finite and positive")
    rng = random.Random(seed)
    assumptions = source["assumptions"]
    profiles = {p["id"]: p for p in source["study_profiles"]}
    exceptions = {(r["id"], r["condition"], r["task"]): r for r in source["study_exceptions"]}
    sessions, sus = [], []
    for person in design:
        pid = person["participant_id"]
        profile = profiles[pid]
        skill = rng.lognormvariate(0, assumptions["person_log_sd"])
        tasks = TASKS[person["track"]]
        for period in (1, 2):
            condition, dataset = person[f"condition_{period}"], person[f"dataset_{period}"]
            for task in tasks:
                event = exceptions.get((pid, condition, task))
                success = event["success"] if event else "1"
                seconds = assumptions["task_time_seconds"][task][condition] * skill
                seconds *= rng.lognormvariate(0, assumptions["attempt_log_sd"])
                seconds *= assumptions["second_condition_time_factor"] if period == 2 else 1
                seconds *= assumptions["dataset_b_time_factor"] if dataset == "B" else 1
                if condition == "SR":
                    seconds *= sr_time_factor
                if success == "assisted":
                    seconds = max(
                        assumptions["assisted_min_seconds"],
                        seconds * assumptions["assisted_time_factor"],
                    )
                failure_kind = event.get("failure_kind", "") if event else ""
                if success == "0":
                    seconds = (
                        assumptions["time_cap_seconds"]
                        if failure_kind == "timeout"
                        else max(
                            assumptions["wrong_answer_min_seconds"],
                            seconds * assumptions["wrong_answer_time_factor"],
                        )
                    )
                seconds = min(
                    assumptions["time_cap_seconds"],
                    max(assumptions["minimum_time_seconds"], round(seconds)),
                )
                if seconds == assumptions["time_cap_seconds"]:
                    success = "0"
                    failure_kind = "timeout"
                errors = (
                    rng.randint(1, 2)
                    if event
                    else int(rng.random() < assumptions["incidental_error_probability"])
                )
                help_draw = int(rng.random() < assumptions["failure_help_probability"])
                help_requests = 2 if success == "assisted" else help_draw if success == "0" else 0
                steps = ""
                if task.startswith("O"):
                    steps = (
                        assumptions["organiser_steps"][task][condition]
                        + errors
                        + int(bool(help_requests))
                    )
                sessions.append(
                    {
                        "source_type": ORIGIN,
                        "participant_id": pid,
                        "scenario_date": source["scenario_date"],
                        "track": person["track"],
                        "order": person["order"],
                        "period": period,
                        "condition": condition,
                        "dataset": dataset,
                        "task_id": task,
                        "success": success,
                        "failure_kind": failure_kind,
                        "time_s": seconds,
                        "errors": errors,
                        "help_requests": help_requests,
                        "manual_steps": steps,
                        "notes": event["note"]
                        if event
                        else "Generated from the declared task-time model; no human observation",
                    }
                )
            # Generate ten item responses, then calculate the score; never generate a score directly.
            latent = profile["sus_sr" if condition == "SR" else "sus_ctrl"]
            items = []
            for index in range(10):
                positive = max(1, min(5, round(latent + rng.gauss(0, assumptions["sus_item_sd"]))))
                items.append(positive if index % 2 == 0 else 6 - positive)
            sus.append(
                {
                    "source_type": ORIGIN,
                    "participant_id": pid,
                    "condition": condition,
                    **{f"q{i + 1}": value for i, value in enumerate(items)},
                    "sus_score": sus_score(items),
                }
            )
    return sessions, sus


def analyse(source, sessions, sus):
    design = design_rows(source)
    paired = []
    for person in design:
        totals = {
            c: sum(
                r["time_s"]
                for r in sessions
                if r["participant_id"] == person["participant_id"] and r["condition"] == c
            )
            for c in ("SR", "CTRL")
        }
        paired.append(
            {
                "source_type": ORIGIN,
                "participant_id": person["participant_id"],
                "track": person["track"],
                "order": person["order"],
                "sr_total_s": totals["SR"],
                "ctrl_total_s": totals["CTRL"],
                "reduction_pct": round(100 * (1 - totals["SR"] / totals["CTRL"]), 4),
            }
        )

    conditions = {}
    for condition in ("SR", "CTRL"):
        rows = [r for r in sessions if r["condition"] == condition]
        scores = [r["sus_score"] for r in sus if r["condition"] == condition]
        outcomes = Counter(r["success"] for r in rows)
        organiser_totals = [
            sum(r["manual_steps"] for r in rows if r["participant_id"] == p["participant_id"])
            for p in design
            if p["track"] == "organiser"
        ]
        conditions[condition] = {
            "attempts": len(rows),
            "unassisted": outcomes["1"],
            "assisted": outcomes["assisted"],
            "failed": outcomes["0"],
            "completion_pct": pct(outcomes["1"], len(rows)),
            "completion_with_help_pct": pct(outcomes["1"] + outcomes["assisted"], len(rows)),
            "median_subject_total_s": stats.median(
                p[f"{condition.lower()}_total_s"] for p in paired
            ),
            "sus_mean": round(stats.mean(scores), 2),
            "sus_median": stats.median(scores),
            "sus_min": min(scores),
            "sus_max": max(scores),
            "errors": sum(r["errors"] for r in rows),
            "help_requests": sum(r["help_requests"] for r in rows),
            "median_organiser_steps": stats.median(organiser_totals),
            "by_track": {
                track: {
                    "n": sum(r["track"] == track for r in rows),
                    "unassisted": sum(r["track"] == track and r["success"] == "1" for r in rows),
                    "completion_pct": pct(
                        sum(r["track"] == track and r["success"] == "1" for r in rows),
                        sum(r["track"] == track for r in rows),
                    ),
                }
                for track in ("participant", "organiser")
            },
        }
    organisers = [r for r in source["interviews"] if r["role"] == "organiser"]
    codes = [
        {
            "source_type": ORIGIN,
            "code": code["id"],
            "theme": code["name"],
            "scripted_profiles": sum(code["id"] in r["codes"] for r in source["interviews"]),
            "profile_ids": ";".join(
                r["id"] for r in source["interviews"] if code["id"] in r["codes"]
            ),
        }
        for code in source["codebook"]
    ]
    summary = {
        "source_type": ORIGIN,
        "interview_profiles": len(source["interviews"]),
        "student_interview_profiles": len(source["interviews"]) - len(organisers),
        "organiser_interview_profiles": len(organisers),
        "study_profiles": len(design),
        "participant_track": sum(p["track"] == "participant" for p in design),
        "organiser_track": sum(p["track"] == "organiser" for p in design),
        "task_attempts": len(sessions),
        "sus_forms": len(sus),
        "conditions": conditions,
        "paired_subject_median_reduction_pct": round(
            stats.median(p["reduction_pct"] for p in paired), 2
        ),
        "sr_faster_profiles": sum(p["sr_total_s"] < p["ctrl_total_s"] for p in paired),
        "scripted_preference": dict(Counter(p["preferred_condition"] for p in design)),
        "interview_scenario": {
            "event_weighted_multi_session_pct": pct(
                sum(o["multi_session_events"] for o in organisers),
                sum(o["events_per_year"] for o in organisers),
            ),
            "baseline_coordination_hours_median": stats.median(
                o["coordination_hours"] for o in organisers
            ),
            "bargain_sgd_month_median": stats.median(o["wtp_sgd"][1] for o in organisers),
            "expensive_sgd_month_median": stats.median(o["wtp_sgd"][2] for o in organisers),
            "open_procurement_pct": pct(
                sum(o["open_procurement"] for o in organisers), len(organisers)
            ),
            "adoption_share_assumed": source["assumptions"]["adoption_share"],
        },
        "inference": "Descriptive outputs conditional on authored assumptions; no empirical hypothesis test, population confidence interval or market validation.",
    }
    return summary, paired, codes


def validate(source, sessions, sus):
    design = validate_source(source)
    expected = {}
    for person in design:
        for period in (1, 2):
            for task in TASKS[person["track"]]:
                expected[person["participant_id"], person[f"condition_{period}"], task] = {
                    "track": person["track"],
                    "order": person["order"],
                    "period": period,
                    "dataset": person[f"dataset_{period}"],
                    "scenario_date": source["scenario_date"],
                }
    keys = [(r["participant_id"], r["condition"], r["task_id"]) for r in sessions]
    if len(keys) != len(set(keys)) or set(keys) != set(expected):
        raise ValueError(
            "Task observations must match every assigned participant/tool/task exactly"
        )
    cap = source["assumptions"]["time_cap_seconds"]
    for row in sessions:
        assignment = expected[row["participant_id"], row["condition"], row["task_id"]]
        if row["source_type"] != ORIGIN or any(row[k] != v for k, v in assignment.items()):
            raise ValueError("Task provenance and assignment metadata must match the design")
        if row["success"] not in {"1", "assisted", "0"}:
            raise ValueError("Unknown task outcome")
        if type(row["time_s"]) is not int or not 0 < row["time_s"] <= cap:
            raise ValueError("Invalid task cap handling")
        if row["failure_kind"] not in (
            {"timeout"}
            if row["time_s"] == cap
            else {"incorrect_answer"}
            if row["success"] == "0"
            else {""}
        ):
            raise ValueError("Failure kind must distinguish timeouts and incorrect answers")
        if row["time_s"] == cap and row["success"] != "0":
            raise ValueError("A capped task must be recorded as failed")
        if any(type(row[k]) is not int or row[k] < 0 for k in ("errors", "help_requests")):
            raise ValueError("Error and help counts must be nonnegative integers")
        if row["track"] == "organiser":
            if type(row["manual_steps"]) is not int or row["manual_steps"] < 0:
                raise ValueError("Organiser tasks need nonnegative integer action counts")
        elif row["manual_steps"] != "":
            raise ValueError("Participant tasks do not have organiser action counts")
        if row["success"] == "assisted" and row["help_requests"] < 1:
            raise ValueError("Assisted completion must have a help request")
        if row["success"] == "1" and row["help_requests"] != 0:
            raise ValueError("Unassisted completion cannot include task help")
    expected_sus = {(p["participant_id"], c) for p in design for c in ("SR", "CTRL")}
    if (
        len(sus) != len(expected_sus)
        or {(r["participant_id"], r["condition"]) for r in sus} != expected_sus
    ):
        raise ValueError("Expected one SUS form per profile and condition")
    for row in sus:
        if row["source_type"] != ORIGIN or row["sus_score"] != sus_score(
            [row[f"q{i}"] for i in range(1, 11)]
        ):
            raise ValueError("SUS does not reconcile to its ten item responses")
