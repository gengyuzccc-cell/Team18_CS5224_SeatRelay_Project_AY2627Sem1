#!/usr/bin/env python3
"""SeatRelay user-evaluation analysis (plan docs/plan/execution-plan.md section 5).

Reads the two study CSVs, drops EXAMPLE rows, and writes results/user-study/summary.md plus
three PNG charts. Small or missing data never raise: the script prints WARNING lines and
writes "n/a" in the tables. Dependencies: pandas, scipy, matplotlib only.

Usage:
    python3 docs/user-study/analysis.py                       # defaults below
    python3 docs/user-study/analysis.py SESSION.csv SUS.csv --out results/user-study
    python3 docs/user-study/analysis.py --keep-examples       # smoke test on the template rows
"""

from __future__ import annotations

import argparse
import math
import sys
import warnings
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy import stats  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SESSION = REPO_ROOT / "docs" / "user-study" / "session-sheet.csv"
DEFAULT_SUS = REPO_ROOT / "docs" / "user-study" / "sus-sheet.csv"
DEFAULT_OUT = REPO_ROOT / "results" / "user-study"

CONDITIONS = ["SR", "CTRL"]
CONDITION_LABEL = {"SR": "SeatRelay", "CTRL": "Forms + Sheet"}
TASK_ORDER = ["T1", "T2", "T3", "T4", "T5", "O1", "O2", "O3", "O4"]
TASK_LABEL = {
    "T1": "T1 choose sessions",
    "T2": "T2 join waitlist",
    "T3": "T3 read status",
    "T4": "T4 confirm seat",
    "T5": "T5 cancel",
    "O1": "O1 create workshop",
    "O2": "O2 cancellation + backfill",
    "O3": "O3 read queue",
    "O4": "O4 distinct + export",
}
TRACK_OF_TASK = {t: ("participant" if t.startswith("T") else "organiser") for t in TASK_ORDER}
SUCCESS_VALUES = {"1", "0", "assisted"}
TIME_CAP_S = 300.0

TARGET_COMPLETION = 0.90
TARGET_IMPROVEMENT_PCT = 25.0
TARGET_SUS = 75.0
SUS_PUBLISHED_MEAN = 68.0

# Chart palette: categorical slot 1 (blue) for SeatRelay, slot 2 (orange) for the control;
# text and grid in neutral ink. Values are the light-mode steps of the reference palette.
COLOR = {"SR": "#2a78d6", "CTRL": "#eb6834"}
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
GRID = "#e3e2de"
SURFACE = "#fcfcfb"

SESSION_COLUMNS = [
    "participant_id", "date", "order", "role_experience", "condition", "dataset", "task_id",
    "success", "time_s", "errors", "help_requests", "manual_steps", "notes",
]
SUS_COLUMNS = ["participant_id", "condition"] + [f"q{i}" for i in range(1, 11)] + ["sus_score"]

WARNINGS: list[str] = []


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    print(f"WARNING: {msg}", file=sys.stderr)


# ----------------------------------------------------------------------------- formatting

def fmt(x, nd: int = 1, suffix: str = "") -> str:
    if x is None:
        return "n/a"
    try:
        if isinstance(x, str):
            return x
        if x != x or (isinstance(x, float) and math.isinf(x)):
            return "n/a"
    except TypeError:
        return "n/a"
    if nd == 0:
        return f"{int(round(x))}{suffix}"
    return f"{x:.{nd}f}{suffix}"


def fmt_p(p) -> str:
    if p is None or p != p:
        return "n/a"
    if p < 0.001:
        return "< 0.001"
    return f"{p:.3f}"


def p_label(p) -> str:
    """'p = 0.008', 'p < 0.001' or 'p = n/a'."""
    if p is None or p != p:
        return "p = n/a"
    return "p < 0.001" if p < 0.001 else f"p = {p:.3f}"


def md_table(header: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out) + "\n"


def order_tasks(tasks) -> list[str]:
    known = [t for t in TASK_ORDER if t in set(tasks)]
    extra = sorted(t for t in set(tasks) if t not in TASK_ORDER)
    if extra:
        warn(f"unknown task ids kept at the end of the tables: {extra}")
    return known + extra


# ----------------------------------------------------------------------------- loading

def read_csv(path: Path, required: list[str], name: str) -> pd.DataFrame:
    if not path.exists():
        warn(f"{name}: file not found: {path}")
        return pd.DataFrame(columns=required)
    try:
        df = pd.read_csv(path, dtype=str, keep_default_na=False, skip_blank_lines=True)
    except Exception as exc:  # malformed CSV must not crash the run
        warn(f"{name}: could not parse {path}: {exc}")
        return pd.DataFrame(columns=required)
    df.columns = [str(c).strip().lower() for c in df.columns]
    df = df.apply(lambda col: col.str.strip())
    for col in required:
        if col not in df.columns:
            warn(f"{name}: column '{col}' missing; treated as empty")
            df[col] = ""
    return df


def drop_examples(df: pd.DataFrame, name: str, keep: bool) -> pd.DataFrame:
    if df.empty:
        return df
    mask = df["participant_id"].str.upper().str.contains("EXAMPLE", na=False)
    if "notes" in df.columns:
        mask = mask | df["notes"].str.upper().str.contains("EXAMPLE", na=False)
    n = int(mask.sum())
    if keep:
        if n:
            warn(f"{name}: --keep-examples set, {n} EXAMPLE row(s) kept (smoke test only)")
        return df
    if n:
        print(f"{name}: dropped {n} EXAMPLE row(s)")
    return df.loc[~mask].reset_index(drop=True)


def to_num(series: pd.Series, name: str, col: str) -> pd.Series:
    out = pd.to_numeric(series.replace("", np.nan), errors="coerce")
    bad = series[(series != "") & out.isna()]
    if len(bad):
        warn(f"{name}: {len(bad)} non-numeric value(s) in '{col}' ignored: {sorted(set(bad))[:5]}")
    return out


def clean_session(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    df = df.copy()
    df["participant_id"] = df["participant_id"].str.upper()
    df["condition"] = df["condition"].str.upper()
    df["task_id"] = df["task_id"].str.upper()
    df["success"] = df["success"].str.lower()

    bad_cond = df[~df["condition"].isin(CONDITIONS)]
    if len(bad_cond):
        warn(f"session: {len(bad_cond)} row(s) with condition not in {CONDITIONS} dropped: "
             f"{sorted(set(bad_cond['condition']))}")
        df = df[df["condition"].isin(CONDITIONS)]

    bad_succ = df[(df["success"] != "") & ~df["success"].isin(SUCCESS_VALUES)]
    if len(bad_succ):
        warn(f"session: {len(bad_succ)} row(s) with success not in {sorted(SUCCESS_VALUES)} "
             f"treated as missing: {sorted(set(bad_succ['success']))}")
        df.loc[bad_succ.index, "success"] = ""

    for col in ["time_s", "errors", "help_requests", "manual_steps"]:
        df[col] = to_num(df[col], "session", col)

    over = df[df["time_s"] > TIME_CAP_S]
    if len(over):
        warn(f"session: {len(over)} time_s value(s) above the {TIME_CAP_S:.0f} s cap "
             f"(protocol says failed tasks are recorded as 300); kept as typed")

    dup = df.duplicated(subset=["participant_id", "condition", "task_id"], keep="first")
    if dup.any():
        warn(f"session: {int(dup.sum())} duplicate (participant, condition, task) row(s) "
             f"ignored (first kept)")
        df = df[~dup]

    empty_pid = df["participant_id"] == ""
    if empty_pid.any():
        warn(f"session: {int(empty_pid.sum())} row(s) without participant_id dropped")
        df = df[~empty_pid]
    return df.reset_index(drop=True)


def clean_sus(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    df = df.copy()
    df["participant_id"] = df["participant_id"].str.upper()
    df["condition"] = df["condition"].str.upper()
    bad_cond = df[~df["condition"].isin(CONDITIONS)]
    if len(bad_cond):
        warn(f"sus: {len(bad_cond)} row(s) with condition not in {CONDITIONS} dropped")
        df = df[df["condition"].isin(CONDITIONS)]
    qcols = [f"q{i}" for i in range(1, 11)]
    for q in qcols:
        df[q] = to_num(df[q], "sus", q)
    df["sus_score"] = to_num(df["sus_score"], "sus", "sus_score")

    valid = df[qcols].notna().all(axis=1) & df[qcols].isin([1, 2, 3, 4, 5]).all(axis=1)
    if (~valid).any():
        warn(f"sus: {int((~valid).sum())} row(s) with a missing or out-of-range item (1-5) "
             f"dropped (no imputation): {list(df.loc[~valid, 'participant_id'])}")
        df = df[valid]
    if df.empty:
        return df.reset_index(drop=True)

    odd = df[[f"q{i}" for i in (1, 3, 5, 7, 9)]].sub(1).sum(axis=1)
    even = (5 - df[[f"q{i}" for i in (2, 4, 6, 8, 10)]]).sum(axis=1)
    computed = (odd + even) * 2.5
    mismatch = df["sus_score"].notna() & (np.abs(df["sus_score"] - computed) > 0.01)
    if mismatch.any():
        warn("sus: transcribed sus_score differs from the value computed from q1..q10 for "
             f"{list(df.loc[mismatch, 'participant_id'] + '/' + df.loc[mismatch, 'condition'])}; "
             "the computed value is used")
    df["sus_score"] = computed

    dup = df.duplicated(subset=["participant_id", "condition"], keep="first")
    if dup.any():
        warn(f"sus: {int(dup.sum())} duplicate (participant, condition) row(s) ignored")
        df = df[~dup]
    return df.reset_index(drop=True)


# ----------------------------------------------------------------------------- statistics

def wilcoxon_paired(ctrl: np.ndarray, sr: np.ndarray) -> dict:
    """Two-sided Wilcoxon signed-rank test on CTRL - SR. Never raises."""
    res = {"n": int(len(ctrl)), "n_nonzero": 0, "W": np.nan, "p": np.nan, "min_p": np.nan, "note": ""}
    if len(ctrl) == 0:
        res["note"] = "no pairs"
        return res
    diff = np.asarray(ctrl, dtype=float) - np.asarray(sr, dtype=float)
    nz = int(np.count_nonzero(diff))
    res["n_nonzero"] = nz
    if nz == 0:
        res["note"] = "all differences zero"
        return res
    res["min_p"] = 2.0 ** (1 - nz)
    if len(diff) < 2:
        res["note"] = "n < 2, test not run"
        return res
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            w = stats.wilcoxon(ctrl, sr, zero_method="wilcox", alternative="two-sided")
        res["W"] = float(w.statistic)
        res["p"] = float(w.pvalue)
        if caught:
            res["note"] = "; ".join(sorted({str(c.message).split(".")[0] for c in caught}))
    except Exception as exc:
        res["note"] = f"test failed: {exc}"
    if nz < 6:
        res["note"] = (res["note"] + "; " if res["note"] else "") + \
            f"n={nz} non-zero pairs: minimum attainable p = {res['min_p']:.3f}"
    return res


def mean_ci(values: np.ndarray) -> dict:
    v = np.asarray(values, dtype=float)
    v = v[~np.isnan(v)]
    n = len(v)
    out = {"n": n, "mean": np.nan, "sd": np.nan, "lo": np.nan, "hi": np.nan,
           "median": np.nan, "min": np.nan, "max": np.nan}
    if n == 0:
        return out
    out.update(mean=float(v.mean()), median=float(np.median(v)), min=float(v.min()), max=float(v.max()))
    if n >= 2:
        sd = float(v.std(ddof=1))
        half = stats.t.ppf(0.975, n - 1) * sd / math.sqrt(n)
        out.update(sd=sd, lo=out["mean"] - half, hi=out["mean"] + half)
    return out


def paired_wide(df: pd.DataFrame, task: str, value: str) -> pd.DataFrame:
    sub = df[df["task_id"] == task]
    if sub.empty:
        return pd.DataFrame(columns=CONDITIONS)
    wide = sub.pivot_table(index="participant_id", columns="condition", values=value, aggfunc="first")
    for c in CONDITIONS:
        if c not in wide.columns:
            wide[c] = np.nan
    return wide[CONDITIONS]


# ----------------------------------------------------------------------------- sections

def section_data(session: pd.DataFrame, sus: pd.DataFrame, paths: dict) -> str:
    lines = ["## 1. Data\n"]
    lines.append(f"- Session sheet: `{paths['session']}` — {len(session)} task rows after cleaning")
    lines.append(f"- SUS sheet: `{paths['sus']}` — {len(sus)} questionnaire rows after cleaning")
    if session.empty:
        lines.append("- **No task data.** Everything below is n/a.\n")
        return "\n".join(lines) + "\n"
    pids = sorted(session["participant_id"].unique())
    lines.append(f"- Participants with task rows: **{len(pids)}** ({', '.join(pids)})")
    rows = []
    for track in ["participant", "organiser"]:
        tasks = [t for t in TASK_ORDER if TRACK_OF_TASK[t] == track]
        sub = session[session["task_id"].isin(tasks)]
        n_p = sub["participant_id"].nunique()
        n_sr = sub[sub["condition"] == "SR"]["participant_id"].nunique()
        n_ctrl = sub[sub["condition"] == "CTRL"]["participant_id"].nunique()
        both = len(set(sub[sub["condition"] == "SR"]["participant_id"]) &
                   set(sub[sub["condition"] == "CTRL"]["participant_id"]))
        rows.append([track, str(n_p), str(n_sr), str(n_ctrl), str(both)])
    lines.append("")
    lines.append(md_table(["Track", "Participants", "with SR rows", "with CTRL rows", "with both"], rows))
    if "order" in session.columns:
        oc = session.drop_duplicates("participant_id")["order"].str.upper().value_counts()
        lines.append("Order balance (participants): " + ", ".join(f"{k or 'blank'}: {v}" for k, v in oc.items()) + "\n")
    if "dataset" in session.columns:
        dc = session.groupby(["condition", "dataset"])["participant_id"].nunique()
        if len(dc):
            lines.append("Dataset by condition (participants): " +
                         ", ".join(f"{c}/{d or 'blank'}: {n}" for (c, d), n in dc.items()) + "\n")
    missing_time = session[session["time_s"].isna()]
    if len(missing_time):
        lines.append(f"- {len(missing_time)} row(s) without `time_s` (excluded from time analysis): "
                     + ", ".join(missing_time["participant_id"] + "/" + missing_time["condition"] + "/" + missing_time["task_id"]) + "\n")
    return "\n".join(lines) + "\n"


def completion_stats(sub: pd.DataFrame) -> dict:
    s = sub[sub["success"] != ""]
    n = len(s)
    ok = int((s["success"] == "1").sum())
    assisted = int((s["success"] == "assisted").sum())
    failed = int((s["success"] == "0").sum())
    return {"n": n, "ok": ok, "assisted": assisted, "failed": failed,
            "rate": ok / n if n else np.nan, "rate_incl": (ok + assisted) / n if n else np.nan}


def section_completion(session: pd.DataFrame) -> tuple[str, dict]:
    lines = ["## 2. Task completion\n",
             "Primary measure = completed **without** a level-1/2 hint; the second rate also counts "
             f"`assisted`. Target (plan section 5): SeatRelay key-task completion >= {TARGET_COMPLETION:.0%}.\n"]
    table: dict = {}
    if session.empty:
        lines.append("n/a — no data.\n")
        return "\n".join(lines) + "\n", table
    rows = []
    for task in order_tasks(session["task_id"].unique()):
        for cond in CONDITIONS:
            st = completion_stats(session[(session["task_id"] == task) & (session["condition"] == cond)])
            table[(task, cond)] = st
            rows.append([TASK_LABEL.get(task, task), CONDITION_LABEL[cond], str(st["n"]), str(st["ok"]),
                         str(st["assisted"]), str(st["failed"]), fmt(st["rate"] * 100 if st["n"] else np.nan, 0, " %"),
                         fmt(st["rate_incl"] * 100 if st["n"] else np.nan, 0, " %")])
    lines.append(md_table(["Task", "Condition", "n", "completed", "assisted", "failed",
                           "completion", "incl. assisted"], rows))
    rows = []
    for label, tasks in [("participant tasks T1–T5", [t for t in TASK_ORDER if t.startswith("T")]),
                         ("organiser tasks O1–O4", [t for t in TASK_ORDER if t.startswith("O")]),
                         ("all tasks", TASK_ORDER)]:
        for cond in CONDITIONS:
            st = completion_stats(session[session["task_id"].isin(tasks) & (session["condition"] == cond)])
            table[(label, cond)] = st
            flag = ""
            if cond == "SR" and st["n"]:
                flag = "meets target" if st["rate"] >= TARGET_COMPLETION else "below target"
            rows.append([label, CONDITION_LABEL[cond], str(st["n"]), fmt(st["rate"] * 100 if st["n"] else np.nan, 0, " %"),
                         fmt(st["rate_incl"] * 100 if st["n"] else np.nan, 0, " %"), flag])
    lines.append(md_table(["Scope", "Condition", "n task attempts", "completion", "incl. assisted", "vs target"], rows))
    for cond in CONDITIONS:
        st = table[("all tasks", cond)]
        if st["n"] and st["n"] < 20:
            warn(f"completion: only {st['n']} task attempts for {cond}; one failure moves the rate by "
                 f"{100 / st['n']:.0f} points")
    return "\n".join(lines) + "\n", table


def section_time(session: pd.DataFrame) -> tuple[str, dict]:
    lines = ["## 3. Task time (paired, within participant)\n",
             "Times in seconds; failed tasks carry the 300 s cap (protocol section 6.1), so the primary "
             "analysis is *time to complete or give up*. The secondary line uses only pairs where the task "
             "was completed (with or without assistance) in **both** conditions. Improvement = "
             "(median CTRL − median SR) / median CTRL. Wilcoxon signed-rank, two-sided, on CTRL − SR.\n",
             f"Target (plan section 5): paired median improvement >= {TARGET_IMPROVEMENT_PCT:.0f} %.\n"]
    pairs: dict = {}
    if session.empty:
        lines.append("n/a — no data.\n")
        return "\n".join(lines) + "\n", pairs
    rows = []
    for task in order_tasks(session["task_id"].unique()):
        wide = paired_wide(session, task, "time_s").dropna()
        pairs[task] = wide
        succ = paired_wide(session, task, "success")
        done_both = succ.index[(succ["SR"].isin(["1", "assisted"])) & (succ["CTRL"].isin(["1", "assisted"]))]
        wide_done = wide.loc[wide.index.intersection(done_both)]
        for label, w in [("all pairs", wide), ("completed in both", wide_done)]:
            n = len(w)
            if n == 0:
                rows.append([TASK_LABEL.get(task, task), label, "0", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "no pairs"])
                continue
            med_sr, med_ctrl = float(w["SR"].median()), float(w["CTRL"].median())
            impr = (med_ctrl - med_sr) / med_ctrl * 100 if med_ctrl > 0 else np.nan
            diff = w["CTRL"] - w["SR"]
            rel = diff / w["CTRL"].replace(0, np.nan) * 100
            wt = wilcoxon_paired(w["CTRL"].to_numpy(), w["SR"].to_numpy())
            flag = ""
            if label == "all pairs" and impr == impr:
                flag = "meets target" if impr >= TARGET_IMPROVEMENT_PCT else "below target"
            note = "; ".join(x for x in [wt["note"], flag] if x)
            rows.append([TASK_LABEL.get(task, task), label, str(n), fmt(med_sr, 0), fmt(med_ctrl, 0),
                         fmt(impr, 0, " %"), f"{fmt(float(diff.median()), 0)} s / {fmt(float(rel.median()), 0, ' %')}",
                         fmt(wt["W"], 1), fmt_p(wt["p"]), note])
        if len(wide) and len(wide) < 5:
            warn(f"time {task}: only {len(wide)} pair(s); medians and p-values are unstable")
    lines.append(md_table(["Task", "Pairs", "n", "median SR", "median CTRL", "improvement",
                           "median paired diff / rel.", "W", "p", "note"], rows))

    lines.append("### Overall (per-participant total time over the tasks they did in both conditions)\n")
    rows = []
    per_part = []
    for pid, g in session.dropna(subset=["time_s"]).groupby("participant_id"):
        wide = g.pivot_table(index="task_id", columns="condition", values="time_s", aggfunc="first")
        if not {"SR", "CTRL"}.issubset(wide.columns):
            continue
        wide = wide.dropna()
        if wide.empty:
            continue
        track = "organiser" if wide.index.str.startswith("O").all() else "participant"
        expected = sum(1 for t in TASK_ORDER if TRACK_OF_TASK[t] == track)
        if len(wide) < expected:
            warn(f"time overall: {pid} has {len(wide)}/{expected} tasks timed in both conditions; "
                 "total uses only those tasks")
        per_part.append({"participant_id": pid, "track": track, "tasks": len(wide),
                         "SR": float(wide["SR"].sum()), "CTRL": float(wide["CTRL"].sum())})
    totals = pd.DataFrame(per_part)
    pairs["_totals"] = totals
    for label, sel in [("participant track", "participant"), ("organiser track", "organiser"), ("all participants", None)]:
        t = totals if sel is None else (totals[totals["track"] == sel] if len(totals) else totals)
        n = len(t)
        if n == 0:
            rows.append([label, "0", "n/a", "n/a", "n/a", "n/a", "n/a", "no pairs"])
            continue
        med_sr, med_ctrl = float(t["SR"].median()), float(t["CTRL"].median())
        impr = (med_ctrl - med_sr) / med_ctrl * 100 if med_ctrl > 0 else np.nan
        wt = wilcoxon_paired(t["CTRL"].to_numpy(), t["SR"].to_numpy())
        rel = ((t["CTRL"] - t["SR"]) / t["CTRL"].replace(0, np.nan) * 100).median()
        flag = ""
        if impr == impr:
            flag = "meets target" if impr >= TARGET_IMPROVEMENT_PCT else "below target"
        rows.append([label, str(n), fmt(med_sr, 0), fmt(med_ctrl, 0), fmt(impr, 0, " %"),
                     fmt(float(rel), 0, " %"), f"W = {fmt(wt['W'], 1)}, {p_label(wt['p'])}",
                     "; ".join(x for x in [wt["note"], flag] if x)])
    lines.append(md_table(["Scope", "n participants", "median total SR", "median total CTRL", "improvement",
                           "median rel. improvement", "Wilcoxon", "note"], rows))
    return "\n".join(lines) + "\n", pairs


def section_sus(sus: pd.DataFrame) -> tuple[str, dict]:
    lines = ["## 4. SUS\n",
             f"Original 10 items (Brooke 1996), 0–100. Target (plan section 5): SeatRelay >= {TARGET_SUS:.0f}; "
             f"published cross-system mean ≈ {SUS_PUBLISHED_MEAN:.0f}. 95 % CI is t-based on the mean.\n"]
    out: dict = {}
    if sus.empty:
        lines.append("n/a — no SUS rows.\n")
        return "\n".join(lines) + "\n", out
    rows = []
    for cond in CONDITIONS:
        v = sus.loc[sus["condition"] == cond, "sus_score"].to_numpy(dtype=float)
        st = mean_ci(v)
        out[cond] = v
        flag = ""
        if cond == "SR" and st["n"]:
            flag = "meets target" if st["mean"] >= TARGET_SUS else "below target"
            if st["n"] >= 2 and st["lo"] < TARGET_SUS <= st["hi"]:
                flag += " (CI includes target)"
        ci = f"[{fmt(st['lo'])}, {fmt(st['hi'])}]" if st["n"] >= 2 else "n/a (n < 2)"
        rows.append([CONDITION_LABEL[cond], str(st["n"]), fmt(st["mean"]), fmt(st["sd"]), ci,
                     fmt(st["median"]), f"{fmt(st['min'], 0)}–{fmt(st['max'], 0)}" if st["n"] else "n/a", flag])
        if st["n"] and st["n"] < 8:
            warn(f"sus {cond}: n={st['n']}; the CI is wide and the mean is fragile")
    lines.append(md_table(["Condition", "n", "mean", "SD", "95 % CI", "median", "range", "vs target"], rows))
    wide = sus.pivot_table(index="participant_id", columns="condition", values="sus_score", aggfunc="first")
    for c in CONDITIONS:
        if c not in wide.columns:
            wide[c] = np.nan
    wide = wide[CONDITIONS].dropna()
    out["_paired"] = wide
    if len(wide):
        d = (wide["SR"] - wide["CTRL"]).to_numpy(dtype=float)
        st = mean_ci(d)
        wt = wilcoxon_paired(wide["SR"].to_numpy(), wide["CTRL"].to_numpy())
        ci = f"[{fmt(st['lo'])}, {fmt(st['hi'])}]" if st["n"] >= 2 else "n/a"
        lines.append(md_table(["Paired difference SR − CTRL", "n", "mean", "95 % CI", "median", "Wilcoxon W", "p", "note"],
                              [["", str(st["n"]), fmt(st["mean"]), ci, fmt(st["median"]), fmt(wt["W"], 1),
                                fmt_p(wt["p"]), wt["note"]]]))
    else:
        lines.append("No participant has SUS for both conditions; paired difference n/a.\n")
    return "\n".join(lines) + "\n", out


def section_counts(session: pd.DataFrame) -> str:
    lines = ["## 5. Errors and help requests\n"]
    if session.empty:
        lines.append("n/a — no data.\n")
        return "\n".join(lines) + "\n"
    rows = []
    for task in order_tasks(session["task_id"].unique()) + ["all"]:
        for cond in CONDITIONS:
            sub = session[(session["condition"] == cond)]
            if task != "all":
                sub = sub[sub["task_id"] == task]
            e, h = sub["errors"].dropna(), sub["help_requests"].dropna()
            rows.append([TASK_LABEL.get(task, task), CONDITION_LABEL[cond], str(len(sub)),
                         f"{fmt(e.sum(), 0)} ({fmt(e.mean(), 2)}/task, n={len(e)})" if len(e) else "n/a",
                         f"{fmt(h.sum(), 0)} ({fmt(h.mean(), 2)}/task, n={len(h)})" if len(h) else "n/a",
                         str(int((sub['errors'] > 0).sum())) if len(sub) else "n/a"])
    lines.append(md_table(["Task", "Condition", "rows", "errors: total (mean, n)", "help requests: total (mean, n)",
                           "attempts with >= 1 error"], rows))
    return "\n".join(lines) + "\n"


def section_manual(session: pd.DataFrame) -> str:
    lines = ["## 6. Organiser manual steps\n",
             "One step = one state-changing or page-opening action (protocol section 6.5). Organiser tasks only.\n"]
    sub = session[session["task_id"].str.startswith("O")] if not session.empty else session
    if sub.empty or sub["manual_steps"].notna().sum() == 0:
        lines.append("n/a — no organiser rows with `manual_steps`.\n")
        return "\n".join(lines) + "\n"
    rows = []
    for task in order_tasks(sub["task_id"].unique()) + ["all"]:
        for cond in CONDITIONS:
            s = sub[sub["condition"] == cond]
            if task != "all":
                s = s[s["task_id"] == task]
            v = s["manual_steps"].dropna()
            rows.append([TASK_LABEL.get(task, task), CONDITION_LABEL[cond], str(len(v)),
                         fmt(v.mean(), 1) if len(v) else "n/a", fmt(v.median(), 1) if len(v) else "n/a",
                         f"{fmt(v.min(), 0)}–{fmt(v.max(), 0)}" if len(v) else "n/a"])
    lines.append(md_table(["Task", "Condition", "n", "mean steps", "median", "range"], rows))
    pw = []
    for task in order_tasks(sub["task_id"].unique()):
        w = paired_wide(sub, task, "manual_steps").dropna()
        if len(w):
            pw.append([TASK_LABEL.get(task, task), str(len(w)), fmt(float(w["SR"].median()), 1),
                       fmt(float(w["CTRL"].median()), 1), fmt(float((w["CTRL"] - w["SR"]).median()), 1)])
    if pw:
        lines.append(md_table(["Task (paired)", "n", "median SR", "median CTRL", "median CTRL − SR"], pw))
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------------- charts

def style_axes(ax):
    ax.set_facecolor(SURFACE)
    for side in ["top", "right"]:
        ax.spines[side].set_visible(False)
    for side in ["left", "bottom"]:
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=INK_SECONDARY, labelsize=9)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.title.set_color(INK)
    ax.xaxis.label.set_color(INK_SECONDARY)
    ax.yaxis.label.set_color(INK_SECONDARY)


def chart_time(pairs: dict, out: Path) -> Path | None:
    tasks = [t for t in order_tasks([k for k in pairs if not k.startswith("_")]) if len(pairs[t])]
    if not tasks:
        warn("chart task-time-paired.png skipped: no paired times")
        return None
    fig, axes = plt.subplots(1, len(tasks), figsize=(2.2 * len(tasks) + 1.5, 4.2), sharey=True, squeeze=False)
    fig.patch.set_facecolor(SURFACE)
    for ax, task in zip(axes[0], tasks):
        w = pairs[task]
        style_axes(ax)
        rng = np.random.default_rng(0)
        for pid, r in w.iterrows():
            jitter = rng.uniform(-0.05, 0.05)
            ax.plot([0 + jitter, 1 + jitter], [r["CTRL"], r["SR"]], color=INK_SECONDARY, alpha=0.35, linewidth=1, zorder=1)
            ax.scatter([0 + jitter], [r["CTRL"]], s=28, color=COLOR["CTRL"], edgecolor=SURFACE, linewidth=1, zorder=2)
            ax.scatter([1 + jitter], [r["SR"]], s=28, color=COLOR["SR"], edgecolor=SURFACE, linewidth=1, zorder=2)
        for x, cond in [(0, "CTRL"), (1, "SR")]:
            med = float(w[cond].median())
            ax.plot([x - 0.22, x + 0.22], [med, med], color=COLOR[cond], linewidth=2.5, zorder=3)
            ax.annotate(f"{med:.0f} s", (x + 0.24, med), xytext=(3, -3), textcoords="offset points",
                        ha="left", fontsize=8, color=INK)
        ax.axhline(TIME_CAP_S, color=GRID, linestyle="--", linewidth=1)
        ax.set_xticks([0, 1], [CONDITION_LABEL["CTRL"], CONDITION_LABEL["SR"]])
        ax.set_xlim(-0.5, 1.5)
        ax.set_title(f"{TASK_LABEL.get(task, task)}\n(n = {len(w)})", fontsize=9)
    axes[0][0].set_ylabel("task time (s); dashed = 300 s cap")
    axes[0][0].set_ylim(0, max(TIME_CAP_S * 1.08, float(max(pairs[t][CONDITIONS].max().max() for t in tasks)) * 1.1))
    fig.suptitle("Task time per participant, control vs SeatRelay (lines join the same person; bars = medians)",
                 fontsize=10, color=INK)
    fig.tight_layout()
    path = out / "task-time-paired.png"
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)
    return path


def chart_sus(sus_out: dict, out: Path) -> Path | None:
    order = ["CTRL", "SR"]
    pos = {"CTRL": 0, "SR": 1}
    data = {c: np.asarray(sus_out.get(c, np.array([])), dtype=float) for c in order}
    if all(len(d) == 0 for d in data.values()):
        warn("chart sus-boxplot.png skipped: no SUS rows")
        return None
    fig, ax = plt.subplots(figsize=(5.2, 4.2))
    fig.patch.set_facecolor(SURFACE)
    style_axes(ax)
    plotted = [c for c in order if len(data[c])]
    bp = ax.boxplot([data[c] for c in plotted], positions=[pos[c] for c in plotted], widths=0.45,
                    patch_artist=True, showfliers=False, medianprops={"color": INK, "linewidth": 1.5}, zorder=2)
    for patch, cond in zip(bp["boxes"], plotted):
        patch.set(facecolor=COLOR[cond], alpha=0.25, edgecolor=COLOR[cond], linewidth=1.2)
    for key in ["whiskers", "caps"]:
        for line in bp[key]:
            line.set(color=INK_SECONDARY, linewidth=1)
    paired = sus_out.get("_paired")
    if paired is not None and len(paired):
        for _, r in paired.iterrows():
            ax.plot([pos["CTRL"], pos["SR"]], [r["CTRL"], r["SR"]], color=INK_SECONDARY, alpha=0.3,
                    linewidth=1, zorder=1)
    rng = np.random.default_rng(1)
    for cond in plotted:
        d = data[cond]
        ax.scatter(pos[cond] + rng.uniform(-0.08, 0.08, len(d)), d, s=26, color=COLOR[cond], edgecolor=SURFACE,
                   linewidth=1, zorder=3, label=f"{CONDITION_LABEL[cond]} (n = {len(d)})")
        ax.annotate(f"mean {np.mean(d):.1f}", (pos[cond], float(np.max(d))), xytext=(0, 8),
                    textcoords="offset points", ha="center", fontsize=8, color=INK)
    ax.axhline(TARGET_SUS, color=COLOR["SR"], linestyle="--", linewidth=1)
    ax.annotate(f"target {TARGET_SUS:.0f}", (-0.45, TARGET_SUS), xytext=(0, 3), textcoords="offset points",
                ha="left", fontsize=8, color=INK_SECONDARY)
    ax.axhline(SUS_PUBLISHED_MEAN, color=INK_SECONDARY, linestyle=":", linewidth=1)
    ax.annotate(f"published mean {SUS_PUBLISHED_MEAN:.0f}", (-0.45, SUS_PUBLISHED_MEAN), xytext=(0, -10),
                textcoords="offset points", ha="left", fontsize=8, color=INK_SECONDARY)
    ax.set_xticks([pos[c] for c in order], [CONDITION_LABEL[c] for c in order])
    ax.set_xlim(-0.5, 1.5)
    ax.set_ylim(0, 105)
    ax.set_ylabel("SUS score (0–100)")
    ax.set_title("SUS per condition (lines join the same participant)", fontsize=10)
    ax.legend(frameon=False, fontsize=8, loc="lower right")
    fig.tight_layout()
    path = out / "sus-boxplot.png"
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)
    return path


def chart_completion(table: dict, out: Path) -> Path | None:
    tasks = [t for t in TASK_ORDER if (t, "SR") in table and (table[(t, "SR")]["n"] or table[(t, "CTRL")]["n"])]
    if not tasks:
        warn("chart completion-bars.png skipped: no completion data")
        return None
    fig, ax = plt.subplots(figsize=(1.1 * len(tasks) + 3, 4.2))
    fig.patch.set_facecolor(SURFACE)
    style_axes(ax)
    x = np.arange(len(tasks))
    width = 0.36
    for i, cond in enumerate(["CTRL", "SR"]):
        offs = (i - 0.5) * (width + 0.04)
        base = [table[(t, cond)]["rate"] * 100 if table[(t, cond)]["n"] else 0 for t in tasks]
        extra = [(table[(t, cond)]["rate_incl"] - table[(t, cond)]["rate"]) * 100 if table[(t, cond)]["n"] else 0 for t in tasks]
        ax.bar(x + offs, base, width, color=COLOR[cond], label=f"{CONDITION_LABEL[cond]} — completed", zorder=2)
        ax.bar(x + offs, extra, width, bottom=base, color=COLOR[cond], alpha=0.35,
               label=f"{CONDITION_LABEL[cond]} — assisted", zorder=2)
        for xi, t, b, e in zip(x + offs, tasks, base, extra):
            n = table[(t, cond)]["n"]
            ax.annotate(f"{b:.0f}%\nn={n}" if n else "n=0", (xi, b + e), xytext=(0, 3), textcoords="offset points",
                        ha="center", fontsize=7, color=INK)
    ax.axhline(TARGET_COMPLETION * 100, color=INK_SECONDARY, linestyle="--", linewidth=1)
    ax.annotate(f"target {TARGET_COMPLETION:.0%}", (-0.6, TARGET_COMPLETION * 100), xytext=(0, 3),
                textcoords="offset points", ha="left", fontsize=8, color=INK_SECONDARY)
    ax.set_xticks(x, [TASK_LABEL.get(t, t).replace(" ", "\n", 1) for t in tasks], fontsize=8)
    ax.set_xlim(-0.6, len(tasks) - 0.4)
    ax.set_ylim(0, 118)
    ax.set_ylabel("completion rate (%)")
    ax.set_title("Task completion per condition (solid = unassisted, light = assisted)", fontsize=10)
    fig.legend(frameon=False, fontsize=8, ncol=4, loc="lower center", bbox_to_anchor=(0.5, 0.0))
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    path = out / "completion-bars.png"
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)
    return path


# ----------------------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session_csv", nargs="?", default=str(DEFAULT_SESSION))
    ap.add_argument("sus_csv", nargs="?", default=str(DEFAULT_SUS))
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output directory (default results/user-study)")
    ap.add_argument("--keep-examples", action="store_true", help="keep EXAMPLE rows (smoke test only)")
    args = ap.parse_args(argv)

    session_path, sus_path, out = Path(args.session_csv), Path(args.sus_csv), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    session = clean_session(drop_examples(read_csv(session_path, SESSION_COLUMNS, "session"), "session", args.keep_examples))
    sus = clean_sus(drop_examples(read_csv(sus_path, SUS_COLUMNS, "sus"), "sus", args.keep_examples))
    if session.empty:
        warn("session sheet has no usable rows (after dropping EXAMPLE rows)")
    if sus.empty:
        warn("sus sheet has no usable rows (after dropping EXAMPLE rows)")

    # keep the cleaned raw data next to the summary (single source of truth for the report)
    session.to_csv(out / "session-sheet.csv", index=False)
    sus.to_csv(out / "sus-sheet.csv", index=False)

    paths = {"session": session_path, "sus": sus_path}
    parts = [f"# User evaluation — summary\n\nGenerated {date.today().isoformat()} by `docs/user-study/analysis.py`"
             + (" **(EXAMPLE rows kept — smoke test, not study data)**" if args.keep_examples else "") + ".\n"]
    parts.append(section_data(session, sus, paths))
    completion_md, completion_table = section_completion(session)
    parts.append(completion_md)
    time_md, pairs = section_time(session)
    parts.append(time_md)
    sus_md, sus_out = section_sus(sus)
    parts.append(sus_md)
    parts.append(section_counts(session))
    parts.append(section_manual(session))

    charts = [chart_time(pairs, out), chart_sus(sus_out, out), chart_completion(completion_table, out)]
    charts = [c for c in charts if c]
    parts.append("## 7. Charts\n\n" + ("\n".join(f"- `{c.name}`" for c in charts) if charts else "none written") + "\n")
    parts.append("## 8. Warnings from this run\n\n" + ("\n".join(f"- {w}" for w in WARNINGS) if WARNINGS else "none") + "\n")
    parts.append("## 9. Reporting notes\n\n"
                 "- Report n per track and per condition exactly as in section 1; do not pool participant and organiser tasks when quoting a completion rate for a task.\n"
                 "- Wilcoxon p-values are an uncertainty statement for a small within-subject sample, not a claim of generality; with n non-zero pairs the smallest attainable two-sided p is 2^(1-n).\n"
                 "- Failed tasks enter the time analysis at the 300 s cap; say so when quoting the improvement.\n"
                 "- Order and dataset balance (section 1) should be checked before attributing differences to the tool.\n")

    summary = out / "summary.md"
    summary.write_text("\n".join(parts), encoding="utf-8")
    print(f"wrote {summary}")
    for c in charts:
        print(f"wrote {c}")
    print(f"{len(WARNINGS)} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
