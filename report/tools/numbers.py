#!/usr/bin/env python3
"""Every number the Final report quotes, as LaTeX macros generated from ``results/``.

Writes

    report/generated/numbers.tex   \\newcommand{\\Macro}{value} per number, each preceded by a
                                   comment naming its source file and column / row / key
    report/generated/pending.tex   \\pending{...}: the visible red placeholder for missing data
    report/generated/README.md     naming scheme + the full macro list (value, source)

Rules (academic integrity, plan §0): a number is either read from a file under ``results/`` or
computed from one (pooled percentiles, counts, shares), never typed in. Data that does not exist
yet becomes ``\\pending{<what is missing>}``, which prints as a red "[PENDING: ...]" in the PDF.

Selection: for every Table 3 experiment the latest **complete** run directory
``results/<YYYY-MM-DD>-<name>[-<n>]/`` (it has a meta.json) whose target is ``--target``
(default dev, the report target). Its run id, start time and commit are recorded in a comment.
Load test: the latest ``results/loadtest/<date>/raw.csv``; replay: the latest
``results/<date>-replay/`` else ``results/replay/``; cost: ``results/cost/``; user study:
``results/user-study/``; interviews: ``results/interviews/``; pilot: ``results/pilot/`` or the
latest ``results/<date>-pilot/``.

Percentiles of pooled samples are nearest-rank, as in tools/experiments (summary.md).

Usage (idempotent; re-run whenever results/ changes):

    python3 -I report/tools/numbers.py [--results DIR] [--out DIR] [--target dev]
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import re
import sys
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path


def _load_db():
    sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
    path = Path(__file__).resolve().parent / "resultsdb.py"
    spec = importlib.util.spec_from_file_location("seatrelay_resultsdb", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


db = _load_db()
rel = db.rel

# ============================================================================ formatting

NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
                "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
                "Nineteen"]
TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def words(n: int) -> str:
    """Integer as CamelCase English words (macro names cannot contain digits): 25 -> TwentyFive."""
    if n < 0:
        return "Minus" + words(-n)
    if n < 20:
        return NUMBER_WORDS[n]
    if n < 100:
        return TENS[n // 10] + (NUMBER_WORDS[n % 10] if n % 10 else "")
    if n < 1000:
        return NUMBER_WORDS[n // 100] + "Hundred" + (words(n % 100) if n % 100 else "")
    if n < 1_000_000:
        return words(n // 1000) + "Thousand" + (words(n % 1000) if n % 1000 else "")
    return words(n // 1_000_000) + "Million" + (words(n % 1_000_000) if n % 1_000_000 else "")


def camel(text: str) -> str:
    """Letters-only CamelCase of an arbitrary label ('cross-workshop' -> 'CrossWorkshop')."""
    out = []
    for token in re.split(r"[^A-Za-z0-9]+", text):
        if not token:
            continue
        if token.isdigit():
            out.append(words(int(token)))
            continue
        token = re.sub(r"\d+", lambda m: words(int(m.group(0))), token)
        out.append(token[0].upper() + token[1:])
    return "".join(out)


def is_missing(value) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    return False


def tex_number(value: float, digits: int = 0) -> str:
    """Text-mode number: thousands separator {,}, a real minus sign, fixed decimals."""
    value = float(value)
    text = f"{abs(value):,.{digits}f}"
    zero = float(text.replace(",", "")) == 0.0
    text = text.replace(",", "{,}")
    return ("\\ensuremath{-}" + text) if value < 0 and not zero else text


def tex_text(value: str) -> str:
    repl = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_",
            "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
            "<": r"\textless{}", ">": r"\textgreater{}"}
    return "".join(repl.get(ch, ch) for ch in str(value)).replace("--", "-{}-")


def summary_number(text: str) -> str:
    """A number exactly as printed in a summary.md cell ('-4.04', '1,000') as TeX text."""
    raw = text.strip().replace(",", "")
    negative = raw.startswith("-") or raw.startswith("\u2212")
    raw = raw.lstrip("-\u2212")
    if raw.replace(".", "", 1).isdigit():
        whole, _, frac = raw.partition(".")
        raw = f"{int(whole):,}".replace(",", "{,}") + (f".{frac}" if frac else "")
    zero = all(ch in "0." for ch in raw)
    return ("\\ensuremath{-}" + raw) if negative and not zero else raw


def to_float(text) -> float | None:
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return None if (isinstance(text, float) and math.isnan(text)) else float(text)
    cleaned = str(text).strip().replace(",", "").replace("\u2212", "-")
    try:
        return float(cleaned)
    except ValueError:
        return None


# ============================================================================ the macro book

@dataclass
class Entry:
    macro: str
    value: str | None          # TeX text, None = pending
    source: str
    desc: str
    reason: str | None = None  # pending reason


class Book:
    def __init__(self) -> None:
        self.sections: "OrderedDict[str, dict]" = OrderedDict()
        self.names: set[str] = set()
        self.current: dict | None = None
        self.notes: list[str] = []

    def section(self, key: str, title: str, pending: str, sources: list[str]) -> None:
        self.current = {"key": key, "title": title, "pending": pending, "sources": sources, "entries": []}
        self.sections[key] = self.current

    def _add(self, macro: str, value: str | None, source: str, desc: str, reason: str | None) -> None:
        if not re.fullmatch(r"[A-Za-z]+", macro):
            raise ValueError(f"invalid macro name {macro!r} (letters only)")
        if macro in self.names:
            raise ValueError(f"duplicate macro {macro}")
        self.names.add(macro)
        if value is None:
            reason = reason or self.current["pending"]
        self.current["entries"].append(Entry(macro, value, source, desc, reason if value is None else None))

    def num(self, macro: str, value, digits: int, source: str, desc: str, reason: str | None = None,
            scale: float = 1.0) -> None:
        number = to_float(value)
        if is_missing(number):
            self._add(macro, None, source, desc, reason)
        else:
            self._add(macro, tex_number(number * scale, digits), source, desc, None)

    def pvalue(self, macro: str, value, source: str, desc: str, reason: str | None = None) -> None:
        """A p-value: three decimals, or '<0.001' (never a misleading 0.000)."""
        number = to_float(value)
        if is_missing(number):
            self._add(macro, None, source, desc, reason)
        else:
            self._add(macro, "\\ensuremath{<}0.001" if number < 0.001 else tex_number(number, 3), source, desc, None)

    def raw(self, macro: str, tex: str | None, source: str, desc: str, reason: str | None = None) -> None:
        self._add(macro, tex if tex not in (None, "") else None, source, desc, reason)

    def text(self, macro: str, value, source: str, desc: str, reason: str | None = None) -> None:
        self._add(macro, None if value in (None, "") else tex_text(value), source, desc, reason)

    def entries(self):
        for section in self.sections.values():
            yield from section["entries"]


# ============================================================================ helpers per run

def src_of(run, file: str, key: str) -> str:
    return f"{rel(run.path)}/{file}: {key}" if run else f"results/<date>-<name>/{file}: {key}"


def run_header(book: Book, prefix: str, run, what: str) -> None:
    """Verdict, run id, date, commit, runs and check counts of a harness run (meta.json)."""
    meta = run.meta if run else {}
    checks = meta.get("checks") or {}
    commit = run.commit if run else {}
    verdict = None if not run else ("PASS" if meta.get("ok") else "FAIL")
    book.text(f"{prefix}Verdict", verdict, src_of(run, "meta.json", "ok"), f"{what}: verdict (PASS/FAIL)")
    book.text(f"{prefix}RunId", (meta.get("runId") or "")[:8] or None, src_of(run, "meta.json", "runId (first 8 characters)"), f"{what}: run id")
    book.text(f"{prefix}Date", (meta.get("startedAt") or "")[:10] or None, src_of(run, "meta.json", "startedAt (UTC date)"), f"{what}: date of the run")
    book.text(f"{prefix}Commit", (commit.get("hash") or "")[:7] or None, src_of(run, "meta.json", "commit.hash (7 characters)"), f"{what}: commit of the code under test")
    book.num(f"{prefix}Runs", meta.get("runs"), 0, src_of(run, "meta.json", "runs"), f"{what}: repetitions in the invocation")
    book.num(f"{prefix}ChecksPassed", checks.get("passed"), 0, src_of(run, "meta.json", "checks.passed"), f"{what}: checks passed")
    book.num(f"{prefix}ChecksTotal", checks.get("total"), 0, src_of(run, "meta.json", "checks.total"), f"{what}: checks in total")
    passed, total, file = runs_passed(run)
    book.num(f"{prefix}RunsPassed", passed, 0, src_of(run, file, "runs whose check rows are all ok"), f"{what}: runs with every check passed")
    if run and meta.get("commit", {}) and isinstance(meta.get("commit"), dict) and meta["commit"].get("dirty"):
        book.notes.append(f"{rel(run.path)}: recorded with a dirty working tree (commit.dirty = true); "
                          "check whether only results/ files were uncommitted before quoting it as a report run")


def check_rows(run):
    """(frame, file name) of the assertion rows: checks.csv, or raw.csv when the script has no samples."""
    if not run:
        return None, "checks.csv"
    for name in ("checks.csv", "raw.csv"):
        frame = db.read_csv(run.path / name)
        if frame is not None and {"ok", "run"}.issubset(frame.columns) and ("step" in frame.columns or "probe" in frame.columns or "case" in frame.columns):
            return frame, name
    return None, "checks.csv"


def runs_passed(run) -> tuple[int | None, int | None, str]:
    frame, name = check_rows(run)
    if frame is None:
        return None, None, name
    ok = frame["ok"].astype(str).str.lower().isin(["true", "1"])
    frame = frame.assign(_ok=ok)
    runs = frame.dropna(subset=["run"])
    per_run = runs.groupby("run")["_ok"].all()
    harness_fail = not frame.loc[frame["run"].isna(), "_ok"].all()
    passed = int(per_run.sum()) if not harness_fail else 0
    return passed, int(per_run.size), name


def summary_stats(book: Book, prefix: str, stats: dict | None, run, key: str, what: str,
                  fields=(("N", "count", 0), ("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0),
                          ("PNinetyNineMs", "p99", 0), ("MaxMs", "max", 0), ("MeanMs", "mean", 0)),
                  reason: str | None = None) -> None:
    stats = stats or {}
    for suffix, field, digits in fields:
        book.num(f"{prefix}{suffix}", stats.get(field) if stats.get("count") else None, digits,
                 src_of(run, "meta.json", f"{key}.{field}"), f"{what} ({field})", reason)


def pooled(book: Book, prefix: str, values, source: str, what: str, reason: str | None = None,
           seconds: bool = False) -> None:
    clean = [float(v) for v in values if not is_missing(to_float(v))]
    have = bool(clean)
    stats = {
        "N": (len(clean), 0),
        "PFiftyMs": (db.nearest_rank(clean, 50), 0),
        "PNinetyFiveMs": (db.nearest_rank(clean, 95), 0),
        "PNinetyNineMs": (db.nearest_rank(clean, 99), 0),
        "MaxMs": (max(clean) if have else None, 0),
        "MeanMs": (sum(clean) / len(clean) if have else None, 0),
    }
    for suffix, (value, digits) in stats.items():
        book.num(f"{prefix}{suffix}", value if have else None, digits, source, f"{what}: {suffix}", reason)
    if seconds:
        for suffix in ("PFifty", "PNinetyFive", "Max"):
            value = stats[f"{suffix}Ms"][0]
            book.num(f"{prefix}{suffix}S", None if not have else value / 1000.0, 2, source, f"{what}: {suffix} in seconds", reason)


# ============================================================================ sections

def section_smoke(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "smoke", target, book.notes)
    book.section("smoke", f"Acceptance smoke test ({target})", f"smoke test ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "Smoke", run, "smoke")
    meta = run.meta if run else {}
    book.num("SmokeHoldSeconds", meta.get("holdSeconds"), 0, src_of(run, "meta.json", "holdSeconds"), "holdSeconds of the smoke workshop")
    summary_stats(book, "SmokeSettleClient", meta.get("settleMs"), run, "settleMs", "client-observed settle latency (ms)",
                  fields=(("N", "count", 0), ("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0), ("MaxMs", "max", 0)))
    summary_stats(book, "SmokeSettleServer", meta.get("serverSettleMs"), run, "serverSettleMs", "server settle latency settledAt - acceptedAt (ms)",
                  fields=(("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0), ("MaxMs", "max", 0)))
    samples = meta.get("expiryBackfillLatencyMs") or []
    samples = [s for s in samples if s is not None]
    book.num("SmokeExpiryBackfillN", len(samples) if run else None, 0, src_of(run, "meta.json", "expiryBackfillLatencyMs (count)"), "expiry-driven backfill samples")
    book.num("SmokeExpiryBackfillMaxMs", max(samples) if samples else None, 0, src_of(run, "meta.json", "expiryBackfillLatencyMs (max)"), "expiry-driven backfill latency, largest sample (ms)")


def section_correctness(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "correctness", target, book.notes)
    book.section("correctness", f"Core correctness ({target})", f"correctness ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "Correctness", run, "correctness")
    meta = run.meta if run else {}
    scenarios = meta.get("scenarios") or []
    names = sorted({s.get("name") for s in scenarios if s.get("name")})
    book.num("CorrectnessScenarios", len(names) if run and names else None, 0, src_of(run, "meta.json", "scenarios[].name (distinct)"), "distinct scenarios")
    book.num("CorrectnessScenarioRuns", len(scenarios) if run and scenarios else None, 0, src_of(run, "meta.json", "scenarios (entries)"), "scenario executions (scenarios x runs)")
    book.num("CorrectnessScenarioRunsPassed", sum(1 for s in scenarios if s.get("failed") == 0) if run and scenarios else None, 0,
             src_of(run, "meta.json", "scenarios[].failed == 0"), "scenario executions without a failed check")
    for macro, key, desc in (("CorrectnessOverCapacity", "overCapacity", "over-capacity observations"),
                             ("CorrectnessDoubleHolds", "doubleHolds", "double holds"),
                             ("CorrectnessVerifications", "verifications", "post-step invariant reads (verify)"),
                             ("CorrectnessVerifyFailures", "verifyFailures", "verify failures")):
        book.num(macro, meta.get(key), 0, src_of(run, "meta.json", key), desc)
    summary_stats(book, "CorrectnessSettleClient", meta.get("settleMs"), run, "settleMs", "client-observed settle latency (ms)",
                  fields=(("N", "count", 0), ("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0), ("MaxMs", "max", 0)))
    summary_stats(book, "CorrectnessSettleServer", meta.get("serverSettleMs"), run, "serverSettleMs", "server settle latency (ms)",
                  fields=(("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0), ("MaxMs", "max", 0)))


def section_preference(book: Book, runs, target: str, results: Path) -> None:
    run = db.latest_run(runs, "preference-order", target, book.notes)
    book.section("preference", f"Preference, order: deployment replay ({target}) and core property test",
                 f"preference-order ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "PrefOrder", run, "preference-order")
    meta = run.meta if run else {}
    book.num("PrefOrderCases", meta.get("cases"), 0, src_of(run, "meta.json", "cases"), "case executions (20 cases x runs)")
    book.num("PrefOrderCasesPassed", meta.get("passed"), 0, src_of(run, "meta.json", "passed"), "case executions as predicted by the oracle")
    book.num("PrefOrderNonAcceptable", meta.get("offeredNonAcceptable"), 0, src_of(run, "meta.json", "offeredNonAcceptable"), "offers of a non-acceptable session")
    raw = db.read_csv(run.path / "raw.csv", book.notes) if run else None
    distinct = raw["case"].nunique() if raw is not None and "case" in raw.columns else None
    book.num("PrefOrderDistinctCases", distinct, 0, src_of(run, "raw.csv", "case (distinct)"), "distinct fixed cases")
    summary_stats(book, "PrefOrderSettleClient", meta.get("settleMs"), run, "settleMs", "client-observed settle latency (ms)",
                  fields=(("N", "count", 0), ("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0)))
    lat = db.read_csv(run.path / "latency.csv", book.notes) if run else None
    values = lat["serverSettleMs"].tolist() if lat is not None and "serverSettleMs" in lat.columns else []
    book.num("PrefOrderSettleServerPNinetyFiveMs", db.nearest_rank(values, 95) if values else None, 0,
             src_of(run, "latency.csv", "serverSettleMs (nearest-rank p95)"), "server settle latency p95 (ms)")

    # core property test (Part A): results/<date>-core-tests/{run.log, coverage-summary.json, commit.txt}
    core_dirs = sorted((r for r in runs.get("core-tests", []) if (r.path / "run.log").exists()),
                       key=lambda r: (r.date, r.suffix), reverse=True)
    core = core_dirs[0] if core_dirs else None
    reason = "core property-test results (results/<date>-core-tests) not yet recorded"
    book.current["sources"].append(f"core-tests: {rel(core.path)}" if core else "core-tests: none")
    log = (core.path / "run.log").read_text(encoding="utf-8", errors="replace") if core else ""
    log = re.sub(r"\x1b\[[0-9;]*m", "", log)
    tests = re.search(r"Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)", log)
    files = re.search(r"Test Files\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)", log)
    seqs = re.search(r"(\d[\d,]*)\s+random\s+(?:command\s+)?sequences", log)
    src = f"{rel(core.path)}/run.log" if core else "results/<date>-core-tests/run.log"
    book.num("CoreTestsPassed", tests.group(2) if tests else None, 0, f"{src}: 'Tests N passed'", "core unit + property tests passed", reason)
    book.num("CoreTestsTotal", tests.group(3) if tests else None, 0, f"{src}: 'Tests ... (total)'", "core tests in total", reason)
    book.num("CoreTestFiles", files.group(3) if files else None, 0, f"{src}: 'Test Files ... (total)'", "core test files", reason)
    book.num("CorePropertySequences", seqs.group(1) if seqs else None, 0, f"{src}: test title '<n> random command sequences'", "random command sequences of the property test", reason)
    cov = db.read_json(core.path / "coverage-summary.json") if core else None
    total = (cov or {}).get("total", {})
    csrc = f"{rel(core.path)}/coverage-summary.json" if core else "results/<date>-core-tests/coverage-summary.json"
    book.num("CoreBranchCoveragePct", (total.get("branches") or {}).get("pct"), 1, f"{csrc}: total.branches.pct", "core branch coverage (%)", reason)
    book.num("CoreLineCoveragePct", (total.get("lines") or {}).get("pct"), 1, f"{csrc}: total.lines.pct", "core line coverage (%)", reason)
    commit = (core.path / "commit.txt").read_text().strip()[:7] if core and (core.path / "commit.txt").exists() else None
    book.text("CoreTestsCommit", commit, f"{rel(core.path) if core else 'results/<date>-core-tests'}/commit.txt", "commit of the core test run", reason)


def section_concurrency(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "concurrency", target, book.notes)
    book.section("concurrency", f"Concurrency ({target})", f"concurrency ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "Concurrency", run, "concurrency")
    meta = run.meta if run else {}
    params = meta.get("params") or {}
    book.num("ConcurrencyAccounts", params.get("accounts"), 0, src_of(run, "meta.json", "params.accounts"), "concurrent accounts")
    book.num("ConcurrencySessions", params.get("sessions"), 0, src_of(run, "meta.json", "params.sessions"), "sessions")
    book.num("ConcurrencySeats", params.get("capacityTotal"), 0, src_of(run, "meta.json", "params.capacityTotal"), "seats in total")
    retries = meta.get("metaConflictRetries")
    book.num("ConcurrencyMetaRetries", retries, 0, src_of(run, "meta.json", "metaConflictRetries"), "META version-conflict retries in the run window",
             reason=None if not run else "MetaConflictRetries not fetched (CloudWatch read skipped)")
    raw = db.read_csv(run.path / "raw.csv", book.notes) if run else None
    book.num("ConcurrencyCommands", len(raw) if raw is not None else None, 0, src_of(run, "raw.csv", "rows"), "commands issued")
    if raw is not None and "error" in raw.columns:
        errors = int(raw["error"].fillna("").astype(str).str.len().gt(0).sum())
    else:
        errors = None
    book.num("ConcurrencyTransportErrors", errors, 0, src_of(run, "raw.csv", "error (non-empty)"), "commands with a transport error")
    summary_stats(book, "ConcurrencySettleClient", meta.get("settleMs"), run, "settleMs", "client-observed settle latency (ms)",
                  fields=(("N", "count", 0), ("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0), ("MaxMs", "max", 0)))
    summary_stats(book, "ConcurrencySettleServer", meta.get("serverSettleMs"), run, "serverSettleMs", "server settle latency (ms)",
                  fields=(("PFiftyMs", "p50", 0), ("PNinetyFiveMs", "p95", 0), ("MaxMs", "max", 0)))
    checks = db.read_csv(run.path / "checks.csv", book.notes) if run else None
    same = None
    if checks is not None and {"step", "ok"}.issubset(checks.columns):
        same = checks[checks["step"].astype(str).str.contains("exactly one of ACCEPT/DECLINE/CANCEL", regex=False)]
    book.num("ConcurrencySameAccountRaces", None if same is None else len(same), 0, src_of(run, "checks.csv", "same-account race checks (rows)"),
             "same-account ACCEPT/DECLINE/CANCEL races")
    ok_same = None if same is None else same["ok"].astype(str).str.lower().eq("true")
    book.num("ConcurrencySameAccountConsistent", None if same is None else int(ok_same.sum()), 0, src_of(run, "checks.csv", "same-account race checks with ok = true"),
             "same-account races with exactly one effective command")
    failed = None if same is None else same[~ok_same]
    text = None if failed is None else failed["actual"].fillna("").astype(str)
    if text is not None and "detail" in failed.columns:
        text = text + " " + failed["detail"].fillna("").astype(str)
    with503 = None if text is None else int(text.str.contains("HTTP 503", regex=False).sum())
    book.num("ConcurrencySameAccountFailed", None if failed is None else len(failed), 0, src_of(run, "checks.csv", "same-account race checks with ok = false"),
             "same-account races that failed the check")
    book.num("ConcurrencySameAccountFailedWithServiceUnavailable", with503, 0, src_of(run, "checks.csv", "failed same-account races whose actual value contains 'HTTP 503'"),
             "failed same-account races in which one of the commands got HTTP 503")
    race = meta.get("raceFirst") or {}
    for key in ("ACCEPT", "DECLINE", "CANCEL"):
        book.num(f"ConcurrencyRaceFirst{camel(key.lower())}", race.get(key, 0) if run and race else None, 0,
                 src_of(run, "meta.json", f"raceFirst.{key}"), f"same-account races won by {key}")


def section_repeat(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "repeat-execution", target, book.notes)
    book.section("repeat", f"Repeat execution ({target})", f"repeat-execution ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "Repeat", run, "repeat-execution")
    meta = run.meta if run else {}
    book.num("RepeatProbes", meta.get("probes"), 0, src_of(run, "meta.json", "probes"), "probes")
    book.num("RepeatProbesPassed", meta.get("passed"), 0, src_of(run, "meta.json", "passed"), "probes passed")
    book.num("RepeatCopies", meta.get("copies"), 0, src_of(run, "meta.json", "copies"), "concurrent copies per commandId")
    raw = db.read_csv(run.path / "raw.csv", book.notes) if run else None
    after = None
    if raw is not None and "case" in raw.columns:
        after = raw[raw["case"].astype(str).str.contains("AFTER_COMMIT", case=False)]
    book.num("RepeatAfterCommitCases", len(after) if after is not None else None, 0, src_of(run, "raw.csv", "case contains AFTER_COMMIT"), "AFTER_COMMIT crash cases")
    ok = None
    if after is not None and "ok" in after.columns:
        ok = int(after["ok"].astype(str).str.lower().eq("true").sum())
    book.num("RepeatAfterCommitPassed", ok, 0, src_of(run, "raw.csv", "AFTER_COMMIT rows with ok = true"), "AFTER_COMMIT cases applied once after redelivery")
    # The duplicate-submission probes (same commandId POSTed several times at once) are the other rows.
    dup = None
    if raw is not None and "case" in raw.columns:
        dup = raw[~raw["case"].astype(str).str.contains("AFTER_COMMIT", case=False)]
    book.num("RepeatDupProbes", None if dup is None else len(dup), 0, src_of(run, "raw.csv", "case without AFTER_COMMIT (rows)"), "duplicate-submission probes")
    dup_ok = None if dup is None or "ok" not in dup.columns else int(dup["ok"].astype(str).str.lower().eq("true").sum())
    book.num("RepeatDupProbesPassed", dup_ok, 0, src_of(run, "raw.csv", "case without AFTER_COMMIT, ok = true"), "duplicate-submission probes applied once")
    copies = sorted({int(c) for c in dup["copies"].tolist()}) if dup is not None and "copies" in dup.columns and len(dup) else []
    book.num("RepeatDupCopies", copies[0] if len(copies) == 1 else None, 0, src_of(run, "raw.csv", "copies of the duplicate-submission probes (single value)"),
             "concurrent copies per duplicate-submission probe", reason=None if not run else "copies differ between probes")
    after_copies = sorted({int(c) for c in after["copies"].tolist()}) if after is not None and "copies" in after.columns and len(after) else []
    book.num("RepeatAfterCommitCopies", after_copies[0] if len(after_copies) == 1 else None, 0, src_of(run, "raw.csv", "copies of the AFTER_COMMIT probes (single value)"),
             "POSTs per AFTER_COMMIT probe", reason=None if not run else "copies differ between probes")


TABLE3 = ("correctness", "preference-order", "concurrency", "repeat-execution", "expiry-race", "failure-recovery",
          "access-control", "backfill")


def section_series(book: Book, runs, target: str) -> None:
    """The experiment series as a whole: how many runs failed a check, and at which commits they ran."""
    chosen = [(name, db.latest_run(runs, name, target)) for name in TABLE3]
    present = [(name, run) for name, run in chosen if run]
    book.section("series", f"Table 3 series ({target}): failures and commits", f"Table 3 series ({target}) not yet run",
                 [f"{name}: {rel(run.path)}" for name, run in present] or ["none"])
    failed = [name for name, run in present if not run.meta.get("ok")]
    book.num("SeriesExperiments", len(present) if present else None, 0, "meta.json of each selected run", "Table 3 experiments with a complete run")
    book.num("SeriesFailed", len(failed) if present else None, 0, "meta.json ok = false of each selected run", "experiments whose run failed a check")
    book.num("SeriesPassed", len(present) - len(failed) if present else None, 0, "meta.json ok = true of each selected run", "experiments whose run passed every check")
    book.text("SeriesFailedNames", ", ".join(failed) if present else None, "meta.json ok = false of each selected run", "names of the failed experiments")
    commits = []
    for _, run in present:
        commit = run.meta.get("commit") or {}
        short = (commit.get("hash") or "")[:7]
        if short and short not in commits:
            commits.append(short)
    book.text("SeriesCommits", ", ".join(commits) if commits else None, "meta.json commit.hash of each selected run (in run order)", "commits recorded by the series")
    book.num("SeriesCommitCount", len(commits) if commits else None, 0, "meta.json commit.hash (distinct)", "distinct commits recorded by the series")
    dirty = sum(1 for _, run in present if (run.meta.get("commit") or {}).get("dirty"))
    book.num("SeriesDirtyRuns", dirty if present else None, 0, "meta.json commit.dirty = true", "runs recorded with uncommitted changes in the working tree")


def section_timer_path(book: Book, runs, target: str) -> None:
    """Interim timer-path evidence from runs other than the backfill experiment (smoke, failure recovery)."""
    smoke = db.latest_run(runs, "smoke", target)
    failure = db.latest_run(runs, "failure-recovery", target)
    book.section("timerpath", f"Timer-path relays seen outside the backfill experiment ({target})", "smoke and failure-recovery runs missing",
                 [rel(r.path) for r in (smoke, failure) if r] or ["none"])
    samples = [s for s in ((smoke.meta.get("expiryBackfillLatencyMs") or []) if smoke else []) if s is not None]
    raw = db.read_csv(failure.path / "raw.csv", book.notes) if failure else None
    if raw is not None and {"fault", "effect"}.issubset(raw.columns):
        for effect in raw.loc[raw["fault"] == "TIMER_SEND", "effect"].fillna("").astype(str):
            match = re.search(r"EXPIRED backfill relayed to \w+ after (\d+) ms", effect)
            if match:
                samples.append(int(match.group(1)))
    have = bool(smoke or failure)
    book.num("TimerPathRelaysN", len(samples) if have else None, 0, "smoke meta.json expiryBackfillLatencyMs + failure-recovery raw.csv TIMER_SEND effect", "expiry relays through the timer path")
    book.num("TimerPathRelayMaxMs", max(samples) if samples else None, 0, "same samples (max)", "largest timer-path relay latency, releasedAt = expiresAt (ms)")
    cancel = None
    checks = db.read_csv(smoke.path / "checks.csv", book.notes) if smoke else None
    if checks is not None and {"step", "actual"}.issubset(checks.columns):
        for actual in checks.loc[checks["step"].astype(str).str.contains("CANCELLED_CONFIRMED"), "actual"].astype(str):
            values = [int(v) for v in re.findall(r'"latencyMs":\s*(\d+)', actual)]
            if values:
                cancel = max(values) if cancel is None else max(cancel, *values)
    book.num("SmokeCancelBackfillMs", cancel, 0, src_of(smoke, "checks.csv", "step 'backfill CANCELLED_CONFIRMED', actual latencyMs"),
             "cancellation-driven relay latency in the smoke test (ms)")


EXPIRY_ORDERS = (
    ("TimerFirst", "timer tick processed before the ACCEPT arrived"),
    ("TimerWhileQueued", "timer tick processed while the ACCEPT was queued"),
    ("AcceptTickFirst", "the ACCEPT's own tick-first pass relayed the seat"),
)


def section_expiry_race(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "expiry-race", target, book.notes)
    book.section("expiry", f"Expiry race ({target})", f"expiry-race ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "ExpiryRace", run, "expiry-race")
    meta = run.meta if run else {}
    params = meta.get("params") or {}
    book.num("ExpiryRaceMarginMs", params.get("marginMs"), 0, src_of(run, "meta.json", "params.marginMs"), "ACCEPT offset from expiresAt (ms)")
    raw = db.read_csv(run.path / "raw.csv", book.notes) if run else None
    early = late = None
    if raw is not None and "variant" in raw.columns:
        early = raw[raw["variant"] == "early"]
        late = raw[raw["variant"] == "late"]
    count = lambda frame, mask: None if frame is None else int(mask(frame).sum())  # noqa: E731
    book.num("ExpiryRaceEarlyAttempts", None if early is None else len(early), 0, src_of(run, "raw.csv", "variant = early (rows)"), "early ACCEPT attempts")
    book.num("ExpiryRaceEarlyApplied", count(early, lambda f: f["verdict"].eq("PASS")), 0, src_of(run, "raw.csv", "variant = early, verdict = PASS"), "early ACCEPTs applied")
    book.num("ExpiryRaceEarlyInconclusive", count(early, lambda f: f["verdict"].eq("INCONCLUSIVE")), 0, src_of(run, "raw.csv", "variant = early, verdict = INCONCLUSIVE"), "early ACCEPTs delayed past expiresAt by the queue (repeated)")
    arrived_late = None
    if early is not None and "arrivalOffsetMs" in early.columns:
        arrived_late = sum(1 for v in (to_float(x) for x in early["arrivalOffsetMs"].tolist()) if v is not None and v > 0)
    book.num("ExpiryRaceEarlyArrivedLate", arrived_late, 0, src_of(run, "raw.csv", "variant = early, arrivalOffsetMs > 0 (acceptedAt after expiresAt)"),
             "early ACCEPTs that reached the API after expiresAt (client send timing)")
    book.num("ExpiryRaceLateTrials", None if late is None else len(late), 0, src_of(run, "raw.csv", "variant = late (rows)"), "late ACCEPT trials")
    book.num("ExpiryRaceLateRejected", count(late, lambda f: f["status"].eq("REJECTED") & f["reason"].eq("OFFER_EXPIRED")), 0,
             src_of(run, "raw.csv", "variant = late, status REJECTED, reason OFFER_EXPIRED"), "late ACCEPTs rejected OFFER_EXPIRED")
    for suffix, label in EXPIRY_ORDERS:
        value = None
        if late is not None and "order" in late.columns:
            value = int(late["order"].astype(str).str.startswith(label[:30]).sum())
        book.num(f"ExpiryRaceOrder{suffix}", value, 0, src_of(run, "raw.csv", f"variant = late, order = '{label}'"), f"late trials where the {label}")
    ticks = db.read_csv(run.path / "late-tick.csv", book.notes) if run else None
    book.num("ExpiryRaceLateTicks", meta.get("lateTicks"), 0, src_of(run, "meta.json", "lateTicks"), "stale TICKs injected")
    no_effect = None
    if ticks is not None and "ok" in ticks.columns:
        no_effect = int(ticks["ok"].astype(str).str.lower().eq("true").sum())
    book.num("ExpiryRaceLateTicksNoEffect", no_effect, 0, src_of(run, "late-tick.csv", "ok = true"), "stale TICKs without any effect",
             reason=None if not run else "late-tick.csv missing (late TICK not injected on this target)")


FAULTS = ("BEFORE_COMMIT", "AFTER_COMMIT", "TIMER_SEND")


def section_failure(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "failure-recovery", target, book.notes)
    book.section("failure", f"Failure recovery ({target})", f"failure-recovery ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "Failure", run, "failure-recovery")
    raw = db.read_csv(run.path / "raw.csv", book.notes) if run else None
    for fault in FAULTS:
        prefix = f"Failure{camel(fault.lower())}"
        rows = raw[raw["fault"] == fault] if raw is not None and "fault" in raw.columns else None
        book.num(f"{prefix}Cases", None if rows is None else len(rows), 0, src_of(run, "raw.csv", f"fault = {fault} (rows)"), f"{fault} cases")
        passed = None if rows is None else int(rows["ok"].astype(str).str.lower().eq("true").sum())
        book.num(f"{prefix}Passed", passed, 0, src_of(run, "raw.csv", f"fault = {fault}, ok = true"), f"{fault} cases recovered exactly once")
        settle = [] if rows is None or "serverSettleMs" not in rows.columns else rows["serverSettleMs"].tolist()
        book.num(f"{prefix}SettleMedianS", db.median(settle) / 1000 if settle and not math.isnan(db.median(settle)) else None, 1,
                 src_of(run, "raw.csv", f"fault = {fault}, serverSettleMs (median)"), f"{fault}: median server settle incl. redelivery (s)")
        deliveries = [] if rows is None or "deliveries" not in rows.columns else [to_float(v) for v in rows["deliveries"].tolist()]
        deliveries = [v for v in deliveries if v is not None]
        book.num(f"{prefix}DeliveriesMin", min(deliveries) if deliveries else None, 0, src_of(run, "raw.csv", f"fault = {fault}, deliveries (min)"), f"{fault}: fewest deliveries observed")
    notifier = db.read_csv(run.path / "notifier.csv", book.notes) if run else None
    for phase, prefix, desc in (("outage", "FailureNotifierOutage", "after the restore"), ("baseline", "FailureNotifierBaseline", "after settlement, no outage")):
        rows = notifier[notifier["phase"] == phase] if notifier is not None and "phase" in notifier.columns else None
        values = [] if rows is None else [v for v in (to_float(x) for x in rows["recoverySeconds"].tolist()) if v is not None]
        reason = None if not run else f"no notifier {phase} rows on this target"
        book.num(f"{prefix}MaxS", max(values) if values else None, 0, src_of(run, "notifier.csv", f"phase = {phase}, recoverySeconds (max)"), f"notifier backlog drained {desc} (s, worst run)", reason)
        book.num(f"{prefix}Runs", len(values) if values else None, 0, src_of(run, "notifier.csv", f"phase = {phase} (rows)"), f"notifier {phase} runs", reason)
        notes = [] if rows is None else [v for v in (to_float(x) for x in rows["notifications"].tolist()) if v is not None]
        book.num(f"{prefix}Notifications", max(notes) if notes else None, 0, src_of(run, "notifier.csv", f"phase = {phase}, notifications"), f"notifications per {phase} run", reason)
        for column, name in (("sent", "Sent"), ("skipped", "Skipped"), ("failed", "Failed")):
            values = [] if rows is None or column not in rows.columns else [v for v in (to_float(x) for x in rows[column].tolist()) if v is not None]
            book.num(f"{prefix}{name}", sum(values) if values else None, 0, src_of(run, "notifier.csv", f"phase = {phase}, {column} (sum over runs)"),
                     f"notifications {column} in the {phase} runs (SKIPPED: e-mail disabled on the stage)", reason)
    # EXPIRED backfills relayed through the timer path inside the TIMER_SEND cases (effect column)
    relays = []
    rows = raw[raw["fault"] == "TIMER_SEND"] if raw is not None and {"fault", "effect"}.issubset(raw.columns) else None
    for effect in ([] if rows is None else rows["effect"].fillna("").astype(str)):
        match = re.search(r"EXPIRED backfill relayed to \w+ after (\d+) ms", effect)
        if match:
            relays.append(int(match.group(1)))
    book.num("FailureTimerRelayN", len(relays) if rows is not None else None, 0, src_of(run, "raw.csv", "fault = TIMER_SEND, effect 'EXPIRED backfill relayed ... after <n> ms' (count)"),
             "expiry relays through the timer path observed in the TIMER_SEND cases")
    book.num("FailureTimerRelayMaxMs", max(relays) if relays else None, 0, src_of(run, "raw.csv", "fault = TIMER_SEND, effect 'relayed ... after <n> ms' (max)"),
             "largest of those relay latencies (ms)")
    checks = db.read_csv(run.path / "checks.csv", book.notes) if run else None
    dlq = None
    if checks is not None and {"step", "actual"}.issubset(checks.columns):
        label = (checks["scenario"].astype(str) if "scenario" in checks.columns else checks["step"].astype(str)).str.strip()
        rows = checks[label.eq("dead letters") | checks["step"].astype(str).str.contains("dead-lettered", regex=False)]
        values = [to_float(str(a).split()[0]) for a in rows["actual"].tolist()] if len(rows) else []
        dlq = max(values) if values and all(v is not None for v in values) else None
    book.num("FailureDeadLetters", dlq, 0, src_of(run, "checks.csv", "step 'dead letters', actual (max over runs)"), "messages in the DLQs after the run")


def section_access(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "access-control", target, book.notes)
    book.section("access", f"Access control ({target})", f"access-control ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "Access", run, "access-control")
    meta = run.meta if run else {}
    book.num("AccessProbes", meta.get("probes"), 0, src_of(run, "meta.json", "probes"), "negative probes")
    book.num("AccessProbesPassed", meta.get("passed"), 0, src_of(run, "meta.json", "passed"), "probes answered as expected")
    raw = db.read_csv(run.path / "raw.csv", book.notes) if run else None
    groups = raw["group"].nunique() if raw is not None and "group" in raw.columns else None
    book.num("AccessProbeGroups", groups, 0, src_of(run, "raw.csv", "group (distinct)"), "probe groups")
    for status in ("401", "403", "404"):
        value = None
        if raw is not None and "expected" in raw.columns:
            value = int(raw["expected"].astype(str).str.startswith(status).sum())
        book.num(f"AccessExpected{words(int(status))}", value, 0, src_of(run, "raw.csv", f"expected starts with {status}"), f"probes expecting HTTP {status}")


def section_backfill(book: Book, runs, target: str) -> None:
    run = db.latest_run(runs, "backfill", target, book.notes)
    book.section("backfill", f"Backfill latency ({target})", f"backfill ({target}) not yet run", [run.describe() if run else "none"])
    run_header(book, "Backfill", run, "backfill")
    meta = run.meta if run else {}
    book.num("BackfillHoldSeconds", meta.get("holdSeconds"), 0, src_of(run, "meta.json", "holdSeconds"), "holdSeconds of the experiment workshops")
    raw = db.read_csv(run.path / "raw.csv", book.notes) if run else None
    expired = cancelled = None
    if raw is not None and {"cause", "latencyMs"}.issubset(raw.columns):
        expired = raw[raw["cause"] == "EXPIRED"]
        cancelled = raw[raw["cause"].astype(str).str.startswith("CANCELLED")]
    relayed = expired[expired["reallocatedAt"].fillna("").astype(str).str.len() > 0] if expired is not None and "reallocatedAt" in expired.columns else expired
    pooled(book, "BackfillExpired", [] if relayed is None else relayed["latencyMs"].tolist(),
           src_of(run, "raw.csv", "cause = EXPIRED, reallocatedAt set, latencyMs (pooled over runs, nearest rank)"),
           "expiry-driven backfill latency reallocatedAt - releasedAt", seconds=True)
    unrelayed = None if expired is None or relayed is None else len(expired) - len(relayed)
    book.num("BackfillExpiredUnrelayed", unrelayed, 0, src_of(run, "raw.csv", "cause = EXPIRED without reallocatedAt"), "expired offers never relayed")
    cancel_values = [] if cancelled is None else [v for v in (to_float(x) for x in cancelled["latencyMs"].tolist()) if v is not None]
    book.num("BackfillCancelN", len(cancel_values) if cancelled is not None else None, 0, src_of(run, "raw.csv", "cause = CANCELLED_* (rows)"), "cancellation-driven backfills")
    book.num("BackfillCancelMaxMs", max(cancel_values) if cancel_values else None, 0, src_of(run, "raw.csv", "cause = CANCELLED_*, latencyMs (max)"), "cancellation-driven backfill latency, largest (ms)")
    book.num("BackfillOutliers", meta.get("outliers"), 0, src_of(run, "meta.json", "outliers"), "samples above max(outlier threshold, p95)")
    book.num("BackfillSweepLateExpiries", meta.get("sweepLateExpiries"), 0, src_of(run, "meta.json", "sweepLateExpiries"), "SweepLateExpiries in the run window",
             reason=None if not run else "SweepLateExpiries not fetched (CloudWatch read skipped)")


PERF_METRICS = (
    ("ReadPNinetyFiveMs", "readP95", "median", 0, "read p95 (GET /workshops), median of rounds (ms)"),
    ("AcceptPNinetyFiveMs", "commandP95", "median", 0, "202 response p95 (POST commands), median of rounds (ms)"),
    ("SettlePNinetyFiveMs", "settleP95", "median", 0, "client-observed settle p95, median of rounds (ms)"),
    ("ServerSettlePNinetyFiveMs", "serverSettleP95", "median", 0, "server settle p95 (settledAt - acceptedAt), median of rounds (ms)"),
    ("CloudWatchSettlePNinetyFiveMs", "cwSettleP95", "median", 0, "CloudWatch CommandSettledLatency p95, median of rounds (ms)"),
    ("ErrorPct", "httpReqFailedRate", "max", 2, "HTTP error rate, worst round (%)"),
    ("QueueAgeMaxS", "sqsOldestAgeMax", "max", 0, "oldest message age on commands.fifo, worst round (s)"),
    ("Rounds", None, "count", 0, "rounds aggregated"),
)
PERF_DEFAULT = [(t, s, v) for t in ("dev", "local") for s in ("cross-workshop", "hotspot") for v in (10, 25, 50)]
SCENARIO_NAMES = {"cross-workshop": "Cross", "hotspot": "Hotspot"}


def section_loadtest(book: Book, results: Path) -> None:
    date_dir = db.latest_dir(results / "loadtest", "*", must_contain="raw.csv")
    book.section("perf", "Performance: k6 matrix", "k6 load-test matrix not yet run", [rel(date_dir) if date_dir else "none"])
    frame = db.read_csv(date_dir / "raw.csv", book.notes) if date_dir else None
    if frame is not None and not {"target", "scenario", "vus"}.issubset(frame.columns):
        book.notes.append(f"{rel(date_dir / 'raw.csv')}: no target/scenario/vus columns, ignored")
        frame = None
    frame = db.loadtest_active(frame)
    src = f"{rel(date_dir)}/raw.csv" if date_dir else "results/loadtest/<date>/raw.csv"
    book.num("PerfRoundsPerLevel", db.LOADTEST_ROUNDS, 0, "report/tools/resultsdb.py: LOADTEST_ROUNDS (tools/loadtest run-matrix default)",
             "rounds per VU level required before a level is quoted")
    book.text("PerfDate", date_dir.name if date_dir else None, f"{src}: directory name", "date of the load-test matrix")
    commits = sorted({str(c)[:7] for c in frame["commit"].dropna()}) if frame is not None and "commit" in frame.columns else []
    book.text("PerfCommit", ", ".join(commits) if commits else None, f"{src}: commit", "commit(s) under test")
    for target in ("dev", "local"):
        done = sum(1 for s, v in db.LOADTEST_LEVELS if db.loadtest_rounds(frame, target, s, v) >= db.LOADTEST_ROUNDS) if frame is not None else 0
        book.num(f"Perf{camel(target)}LevelsComplete", done if frame is not None else None, 0, f"{src}: levels with {db.LOADTEST_ROUNDS} active rounds",
                 f"{target}: VU levels of the matrix with all rounds recorded")
        book.text(f"Perf{camel(target)}MatrixComplete", "complete" if frame is not None and done == len(db.LOADTEST_LEVELS) else None,
                  f"{src}: every scenario x VU level has {db.LOADTEST_ROUNDS} active rounds", f"{target}: k6 matrix complete",
                  f"k6 matrix ({target}): {done} of {len(db.LOADTEST_LEVELS)} levels have all {db.LOADTEST_ROUNDS} rounds")
    combos = list(PERF_DEFAULT)
    measured = {}  # (target, scenario, vus) -> {suffix: value} for levels with all rounds
    if frame is not None:
        for key in frame[["target", "scenario", "vus"]].drop_duplicates().itertuples(index=False):
            item = (str(key.target), str(key.scenario), int(key.vus))
            if item not in combos:
                combos.append(item)
    for target, scenario, vus in combos:
        rows = None
        if frame is not None:
            rows = frame[(frame["target"].astype(str) == target) & (frame["scenario"].astype(str) == scenario) & (frame["vus"] == vus)]
            if rows.empty:
                rows = None
        name = f"Perf{camel(target)}{SCENARIO_NAMES.get(scenario, camel(scenario))}VU{words(vus)}"
        have = 0 if rows is None else len(rows)
        # A level is quoted only once all its rounds exist: a median over the rounds finished so far
        # would print under a caption that promises the median of all rounds.
        complete = have >= db.LOADTEST_ROUNDS
        reason = (f"k6 {scenario} at {vus} VUs on {target} not yet run" if not have else
                  f"k6 {scenario} at {vus} VUs on {target}: {have} of {db.LOADTEST_ROUNDS} rounds recorded")
        timeouts = [] if rows is None or "settleTimeouts" not in rows.columns else [to_float(x) or 0 for x in rows["settleTimeouts"].tolist()]
        for suffix, column, how, digits, desc in PERF_METRICS:
            value = None
            why = reason if not complete else f"k6 {scenario} at {vus} VUs on {target}: {column} not recorded"
            if rows is not None and (complete or how == "count"):
                if how == "count":
                    value = len(rows)
                elif column in rows.columns:
                    numbers = [to_float(x) for x in rows[column].tolist()]
                    # A settle p95 of 0 (or empty) with settle timeouts in the same round means that no
                    # command settled within the client's budget: the round's p95 is above the budget,
                    # not zero. It enters the median as +infinity (right-censored), so the median is
                    # the middle of the measured rounds only when at most one round is censored.
                    if column in ("settleP95", "serverSettleP95"):
                        numbers = [math.inf if (n is None or n <= 0) and t > 0 else n
                                   for n, t in zip(numbers, timeouts or [0] * len(numbers))]
                    numbers = [v for v in numbers if v is not None]
                    if numbers:
                        value = db.median(numbers) if how == "median" else max(numbers)
                        if suffix == "ErrorPct":
                            value *= 100
                        if value is not None and math.isinf(value):
                            value = None
                            why = f"k6 {scenario} at {vus} VUs on {target}: settle p95 above the client budget in most rounds"
            book.num(f"{name}{suffix}", value, digits, f"{src}: target={target}, scenario={scenario}, vus={vus}, {column or 'rows'} ({how} over active rounds; quoted once {db.LOADTEST_ROUNDS} rounds exist)",
                     f"{target} {scenario} {vus} VUs: {desc}", why)
            if complete:
                measured.setdefault((target, scenario, vus), {})[suffix] = value
        unsettled = None
        if rows is not None and complete and "settleP95" in rows.columns:
            unsettled = sum(1 for n, t in zip((to_float(x) for x in rows["settleP95"].tolist()), timeouts or [0] * len(rows))
                            if (n is None or n <= 0) and t > 0)
        book.num(f"{name}UnsettledRounds", unsettled, 0, f"{src}: target={target}, scenario={scenario}, vus={vus}, rounds with settleP95 = 0 and settleTimeouts > 0",
                 f"{target} {scenario} {vus} VUs: rounds in which no command settled within the client budget (counted as +inf in the median)", reason)
    # Verdict per target against plan §4 Performance: reads and 202 p95 < 1 s, settle p95 < 5 s
    # (client and server), HTTP errors < 1 % (worst round). A level whose settle p95 is censored
    # (value None after all rounds exist) counts as not met.
    def level_met(values: dict) -> bool:
        limits = (("ReadPNinetyFiveMs", 1000), ("AcceptPNinetyFiveMs", 1000), ("SettlePNinetyFiveMs", 5000),
                  ("ServerSettlePNinetyFiveMs", 5000), ("ErrorPct", 1.0))
        return all(values.get(key) is not None and float(values[key]) < limit for key, limit in limits)

    for target in ("dev", "local"):
        levels = [(s, v) for s, v in db.LOADTEST_LEVELS]
        have_all = all((target, s, v) in measured for s, v in levels)
        met = {(s, v): level_met(measured[(target, s, v)]) for s, v in levels if (target, s, v) in measured}
        reason = f"k6 matrix ({target}) not complete"
        tsrc = f"{src}: target={target}, every scenario x VU level (medians of the rounds, errors = worst round)"
        book.text(f"Perf{camel(target)}Verdict", ("PASS" if all(met.values()) else "FAIL") if have_all else None, tsrc,
                  f"{target}: PASS if every level meets reads/202 p95 < 1 s, settle p95 < 5 s (client and server) and errors < 1 %", reason)
        book.num(f"Perf{camel(target)}LevelsMet", sum(met.values()) if have_all else None, 0, tsrc, f"{target}: levels that meet every Performance target", reason)
        book.num(f"Perf{camel(target)}Levels", len(levels) if have_all else None, 0, tsrc, f"{target}: levels in the matrix", reason)
        # largest VU count at which both scenarios meet every target (0 if none)
        ok_vus = [v for v in sorted({v for _, v in levels}) if all(met.get((s, v)) for s, _ in levels if _ == v)]
        top = 0
        for v in sorted({v for _, v in levels}):
            if v in ok_vus:
                top = v
            else:
                break
        book.num(f"Perf{camel(target)}MaxVUsMet", top if have_all else None, 0, tsrc,
                 f"{target}: largest VU level up to which both scenarios meet every target", reason)
    stats = db.read_csv(date_dir / "docker-stats.csv", book.notes) if date_dir else None
    cpu = mem = None
    # Quoted only once the local matrix is complete: the peak over a partial matrix would understate it.
    local_done = frame is not None and db.loadtest_complete(frame, "local")
    if local_done and stats is not None and {"ts", "cpuPercent", "memUsageMiB"}.issubset(stats.columns):
        per_ts = stats.groupby("ts")[["cpuPercent", "memUsageMiB"]].sum()
        cpu, mem = float(per_ts["cpuPercent"].max()), float(per_ts["memUsageMiB"].max())
    reason = ("docker-stats.csv (local k6 matrix) not yet recorded" if stats is None
              else "local k6 matrix not yet complete (docker-stats peak quoted once every level has all rounds)")
    dsrc = f"{rel(date_dir)}/docker-stats.csv" if date_dir else "results/loadtest/<date>/docker-stats.csv"
    book.num("PerfLocalCpuPeakPct", cpu, 0, f"{dsrc}: cpuPercent summed over containers per sample (max)", "on-prem stack peak CPU (% of one core)", reason)
    book.num("PerfLocalMemPeakMiB", mem, 0, f"{dsrc}: memUsageMiB summed over containers per sample (max)", "on-prem stack peak memory (MiB)", reason)


# ----------------------------------------------------------------------------- cost

COST_TIERS = {"1,000": "OneK", "10,000": "TenK", "100,000": "HundredK"}
COST_T1 = {
    "cloud: list price": "CloudList",
    "cloud: after free tier": "CloudAfterFree",
    "cloud: after credits": "CloudAfterCredits",
    "on-prem: increment only (3-yr)": "OnpremIncrementThreeYear",
    "on-prem: increment only (4-yr)": "OnpremIncrementFourYear",
    "on-prem: fully amortised (3-yr)": "OnpremFullThreeYear",
    "on-prem: fully amortised (4-yr)": "OnpremFullFourYear",
}
COST_T2 = {
    "cloud: list": "CloudList",
    "cloud: after free tier": "CloudAfterFree",
    "on-prem: increment only": "OnpremIncrement",
    "on-prem: fully amortised": "OnpremFull",
}
COST_LAYER = {"cloud_list": "List", "cloud_after_free": "AfterFree"}
COST_VIEW = {"onprem_increment": "Increment", "onprem_full": "Full"}


def find_table(tables, first_header: str):
    for table in tables:
        if table and first_header in table[0]:
            return table
    return None


def section_cost(book: Book, results: Path) -> None:
    cost = results / "cost"
    summary = cost / "model-summary.md"
    book.section("cost", "Cost model (cloud three layers vs on-prem)", "cost model output not yet generated", [rel(summary) if summary.exists() else "none"])
    text = summary.read_text(encoding="utf-8") if summary.exists() else ""
    tables = db.markdown_tables(text)
    src = rel(summary) if summary.exists() else "results/cost/model-summary.md"
    date = re.search(r"retrieved (\d{4}-\d{2}-\d{2})", text)
    book.text("CostPricingDate", date.group(1) if date else None, f"{src}: header 'retrieved <date>'", "date the unit prices were retrieved")
    years = re.search(r'"amortisation_years":\s*(\d+)', text)
    book.num("CostAmortisationYears", years.group(1) if years else None, 0, f"{src}: options amortisation_years", "on-prem amortisation period used for unit cost and crossover (years)")
    verified = re.search(r"(\d+) of (\d+) unit prices were read from the AWS Price List API", text)
    book.num("CostPricesVerified", verified.group(1) if verified else None, 0, f"{src}: section 8", "unit prices verified from the AWS Price List API")
    book.num("CostPricesTotal", verified.group(2) if verified else None, 0, f"{src}: section 8", "unit prices in the model")
    used = re.search(r"Dimensions priced per tier \(section 5\): (\d+) of the (\d+)", text)
    book.num("CostDimensionsUsed", used.group(1) if used else None, 0, f"{src}: section 8 'Dimensions priced per tier'", "billable dimensions priced per tier (the stacks' usage)")
    inputs = find_table(tables, "input")
    onprem_inputs = {
        "server price (S$, incl. GST)": ("CostOnpremServerPriceSgd", 2),
        "server capacity (registrations/month)": ("CostOnpremCapacityRegs", 0),
        "power at load (W)": ("CostOnpremLoadWatts", 1),
        "electricity tariff (S cents/kWh, incl. GST)": ("CostOnpremTariffCents", 2),
        "business fibre line (S$/month)": ("CostOnpremLineSgd", 0),
        "off-site backup (US$/GB-month)": ("CostOnpremBackupUsdPerGb", 5),
        "operations labour (hours/month)": ("CostOnpremLabourHours", 0),
        "labour rate (S$/hour)": ("CostOnpremLabourRateSgd", 0),
        "exchange rate (S$ per US$)": ("CostFxSgdPerUsd", 2),
    }
    for label, (macro, digits) in onprem_inputs.items():
        row = next((r for r in (inputs or []) if r.get("input") == label), None)
        book.num(macro, row.get("value") if row else None, digits, f"{src}: section 9, '{label}'", f"on-prem input: {label}")

    t1 = find_table(tables, "cloud: after credits")
    for tier_label, tier in COST_TIERS.items():
        row = next((r for r in (t1 or []) if r.get("registrations/month") == tier_label), None)
        for column, name in COST_T1.items():
            value = row.get(column) if row else None
            book.raw(f"CostTier{tier}{name}Usd", summary_number(value) if value else None,
                     f"{src}: section 1, row {tier_label}, column '{column}'", f"monthly cost at {tier_label} registrations/month, {column} (USD)")
    t2 = find_table(tables, "on-prem: increment only")
    t2 = t2 if t2 and "cloud: list" in t2[0] else None
    for tier_label, tier in COST_TIERS.items():
        row = next((r for r in (t2 or []) if r.get("registrations/month") == tier_label), None)
        for column, name in COST_T2.items():
            value = row.get(column) if row else None
            book.raw(f"CostUnit{tier}{name}Usd", summary_number(value) if value else None,
                     f"{src}: section 2, row {tier_label}, column '{column}'", f"cost per 1,000 registrations at {tier_label}/month, {column} (USD)")
    t3 = find_table(tables, "crossover_registrations")
    for layer, lname in COST_LAYER.items():
        for view, vname in COST_VIEW.items():
            row = next((r for r in (t3 or []) if r.get("cloud_layer") == layer and r.get("onprem_view") == view), None)
            regs = row.get("crossover_registrations") if row else None
            usd = row.get("usd_per_month_at_crossover") if row else None
            book.raw(f"CostCrossover{lname}{vname}Regs", summary_number(regs) if regs and to_float(regs) is not None else None,
                     f"{src}: section 3, {layer} vs {view}, crossover_registrations", f"registrations/month where cloud ({layer}) exceeds on-prem ({view})")
            book.raw(f"CostCrossover{lname}{vname}Usd", summary_number(usd) if usd and to_float(usd) is not None else None,
                     f"{src}: section 3, {layer} vs {view}, usd_per_month_at_crossover", f"monthly cost at that crossover (USD)")
    t4 = find_table(tables, "service")
    for row in t4 or []:
        service = row.get("service", "")
        for tier_label, tier in COST_TIERS.items():
            cell = row.get(f"{tier_label}/mo", "")
            parts = [p.strip() for p in cell.split("->")]
            if len(parts) != 2:
                continue
            base = f"CostSvc{camel(service)}{tier}"
            book.raw(f"{base}ListUsd", summary_number(parts[0]), f"{src}: section 4, {service}, {tier_label}/mo (list)", f"{service} at {tier_label}/month, list price (USD)")
            book.raw(f"{base}AfterFreeUsd", summary_number(parts[1]), f"{src}: section 4, {service}, {tier_label}/mo (after free tier)", f"{service} at {tier_label}/month, after free tier (USD)")
    t6 = find_table(tables, "labour")
    for row in t6 or []:
        if row.get("years") != "3":
            continue
        tier = COST_TIERS.get(row.get("registrations/month", ""))
        view = {"increment only": "Increment", "fully amortised": "Full"}.get(row.get("view", ""))
        if not tier or not view:
            continue
        for column in ("hardware", "electricity", "network", "backup (off-site)", "e-mail", "labour", "total"):
            value = row.get(column)
            if value:
                book.raw(f"CostOnprem{tier}{view}{camel(column.replace('(off-site)', ''))}Usd", summary_number(value),
                         f"{src}: section 6, {row['registrations/month']} / {row['view']} / 3 years, column '{column}'", f"on-prem {row['view']} at {row['registrations/month']}/month: {column} (USD/month)")
    assumptions = re.search(r"## 7\. Workload assumptions used\s+```json\s+(\{.*?\})\s+```", text, re.S)
    if assumptions:
        import json
        data = json.loads(assumptions.group(1))
        for key, value in data.items():
            compact = f"{float(value):,.3f}".rstrip("0").rstrip(".")
            book.raw(f"CostAssume{camel(key)}", summary_number(compact), f"{src}: section 7, {key}", f"workload assumption {key}")
    # measured usage (cost-snapshot.sh + model.py --from-snapshot)
    usage = cost / "usage-priced.md"
    utext = usage.read_text(encoding="utf-8") if usage.exists() else ""
    reason = "measured usage not yet priced (cost-snapshot.sh, then model.py --from-snapshot)"
    usrc = rel(usage) if usage.exists() else "results/cost/usage-priced.md"
    m = re.search(r"List price: \*\*US\$([\d,\.]+)\*\*; after free tier: \*\*US\$([\d,\.]+)\*\*", utext)
    book.raw("CostMeasuredListUsd", summary_number(m.group(1)) if m else None, f"{usrc}: 'List price'", "measured usage priced at list price (USD)", reason)
    book.raw("CostMeasuredAfterFreeUsd", summary_number(m.group(2)) if m else None, f"{usrc}: 'after free tier'", "measured usage after free tier (USD)", reason)
    snap = re.search(r"# Measured usage priced \(([^)]*)\)", utext)
    snap_date = re.search(r"(\d{4}-\d{2}-\d{2})", snap.group(1)) if snap else None
    book.text("CostMeasuredSnapshotDate", snap_date.group(1) if snap_date else None, f"{usrc}: header (snapshot file name)", "date of the cost snapshot", reason)
    u = re.search(r"Unit cost: US\$([\d,\.]+) per 1,000 registrations \(list\), US\$([\d,\.]+) \(after free tier\) for ([\d,]+) registrations", utext)
    book.raw("CostMeasuredUnitListUsd", summary_number(u.group(1)) if u else None, f"{usrc}: 'Unit cost'", "measured cost per 1,000 registrations, list (USD)", reason)
    book.raw("CostMeasuredUnitAfterFreeUsd", summary_number(u.group(2)) if u else None, f"{usrc}: 'Unit cost'", "measured cost per 1,000 registrations, after free tier (USD)", reason)
    book.raw("CostMeasuredRegistrations", summary_number(u.group(3)) if u else None, f"{usrc}: 'Unit cost ... for N registrations'", "registrations in the measured period", reason)


# ----------------------------------------------------------------------------- replay

REPLAY_METRICS = {
    "Distinct participants served": "Distinct",
    "Fill rate": "FillRate",
    "Seats wasted at cut-off": "SeatsWasted",
    "Duplicate confirmed seats at the end": "DupConfirmed",
    "Duplicate-hold events": "DupHoldEvents",
    "Duplicate holds: peak users": "DupHoldPeakUsers",
    "Duplicate holds: extra seat-hours": "DupHoldSeatHours",
    "Seat refill time, per-run mean": "RefillMean",
    "Seat refill time, per-run p50": "RefillPFifty",
    "Seat refill time, per-run p95": "RefillPNinetyFive",
    "Seat releases with a confirmed refill": "RefillReleases",
    "Seat releases never refilled": "RefillCensored",
    "Backfill relay latency (reallocatedAt": "RelayMeanMs",
    "Backfill relay latency, p50": "RelayPFiftyMs",
    "Backfill relay latency, p95": "RelayPNinetyFiveMs",
    "Backfills relayed": "BackfillsRelayed",
    "Releases with nobody waiting": "ReleasesUnrelayed",
    "Seat releases (expiry, decline, cancel)": "SeatReleases",
    "Offers created": "OffersCreated",
    "Offers accepted": "OffersAccepted",
    "Offers declined": "OffersDeclined",
    "Offers expired": "OffersExpired",
    "Offers revoked": "OffersRevoked",
    "Registrations cancelled by participants": "Cancellations",
    "Registrations ended at cut-off": "EndedCutoff",
    "Confirmed seats at the end": "ConfirmedSeats",
    "Registrations accepted by the engine": "Registrations",
    "Participants": "Participants",
    "Engine decisions": "Decisions",
    "Rejected commands": "Rejected",
    "Invariant violations": "InvariantViolations",
}
CI_CELL = re.compile(r"^\s*(-?[\d,\.]+)\s*\[\s*(-?[\d,\.]+)\s*,\s*(-?[\d,\.]+)\s*\]\s*$")


def replay_metric_name(label: str) -> str | None:
    for prefix, name in REPLAY_METRICS.items():
        if label.startswith(prefix):
            return name
    return None


def section_replay(book: Book, runs, results: Path) -> None:
    dated = sorted((r for r in runs.get("replay", []) if (r.path / "summary.md").exists()), key=lambda r: (r.date, r.suffix), reverse=True)
    directory = dated[0].path if dated else (results / "replay" if (results / "replay" / "summary.md").exists() else None)
    book.section("replay", "Mechanism comparison (replay, UNIFIED vs PER_SESSION)", "mechanism replay not yet run", [rel(directory) if directory else "none"])
    text = (directory / "summary.md").read_text(encoding="utf-8") if directory else ""
    src = f"{rel(directory)}/summary.md" if directory else "results/replay/summary.md"
    head = re.search(r"on (\d{4}-\d{2}-\d{2})T[\d:\.]+Z: seeds (\d+)\D(\d+) \((\d+) scenarios", text)
    book.text("ReplayDate", head.group(1) if head else None, f"{src}: header 'Generated ... on'", "date of the replay run")
    book.num("ReplaySeeds", head.group(4) if head else None, 0, f"{src}: header 'N scenarios'", "seeds (scenarios), each replayed in both modes")
    boot = re.search(r"percentile bootstraps of the mean \((\d+) resamples", text)
    book.num("ReplayBootstrapResamples", boot.group(1) if boot else None, 0, f"{src}: header 'bootstraps ... (N resamples'", "bootstrap resamples for the 95% CIs")

    tables = db.markdown_tables(text)
    metrics = None
    for table in tables:
        if table and "metric" in table[0] and len(table) > (len(metrics) if metrics else 0):
            metrics = table
    seen = set()
    for row in metrics or []:
        label = row.get("metric", "")
        name = replay_metric_name(label)
        if not name or name in seen:
            continue
        seen.add(name)
        delta_key = next((k for k in row if k.startswith("\u0394")), "")
        cells = {
            "Unified": row.get("UNIFIED mean [95% CI]", ""),
            "PerSession": row.get("PER_SESSION mean [95% CI]", ""),
            "Delta": row.get(delta_key, ""),
        }
        for mode, cell in cells.items():
            match = CI_CELL.match(cell)
            what = {"Unified": "UNIFIED", "PerSession": "PER_SESSION", "Delta": "paired difference PER_SESSION - UNIFIED"}[mode]
            for part, index in (("Mean", 1), ("Lo", 2), ("Hi", 3)):
                book.raw(f"Replay{name}{mode}{part}", summary_number(match.group(index)) if match else None,
                         f"{src}: 'All metrics', row '{label}', {what} {'mean' if part == 'Mean' else '95% CI ' + ('low' if part == 'Lo' else 'high')}",
                         f"{label}: {what} {part.lower()}")
        for mode, column in (("Unified", "UNIFIED median"), ("PerSession", "PER_SESSION median")):
            value = row.get(column, "")
            book.raw(f"Replay{name}{mode}Median", summary_number(value) if to_float(value) is not None else None,
                     f"{src}: 'All metrics', row '{label}', {column}", f"{label}: {column}")
        book.raw(f"Replay{name}N", summary_number(row.get("n", "")) if to_float(row.get("n")) is not None else None,
                 f"{src}: 'All metrics', row '{label}', n", f"{label}: seeds in the paired comparison")
    for name in REPLAY_METRICS.values():
        if name not in seen:
            for suffix in ("UnifiedMean", "UnifiedLo", "UnifiedHi", "PerSessionMean", "PerSessionLo", "PerSessionHi",
                           "DeltaMean", "DeltaLo", "DeltaHi", "UnifiedMedian", "PerSessionMedian", "N"):
                book.raw(f"Replay{name}{suffix}", None, f"{src}: 'All metrics'", f"{name} {suffix}")

    pooled_table = find_table(tables, "samples pooled over all runs")
    for row in pooled_table or []:
        label = row.get("samples pooled over all runs", "")
        kind = "Refill" if label.startswith("Seat refill") else ("Relay" if label.startswith("Backfill relay") else None)
        mode = {"UNIFIED": "Unified", "PER_SESSION": "PerSession"}.get(row.get("mode", ""))
        if not kind or not mode:
            continue
        base = f"ReplayPooled{kind}{mode}"
        match = CI_CELL.match(row.get("mean [95% CI]", ""))
        book.raw(f"{base}N", summary_number(row.get("n", "")), f"{src}: 'Pooled samples', {label}, {mode}, n", f"pooled {kind.lower()} samples")
        for part, index in (("Mean", 1), ("Lo", 2), ("Hi", 3)):
            book.raw(f"{base}{part}", summary_number(match.group(index)) if match else None, f"{src}: 'Pooled samples', {label}, {mode}, mean [95% CI]", f"pooled {kind.lower()} {part.lower()}")
        for part, column in (("PFifty", "p50"), ("PNinetyFive", "p95"), ("Max", "max")):
            book.raw(f"{base}{part}", summary_number(row.get(column, "")) if to_float(row.get(column)) is not None else None,
                     f"{src}: 'Pooled samples', {label}, {mode}, {column}", f"pooled {kind.lower()} {column}")

    ranges = re.search(r"Scenario ranges[^:]*:(.*)", text)
    line = ranges.group(1) if ranges else ""
    for name, pattern in (("Sessions", r"sessions (\d+(?:\.\d+)?)\u2013(\d+(?:\.\d+)?)"),
                          ("Oversubscription", r"oversubscription (\d+(?:\.\d+)?)\u2013(\d+(?:\.\d+)?)"),
                          ("HoldSeconds", r"holdSeconds (\d+(?:\.\d+)?)\u2013(\d+(?:\.\d+)?)")):
        match = re.search(pattern, line)
        for part, index in (("Min", 1), ("Max", 2)):
            book.raw(f"ReplayRange{name}{part}", summary_number(match.group(index)) if match else None,
                     f"{src}: header 'Scenario ranges', {name.lower()} ({part.lower()} of the configured uniform range)",
                     f"configured scenario range {name} ({part.lower()})")
    params = find_table(tables, "parameter")
    for row in params or []:
        pname = camel(row.get("parameter", ""))
        for part, column in (("Mean", "mean"), ("Min", "min"), ("Max", "max")):
            value = row.get(column, "")
            book.raw(f"ReplayParam{pname}{part}", summary_number(value) if to_float(value) is not None else None,
                     f"{src}: 'Scenario parameters', {row.get('parameter')}, {column}", f"scenario parameter {row.get('parameter')} ({column})")
    totals = find_table(tables, "invariant violations")
    for row in totals or []:
        mode = {"UNIFIED": "Unified", "PER_SESSION": "PerSession"}.get(row.get("mode", ""))
        if not mode:
            continue
        for column in ("decisions", "registrations", "offers", "expired", "declined", "accepted", "cancellations", "invariant violations"):
            value = row.get(column, "")
            book.raw(f"ReplayTotal{mode}{camel(column)}", summary_number(value) if to_float(value) is not None else None,
                     f"{src}: 'Totals and sanity checks', {row.get('mode')}, {column}", f"total {column} over all seeds ({row.get('mode')})")

    # paired shares computed from raw.csv (per seed)
    raw = db.read_csv(directory / "raw.csv", book.notes) if directory else None
    rsrc = f"{rel(directory)}/raw.csv" if directory else "results/replay/raw.csv"
    shares = {}
    if raw is not None and {"seed", "mode", "distinct_served"}.issubset(raw.columns):
        wide = raw.pivot_table(index="seed", columns="mode", values=["distinct_served", "dup_hold_events", "seat_refill_min_mean", "fill_rate"], aggfunc="first")
        try:
            delta = (wide[("distinct_served", "PER_SESSION")] - wide[("distinct_served", "UNIFIED")]).dropna()
            n = len(delta)
            shares["DistinctFewerSeedsPct"] = (100.0 * (delta < 0).sum() / n, "distinct_served PER_SESSION < UNIFIED (share of seeds)")
            shares["DistinctEqualSeedsPct"] = (100.0 * (delta == 0).sum() / n, "distinct_served PER_SESSION = UNIFIED (share of seeds)")
            shares["DistinctMoreSeedsPct"] = (100.0 * (delta > 0).sum() / n, "distinct_served PER_SESSION > UNIFIED (share of seeds)")
            shares["DistinctDeltaMin"] = (float(delta.min()), "min over seeds of distinct_served PER_SESSION - UNIFIED")
            dup = wide[("dup_hold_events", "PER_SESSION")].dropna()
            shares["DupHoldSeedsPct"] = (100.0 * (dup > 0).sum() / len(dup), "seeds with >= 1 duplicate-hold event under PER_SESSION (share)")
            refill = wide["seat_refill_min_mean"].dropna()
            shares["RefillPairedSeeds"] = (float(len(refill)), "seeds with a refill sample in both modes")
            shares["RefillSlowerSeedsPct"] = (100.0 * (refill["PER_SESSION"] > refill["UNIFIED"]).sum() / len(refill),
                                             "seat_refill_min_mean PER_SESSION > UNIFIED (share of paired seeds)")
            # cross-check against summary.md (means are printed with two decimals there)
            for column, name in (("distinct_served", "Distinct"), ("dup_hold_events", "DupHoldEvents")):
                for mode, tag in (("UNIFIED", "Unified"), ("PER_SESSION", "PerSession")):
                    entry = next((e for e in book.entries() if e.macro == f"Replay{name}{tag}Mean"), None)
                    mean = float(raw.loc[raw["mode"] == mode, column].mean())
                    if entry and entry.value and abs(mean - float(entry.value.replace("{,}", "").replace("\\ensuremath{-}", "-"))) > 0.006:
                        book.notes.append(f"replay cross-check: raw.csv mean of {column} ({mode}) = {mean:.4f} differs from summary.md {entry.value}")
        except KeyError as error:
            book.notes.append(f"{rsrc}: missing column/mode {error}; paired shares pending")
    for key, desc in (("DistinctFewerSeedsPct", 1), ("DistinctEqualSeedsPct", 1), ("DistinctMoreSeedsPct", 1), ("DistinctDeltaMin", 0),
                      ("DupHoldSeedsPct", 1), ("RefillPairedSeeds", 0), ("RefillSlowerSeedsPct", 1)):
        value, explanation = shares.get(key, (None, key))
        book.num(f"Replay{key}", value, desc, f"{rsrc}: {explanation}", explanation)


# ----------------------------------------------------------------------------- user study

def load_analysis():
    path = db.REPO_ROOT / "docs" / "user-study" / "analysis.py"
    db.ensure_user_site()
    spec = importlib.util.spec_from_file_location("seatrelay_study_analysis", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def section_study(book: Book, results: Path) -> None:
    folder = results / "user-study"
    session_csv, sus_csv = folder / "session-sheet.csv", folder / "sus-sheet.csv"
    book.section("study", "User study (SeatRelay vs Forms + Sheet)", "user study not yet run", [rel(folder) if folder.exists() else "none"])
    session = sus = None
    if session_csv.exists() or sus_csv.exists():
        try:
            analysis = load_analysis()
            session = analysis.clean_session(analysis.drop_examples(analysis.read_csv(session_csv, analysis.SESSION_COLUMNS, "session"), "session", False))
            sus = analysis.clean_sus(analysis.drop_examples(analysis.read_csv(sus_csv, analysis.SUS_COLUMNS, "sus"), "sus", False))
        except Exception as error:  # scipy missing or a malformed sheet: keep pending
            book.notes.append(f"user study: analysis.py could not be used ({error}); macros pending")
            session = sus = None
    have_tasks = session is not None and not session.empty
    have_sus = sus is not None and not sus.empty
    ssrc = rel(session_csv)
    book.num("StudyParticipants", session["participant_id"].nunique() if have_tasks else None, 0, f"{ssrc}: participant_id (distinct)", "participants with task rows")
    for track, name in (("participant", "StudyParticipantTrack"), ("organiser", "StudyOrganiserTrack")):
        value = None
        if have_tasks:
            tasks = [t for t in analysis.TASK_ORDER if analysis.TRACK_OF_TASK[t] == track]
            value = session[session["task_id"].isin(tasks)]["participant_id"].nunique()
        book.num(name, value, 0, f"{ssrc}: participants with {track} tasks", f"{track}-track participants")
    for scope, tasks_filter, tag in (("all tasks", None, ""), ("participant tasks", "T", "Participant"), ("organiser tasks", "O", "Organiser")):
        for cond, ctag in (("SR", "SR"), ("CTRL", "Ctrl")):
            st = None
            if have_tasks:
                sub = session[session["condition"] == cond]
                if tasks_filter:
                    sub = sub[sub["task_id"].str.startswith(tasks_filter)]
                st = analysis.completion_stats(sub)
            book.num(f"StudyCompletion{tag}{ctag}Pct", None if not st or not st["n"] else st["rate"], 1, f"{ssrc}: success = 1 share, {scope}, condition {cond}",
                     f"task completion without hint, {scope}, {cond} (%)", scale=100)
            book.num(f"StudyCompletion{tag}{ctag}AssistedPct", None if not st or not st["n"] else st["rate_incl"], 1, f"{ssrc}: success in (1, assisted) share, {scope}, condition {cond}",
                     f"task completion incl. assisted, {scope}, {cond} (%)", scale=100)
            book.num(f"StudyCompletion{tag}{ctag}N", None if not st else st["n"], 0, f"{ssrc}: task attempts with a success value, {scope}, {cond}", f"task attempts, {scope}, {cond}")
    # paired total time per participant (analysis.py section 3, overall)
    totals = None
    if have_tasks:
        try:
            _, pairs = analysis.section_time(session)
            totals = pairs.get("_totals")
        except Exception as error:
            book.notes.append(f"user study: task-time analysis failed ({error})")
    have_totals = totals is not None and len(totals) > 0
    med_sr = float(totals["SR"].median()) if have_totals else None
    med_ctrl = float(totals["CTRL"].median()) if have_totals else None
    improvement = (med_ctrl - med_sr) / med_ctrl * 100 if have_totals and med_ctrl else None
    wt = analysis.wilcoxon_paired(totals["CTRL"].to_numpy(), totals["SR"].to_numpy()) if have_totals else {}
    book.num("StudyTimeN", len(totals) if have_totals else None, 0, f"{ssrc}: participants timed in both conditions", "participants in the paired time comparison")
    book.num("StudyTimeSRMedianS", med_sr, 0, f"{ssrc}: per-participant total time_s, SR (median)", "median total task time, SeatRelay (s)")
    book.num("StudyTimeCtrlMedianS", med_ctrl, 0, f"{ssrc}: per-participant total time_s, CTRL (median)", "median total task time, control (s)")
    book.num("StudyTimeImprovementPct", improvement, 0, f"{ssrc}: (median CTRL - median SR) / median CTRL", "paired median task-time improvement (%)")
    book.pvalue("StudyTimeWilcoxonP", wt.get("p"), f"{ssrc}: Wilcoxon signed-rank on CTRL - SR totals (two-sided)", "Wilcoxon p-value, task time",
             reason=None if not have_totals else "Wilcoxon test not computable (too few non-zero pairs)")
    usrc = rel(sus_csv)
    for cond, ctag in (("SR", "SR"), ("CTRL", "Ctrl")):
        st = analysis.mean_ci(sus.loc[sus["condition"] == cond, "sus_score"].to_numpy(dtype=float)) if have_sus else {}
        book.num(f"StudySus{ctag}N", st.get("n") if st.get("n") else None, 0, f"{usrc}: rows, condition {cond}", f"SUS questionnaires, {cond}")
        book.num(f"StudySus{ctag}Mean", st.get("mean"), 1, f"{usrc}: sus_score (recomputed from q1..q10), {cond}, mean", f"SUS mean, {cond}")
        book.num(f"StudySus{ctag}Lo", st.get("lo"), 1, f"{usrc}: sus_score, {cond}, t-based 95% CI low", f"SUS 95% CI low, {cond}")
        book.num(f"StudySus{ctag}Hi", st.get("hi"), 1, f"{usrc}: sus_score, {cond}, t-based 95% CI high", f"SUS 95% CI high, {cond}")
    diff = {}
    swt = {}
    if have_sus:
        wide = sus.pivot_table(index="participant_id", columns="condition", values="sus_score", aggfunc="first")
        if {"SR", "CTRL"}.issubset(wide.columns):
            wide = wide[["SR", "CTRL"]].dropna()
            if len(wide):
                diff = analysis.mean_ci((wide["SR"] - wide["CTRL"]).to_numpy(dtype=float))
                swt = analysis.wilcoxon_paired(wide["SR"].to_numpy(), wide["CTRL"].to_numpy())
    book.num("StudySusDiffMean", diff.get("mean"), 1, f"{usrc}: paired SR - CTRL, mean", "paired SUS difference SR - CTRL")
    book.num("StudySusDiffLo", diff.get("lo"), 1, f"{usrc}: paired SR - CTRL, 95% CI low", "paired SUS difference, CI low")
    book.num("StudySusDiffHi", diff.get("hi"), 1, f"{usrc}: paired SR - CTRL, 95% CI high", "paired SUS difference, CI high")
    book.pvalue("StudySusDiffP", swt.get("p"), f"{usrc}: Wilcoxon signed-rank on SR - CTRL", "Wilcoxon p-value, SUS")
    for cond, ctag in (("SR", "SR"), ("CTRL", "Ctrl")):
        errors = helps = None
        if have_tasks:
            sub = session[session["condition"] == cond]
            errors = float(sub["errors"].dropna().sum()) if sub["errors"].notna().any() else None
            helps = float(sub["help_requests"].dropna().sum()) if sub["help_requests"].notna().any() else None
        book.num(f"StudyErrors{ctag}", errors, 0, f"{ssrc}: errors (sum), {cond}", f"erroneous actions, {cond}")
        book.num(f"StudyHelp{ctag}", helps, 0, f"{ssrc}: help_requests (sum), {cond}", f"help requests, {cond}")


# ----------------------------------------------------------------------------- market sizing

def section_market(book: Book, results: Path) -> None:
    """Own counts (library calendars, NTU directory) and the derived market figures, from
    results/market/<date>/counts.json (tools/market/count.py over the raw captures in raw/)."""
    folder = db.latest_dir(results / "market", "*", must_contain="counts.json")
    book.section("market", "Market sizing (own counts and derived figures)", "market captures not yet counted (tools/market)",
                 [rel(folder) if folder else "none"])
    data = db.read_json(folder / "counts.json") if folder else None
    src = f"{rel(folder)}/counts.json" if folder else "results/market/<date>/counts.json"
    data = data or {}
    nus, smu, ntu = data.get("nus_libcal") or {}, data.get("smu_libcal") or {}, data.get("ntu") or {}
    cited, derived = data.get("cited") or {}, data.get("derived") or {}
    book.text("MarketDate", data.get("date"), f"{src}: date", "capture date of the own counts")
    window = nus.get("window") or [None, None]
    book.text("MarketLibcalFrom", window[0], f"{src}: nus_libcal.window[0]", "first calendar day counted")
    book.text("MarketLibcalTo", window[1], f"{src}: nus_libcal.window[1]", "last calendar day counted")
    book.num("MarketNusLibcalEvents", nus.get("events"), 0, f"{src}: nus_libcal.events", "NUS Libraries calendar: events in the window")
    book.num("MarketNusLibcalWorkshops", nus.get("workshop_events"), 0, f"{src}: nus_libcal.workshop_events", "NUS: events tagged Workshop")
    book.num("MarketNusLibcalWorkshopTitles", nus.get("workshop_distinct_titles"), 0, f"{src}: nus_libcal.workshop_distinct_titles", "NUS: distinct Workshop titles")
    book.num("MarketNusLibcalRepeatEvents", nus.get("workshop_repeat_events"), 0, f"{src}: nus_libcal.workshop_repeat_events", "NUS: Workshop events of a repeated title")
    repeated = nus.get("workshop_repeated_titles") or []
    book.num("MarketNusLibcalRepeatTitles", len(repeated) if nus else None, 0, f"{src}: nus_libcal.workshop_repeated_titles (count)", "NUS: repeated Workshop titles")
    for index, word in ((0, "One"), (1, "Two")):
        book.num(f"MarketNusLibcalRepeatTitle{word}Events", repeated[index][1] if len(repeated) > index else None, 0,
                 f"{src}: nus_libcal.workshop_repeated_titles[{index}] ({repeated[index][0] if len(repeated) > index else '-'})",
                 f"NUS: sessions of repeated Workshop title {index + 1}")
    book.num("MarketSmuLibcalEvents", smu.get("events"), 0, f"{src}: smu_libcal.events", "SMU Libraries calendar: events in the window")
    book.num("MarketSmuLibcalRepeatTitles", len(smu.get("repeated_titles") or []) if smu else None, 0, f"{src}: smu_libcal.repeated_titles (count)", "SMU: repeated titles")
    book.num("MarketSmuLibcalRepeatEvents", smu.get("repeat_events"), 0, f"{src}: smu_libcal.repeat_events", "SMU: events of a repeated title")
    book.num("MarketNtuOrgs", ntu.get("student_orgs"), 0, f"{src}: ntu.student_orgs", "NTU student organisations (own count)")
    for key, macro, what in (("nus_student_orgs", "MarketNusOrgs", "NUS student organisations (cited)"),
                             ("smu_student_orgs", "MarketSmuOrgs", "SMU student organisations (cited)"),
                             ("sutd_student_groups", "MarketSutdOrgs", "SUTD student groups (cited)"),
                             ("sit_student_orgs", "MarketSitOrgs", "SIT student organisations (cited)"),
                             ("cet_training_providers", "MarketCetProviders", "CET training providers (cited, 2016)")):
        book.num(macro, cited.get(key), 0, f"{src}: cited.{key} (tools/market/inputs.json)", what)
    book.num("MarketPriceSgd", data.get("price_sgd_per_year"), 0, f"{src}: price_sgd_per_year", "price per organiser-year (S$)")
    for key, macro, what in (("student_orgs_five_universities", "MarketStudentOrgs", "student organisations, five universities (lower bound)"),
                             ("student_orgs_fetched_or_own_count", "MarketStudentOrgsFetched", "sensitivity case: fetched or own counts only"),
                             ("tam_campus_sgd_per_p_3sf", "MarketTamCampusSgd", "campus TAM per unit of p (S$/year, 3 s.f.)"),
                             ("tam_campus_cet_sgd_per_p_3sf", "MarketTamCampusCetSgd", "campus + CET TAM per unit of p (S$/year, 3 s.f.)"),
                             ("tam_campus_fetched_sgd_per_p_3sf", "MarketTamFetchedSgd", "sensitivity TAM per unit of p (S$/year, 3 s.f.)"),
                             ("som_nus_max_sgd", "MarketSomNusMaxSgd", "SOM upper bound, NUS only, p = a = 1 (S$/year)")):
        book.num(macro, derived.get(key), 0, f"{src}: derived.{key}", what)


# ----------------------------------------------------------------------------- interviews

def section_interviews(book: Book, results: Path) -> None:
    path = results / "interviews" / "interviews.csv"
    book.section("interviews", "Interviews (market sizing and pricing inputs)", "interviews not yet done", [rel(path) if path.exists() else "none"])
    frame = db.read_csv(path, book.notes)
    if frame is not None and "id" in frame.columns:
        frame = frame[~frame["id"].astype(str).str.upper().str.contains("EXAMPLE")]
        if frame.empty:
            frame = None
    src = rel(path)
    role = frame["role"].astype(str).str.lower() if frame is not None and "role" in frame.columns else None
    org = frame[role == "organiser"] if frame is not None and role is not None else None
    par = frame[role == "participant"] if frame is not None and role is not None else None
    book.num("InterviewN", len(frame) if frame is not None else None, 0, f"{src}: rows without EXAMPLE", "interviews")
    book.num("InterviewOrganisers", len(org) if org is not None and len(org) else None, 0, f"{src}: role = organiser", "organiser interviews")
    book.num("InterviewParticipants", len(par) if par is not None and len(par) else None, 0, f"{src}: role = participant", "participant interviews")
    num = lambda f, c: [v for v in (to_float(x) for x in f[c].tolist()) if v is not None] if f is not None and c in f.columns else []  # noqa: E731
    p_event = None
    if org is not None and len(org) and {"share_multi_session", "events_per_year"}.issubset(org.columns):
        pairs = [(to_float(s), to_float(e)) for s, e in zip(org["share_multi_session"], org["events_per_year"])]
        pairs = [(s, e) for s, e in pairs if s is not None and e is not None]
        events = sum(e for _, e in pairs)
        p_event = (sum(s * e for s, e in pairs) / events * 100) if events else None
    book.num("InterviewPEventWeightedPct", p_event, 0, f"{src}: organisers, sum(share_multi_session x events_per_year) / sum(events_per_year)", "p: share of events with >= 2 equivalent sessions, event-weighted (%)")
    shares = num(org, "share_multi_session")
    book.num("InterviewPMeanPct", sum(shares) / len(shares) * 100 if shares else None, 0, f"{src}: organisers, share_multi_session (mean)", "p, simple mean over organisers (%)")
    hours = num(org, "hours_per_event")
    book.num("InterviewHoursMedian", db.median(hours) if hours else None, 1, f"{src}: organisers, hours_per_event (median)", "person-hours of coordination per multi-session event (median)")
    book.num("InterviewHoursMin", min(hours) if hours else None, 1, f"{src}: organisers, hours_per_event (min)", "hours per event, smallest answer")
    book.num("InterviewHoursMax", max(hours) if hours else None, 1, f"{src}: organisers, hours_per_event (max)", "hours per event, largest answer")
    for column, name in (("wtp_too_cheap", "TooCheap"), ("wtp_bargain", "Bargain"), ("wtp_expensive", "Expensive"), ("wtp_too_expensive", "TooExpensive")):
        values = num(org, column)
        book.num(f"InterviewWtp{name}Median", db.median(values) if values else None, 0, f"{src}: organisers, {column} (median, S$/month)", f"organiser willingness to pay, {column} (median S$/month)")
    pshare = num(par, "share_multi_session")
    book.num("InterviewParticipantShareMeanPct", sum(pshare) / len(pshare) * 100 if pshare else None, 0, f"{src}: participants, share_multi_session (mean)", "participants: share of events met with several sessions (%)")


# ----------------------------------------------------------------------------- pilot

def section_pilot(book: Book, runs, results: Path) -> None:
    dated = sorted((r for r in runs.get("pilot", [])), key=lambda r: (r.date, r.suffix), reverse=True)
    folder = dated[0].path if dated else results / "pilot"
    exports = sorted(p for p in folder.glob("*.csv")) if folder.is_dir() else []
    frames = []
    for path in exports:
        frame = db.read_csv(path, book.notes)
        if frame is not None and {"seq", "userId", "status"}.issubset(frame.columns):
            frames.append((path, frame))
    book.section("pilot", "Real pilot (organiser CSV exports)", "pilot not yet run", [rel(folder) if folder.is_dir() else "none"])
    src = f"{rel(folder)}/*.csv (organiser exports)" if folder.is_dir() else "results/pilot/*.csv (organiser exports)"
    have = bool(frames)
    rows = sum(len(f) for _, f in frames) if have else None
    status = lambda s: sum(int(f["status"].astype(str).eq(s).sum()) for _, f in frames) if have else None  # noqa: E731
    book.num("PilotWorkshops", len(frames) if have else None, 0, f"{src}: files", "pilot workshops (export files)")
    book.num("PilotRegistrations", rows, 0, f"{src}: rows", "registrations")
    book.num("PilotConfirmed", status("CONFIRMED"), 0, f"{src}: status = CONFIRMED", "confirmed registrations at export")
    book.num("PilotCancelled", status("CANCELLED"), 0, f"{src}: status = CANCELLED", "cancelled registrations")
    book.num("PilotEnded", status("ENDED"), 0, f"{src}: status = ENDED", "ended registrations")
    distinct = len({u for _, f in frames for u in f["userId"].astype(str)}) if have else None
    book.num("PilotDistinctParticipants", distinct, 0, f"{src}: userId (distinct over files)", "distinct participants")
    attended = None
    if have and all("attended" in f.columns for _, f in frames):
        attended = sum(int(f["attended"].astype(str).str.lower().isin(["true", "1", "yes"]).sum()) for _, f in frames)
    book.num("PilotAttended", attended, 0, f"{src}: attended = true", "participants marked as attended")
    book.num("PilotBackfills", None, 0, f"{rel(folder) if folder.is_dir() else 'results/pilot'}: dashboard backfill log", "backfills during the pilot",
             reason="pilot backfill log not yet exported (no reader: the CSV export has no backfill records)" if have else None)


# ============================================================================ output

HEADER = r"""% SeatRelay report numbers -- GENERATED by report/tools/numbers.py from results/.
% Do not edit by hand: re-run  python3 -I report/tools/numbers.py  after results/ changes.
% Load in the preamble after generated/pending.tex:
%   \input{generated/pending}
%   \input{generated/numbers}
% Each macro is preceded by its source (file: column / row / key). A macro whose data does not
% exist yet expands to \pending{...} (red "[PENDING: ...]" in the PDF). Naming scheme and the
% full list: report/generated/README.md.
\providecommand{\pending}[1]{\textbf{[PENDING: #1]}}
"""


def write_numbers(book: Book, out: Path) -> None:
    lines = [HEADER]
    for section in book.sections.values():
        lines.append("")
        lines.append(f"% {'=' * 94}")
        lines.append(f"% {section['title']}")
        for source in section["sources"]:
            lines.append(f"%   source: {source}")
        lines.append(f"% {'=' * 94}")
        for entry in section["entries"]:
            lines.append(f"% {entry.source} -- {entry.desc}")
            body = entry.value if entry.value is not None else f"\\pending{{{tex_text(entry.reason)}}}"
            lines.append(f"\\newcommand{{\\{entry.macro}}}{{{body}}}")
    (out / "numbers.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")


PENDING_TEX = r"""% Visible placeholder for data that does not exist yet (academic-integrity rule: no number is
% invented; a missing measurement is shown, not hidden). Load in the preamble before
% generated/numbers.tex:   \input{generated/pending}  \input{generated/numbers}
%
% \pending{what is missing} prints a red bold "[PENDING: what is missing]" in the PDF, writes
% "SEATRELAY-PENDING: what is missing" to the log, and counts the uses; the count is written to
% the log at the end of the run ("SEATRELAY-PENDING-COUNT: n"). The submission build must find
% zero "[PENDING" strings in the PDF text (pdftotext) before Final.pdf is handed in.
% Written by report/tools/numbers.py (regenerated on every run; edit the script, not this file).
\usepackage{xcolor}
\newcounter{srpending}
\DeclareRobustCommand{\pending}[1]{%
  \stepcounter{srpending}%
  \typeout{SEATRELAY-PENDING: \detokenize{#1}}%
  \textcolor{red}{\textbf{[PENDING: #1]}}}
\AtEndDocument{\typeout{SEATRELAY-PENDING-COUNT: \arabic{srpending}}}
"""

README_HEAD = """# Generated report numbers

Generated by `report/tools/numbers.py` from `results/`; **do not edit these files by hand**.
Re-run after any new run directory appears under `results/` (the script is idempotent: the same
`results/` gives byte-identical output):

```bash
python3 -I report/tools/numbers.py            # numbers.tex, pending.tex, this README
python3 -I report/tools/make_figures.py       # report/figures/generated/*.pdf
```

Use in `Final.tex` (preamble):

```latex
\\input{generated/pending}   % defines \\pending{...} (red "[PENDING: ...]")
\\input{generated/numbers}   % one \\newcommand per number
```

and in the text, e.g. `UNIFIED served \\ReplayDistinctUnifiedMean{} people per workshop on average`.
A macro without data expands to `\\pending{<what is missing>}`; the submission build must find no
`[PENDING` in the PDF text.

## Where the numbers come from

* **Table 3 experiments**: for each experiment the latest *complete* directory
  `results/<YYYY-MM-DD>-<name>[-<n>]/` (it has `meta.json`; a directory without one is still running
  or was aborted) whose `meta.json` target is `dev` (`--target` changes it). Its run id, start time
  and commit are listed in the section header of `numbers.tex`.
* **Pooled latencies** (backfill, preference-order server settle) are recomputed from `raw.csv` /
  `latency.csv` with the nearest-rank percentile of `tools/experiments/src/lib/results.ts`, so they
  equal `summary.md`. Latency summaries already in `meta.json` (`settleMs`, `serverSettleMs`) are
  copied.
* **Performance**: latest `results/loadtest/<date>/raw.csv`, active rounds only (`supersededBy`
  empty); p95 columns are the median over the rounds of a VU level, the error rate the worst round
  (as in `summary.md` of the matrix). A level stays pending until all its rounds exist
  (`LOADTEST_ROUNDS` in `resultsdb.py`), and a settle p95 stays pending when a round settled nothing.
* **Replay, cost**: copied cell by cell from `summary.md` / `model-summary.md` (same digits as
  printed there; no re-rounding), plus per-seed shares computed from `results/replay/raw.csv`.
* **Market sizing**: `results/market/<date>/counts.json`, written by `tools/market/count.py` from the raw
  captures in `results/market/<date>/raw/` (`tools/market/capture.py`) and the cited counts in
  `tools/market/inputs.json`.
* **User study**: `results/user-study/{session-sheet,sus-sheet}.csv` through the cleaning and
  statistics functions of `docs/user-study/analysis.py` (needs scipy).
* **Interviews**: `results/interviews/interviews.csv` (EXAMPLE rows dropped).
* **Pilot**: organiser CSV exports in `results/pilot/` (or the latest `results/<date>-pilot/`).

## Naming scheme

`\\<Area><Metric>[<Qualifier>][<Unit>]`, letters only (LaTeX command names cannot contain digits):

| Part | Values |
|---|---|
| Area | `Smoke`, `Correctness`, `PrefOrder`, `Core` (property test), `Concurrency`, `Repeat`, `ExpiryRace`, `Failure`, `Access`, `Backfill`, `Series` (the Table 3 series as a whole), `TimerPath`, `Perf`, `Cost`, `Replay`, `Market`, `Study`, `Interview`, `Pilot` |
| Run metadata | `Verdict` (PASS/FAIL), `RunId` (8 chars), `Date`, `Commit` (7 chars), `Runs`, `RunsPassed`, `ChecksPassed`, `ChecksTotal` |
| Percentiles | `PFifty`, `PNinetyFive`, `PNinetyNine`; also `Max`, `Mean`, `Median`, `N` (sample count) |
| Numbers in names | spelled out: VU levels `VUTen`, `VUTwentyFive`, `VUFifty`; cost tiers `OneK`, `TenK`, `HundredK` (registrations/month) |
| Modes / conditions | `Unified`, `PerSession`, `Delta` (paired PER_SESSION − UNIFIED); `SR` (SeatRelay), `Ctrl` (Forms + Sheet) |
| CIs | `Lo`, `Hi` (95 % bootstrap CI for replay, t-based for SUS) |
| Units | `Ms`, `S`, `Min`, `Usd`, `Pct` (number without the % sign), `MiB`, `Regs` (registrations/month); none for counts |
| Load test | `Perf<Target><Scenario>VU<n><Metric>`: target `Dev`/`Local`, scenario `Cross` (cross-workshop) / `Hotspot`; metric `ReadPNinetyFiveMs`, `AcceptPNinetyFiveMs` (202), `SettlePNinetyFiveMs` (client-observed), `ServerSettlePNinetyFiveMs`, `CloudWatchSettlePNinetyFiveMs`, `ErrorPct`, `QueueAgeMaxS`, `Rounds` |

Numbers are typeset for text mode (`1{,}000`, `\\ensuremath{-}4.04`) and work in math mode too.
Units and `\\%` are written in the report text, not in the macro.

## All macros

"""


def write_readme(book: Book, out: Path, notes: list[str]) -> None:
    lines = [README_HEAD]
    total = sum(1 for _ in book.entries())
    pending = sum(1 for e in book.entries() if e.value is None)
    lines.append(f"{total} macros, {total - pending} with data, {pending} pending.\n")
    for section in book.sections.values():
        entries = section["entries"]
        done = sum(1 for e in entries if e.value is not None)
        lines.append(f"### {section['title']}\n")
        lines.append("Source: " + "; ".join(f"`{s}`" if s != "none" else "none yet" for s in section["sources"]) +
                     f" — {done}/{len(entries)} with data.\n")
        lines.append("| Macro | Value | Source |")
        lines.append("|---|---|---|")
        for entry in entries:
            value = entry.value if entry.value is not None else f"PENDING: {entry.reason}"
            value = value.replace("{,}", ",").replace("\\ensuremath{-}", "−").replace("\\", "").replace("|", "\\|")
            lines.append(f"| `\\{entry.macro}` | {value} | {entry.source.replace('|', '/')} |")
        lines.append("")
    if notes:
        lines.append("## Notes from the last run\n")
        lines.extend(f"- {note}" for note in notes)
        lines.append("")
    (out / "README.md").write_text("\n".join(lines), encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--results", default=str(db.RESULTS), help="results directory (default: <repo>/results)")
    parser.add_argument("--out", default=str(db.REPO_ROOT / "report" / "generated"), help="output directory (default: report/generated)")
    parser.add_argument("--target", default="dev", help="target of the Table 3 runs to quote (default: dev)")
    args = parser.parse_args(argv)
    results, out = Path(args.results), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    runs = db.scan_runs(results)
    book = Book()
    section_smoke(book, runs, args.target)
    section_correctness(book, runs, args.target)
    section_preference(book, runs, args.target, results)
    section_concurrency(book, runs, args.target)
    section_repeat(book, runs, args.target)
    section_expiry_race(book, runs, args.target)
    section_failure(book, runs, args.target)
    section_access(book, runs, args.target)
    section_backfill(book, runs, args.target)
    section_series(book, runs, args.target)
    section_timer_path(book, runs, args.target)
    section_loadtest(book, results)
    section_cost(book, results)
    section_replay(book, runs, results)
    section_study(book, results)
    section_market(book, results)
    section_interviews(book, results)
    section_pilot(book, runs, results)

    notes = sorted(set(book.notes))
    write_numbers(book, out)
    (out / "pending.tex").write_text(PENDING_TEX, encoding="utf-8")
    write_readme(book, out, notes)

    print(f"wrote {rel(out / 'numbers.tex')}, {rel(out / 'pending.tex')}, {rel(out / 'README.md')}")
    print(f"{'section':<14} {'with data':>9} {'pending':>8}  source")
    for section in book.sections.values():
        entries = section["entries"]
        done = sum(1 for e in entries if e.value is not None)
        print(f"{section['key']:<14} {done:>9} {len(entries) - done:>8}  {section['sources'][0]}")
    total = sum(1 for _ in book.entries())
    pending = sum(1 for e in book.entries() if e.value is None)
    print(f"{'total':<14} {total - pending:>9} {pending:>8}")
    for note in notes:
        print(f"note: {note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
