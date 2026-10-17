"""Shared helpers of report/tools/make_figures.py and report/tools/report_numbers.py.

Both scripts run under ``python3 -I`` (isolated mode: neither the current directory nor the script
directory is on ``sys.path``), so they load this module by its file path instead of importing it.

What lives here:

* the layout of ``results/`` (``docs/EXPERIMENTS.md`` §7): one directory per harness invocation,
  ``results/<YYYY-MM-DD>-<experiment>[-<n>]/`` with ``summary.md``, ``meta.json``, ``raw.csv`` and
  optional extras; ``results/loadtest/<date>/``, ``results/replay/``, ``results/cost/``,
  ``results/user-study/``, ``results/interviews/``;
* the choice of *the* run per experiment: the latest **complete** directory (it has a
  ``meta.json``; a directory without one is still running or was aborted) for the requested
  target (default ``dev``, the report target of every Table 3 row);
* the nearest-rank percentile used by ``tools/experiments/src/lib/results.ts`` and
  ``tools/experiments/analysis/plot_results.py``, so numbers match ``summary.md``;
* tolerant CSV and Markdown-table readers (a missing or empty file is a note, never a crash).
"""

from __future__ import annotations

import json
import math
import re
import site
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
RESULTS = REPO_ROOT / "results"
RUN_DIR = re.compile(r"^(\d{4}-\d{2}-\d{2})-(.+?)(?:-(\d+))?$")


def rel(path: Path) -> str:
    """Path relative to the repository root, with forward slashes (for comments and notes)."""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def ensure_user_site() -> None:
    """Under ``python3 -I`` the user site-packages directory is not on sys.path. Some machines
    install matplotlib / scipy only there (``pip install --user``). Append that one fixed
    directory (never the current or script directory) so isolated mode still finds them."""
    if not sys.flags.isolated:
        return
    try:
        user_site = site.getusersitepackages()
    except Exception:  # pragma: no cover - exotic interpreters
        return
    if user_site and Path(user_site).is_dir() and user_site not in sys.path:
        sys.path.append(user_site)


# ----------------------------------------------------------------------------- statistics

def nearest_rank(values, p: float) -> float:
    """Smallest value such that at least p % of the samples are <= it (NaN when empty)."""
    ordered = sorted(float(v) for v in values if v is not None and not _isnan(v))
    if not ordered:
        return math.nan
    rank = math.ceil(min(100.0, max(0.0, p)) / 100.0 * len(ordered))
    return ordered[min(len(ordered) - 1, max(0, rank - 1))]


def _isnan(value: Any) -> bool:
    try:
        return math.isnan(float(value))
    except (TypeError, ValueError):
        return True


def median(values) -> float:
    ordered = sorted(float(v) for v in values if not _isnan(v))
    if not ordered:
        return math.nan
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


# ----------------------------------------------------------------------------- files

def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_csv(path: Path, notes: list[str] | None = None):
    """pandas DataFrame of a CSV, or None (with a note) when it is missing, empty or unreadable."""
    import pandas as pd

    if not path.exists():
        return None
    try:
        if not path.read_text(encoding="utf-8").strip():
            if notes is not None:
                notes.append(f"{rel(path)}: empty, skipped")
            return None
        return pd.read_csv(path)
    except Exception as error:  # malformed CSV must not stop the pipeline
        if notes is not None:
            notes.append(f"{rel(path)}: not readable ({error}), skipped")
        return None


def markdown_tables(text: str) -> list[list[dict[str, str]]]:
    """Every pipe table of a Markdown text as a list of row dicts keyed by the header cells."""
    tables: list[list[dict[str, str]]] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines) - 1:
        line, nxt = lines[i].strip(), lines[i + 1].strip()
        if line.startswith("|") and re.match(r"^\|(\s*:?-{3,}:?\s*\|)+\s*$", nxt):
            header = _cells(line)
            rows = []
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = _cells(lines[i].strip())
                rows.append({header[k]: (cells[k] if k < len(cells) else "") for k in range(len(header))})
                i += 1
            tables.append(rows)
        else:
            i += 1
    return tables


def _cells(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    parts = re.split(r"(?<!\\)\|", body)
    return [part.strip().replace("\\|", "|") for part in parts]


# ----------------------------------------------------------------------------- run directories

@dataclass
class RunDir:
    path: Path
    date: str
    name: str
    suffix: int
    meta: dict | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return self.meta is not None

    @property
    def target(self) -> str | None:
        if not self.meta:
            return None
        target = self.meta.get("target")
        if isinstance(target, dict):
            return target.get("name")
        return target if isinstance(target, str) else None

    @property
    def started(self) -> str:
        if self.meta:
            for key in ("startedAt", "ranAt"):
                if isinstance(self.meta.get(key), str):
                    return self.meta[key]
        return f"{self.date}T00:00:00Z"

    @property
    def run_id(self) -> str | None:
        return self.meta.get("runId") if self.meta else None

    @property
    def commit(self) -> dict:
        commit = (self.meta or {}).get("commit")
        if isinstance(commit, dict):
            return commit
        if isinstance(commit, str):
            return {"hash": commit, "short": commit[:12], "dirty": None}
        return {}

    def describe(self) -> str:
        commit = self.commit
        dirty = commit.get("dirty")
        bits = [
            f"runId {self.run_id}" if self.run_id else None,
            f"target {self.target}" if self.target else None,
            f"started {self.started}",
            f"commit {commit.get('short') or commit.get('hash', '?')}" + (" (dirty)" if dirty else "") if commit else None,
        ]
        return ", ".join(bit for bit in bits if bit)


def scan_runs(results: Path = RESULTS) -> dict[str, list[RunDir]]:
    """All dated run directories by experiment name (unsorted)."""
    found: dict[str, list[RunDir]] = {}
    if not results.is_dir():
        return found
    for path in results.iterdir():
        if not path.is_dir():
            continue
        match = RUN_DIR.match(path.name)
        if not match:
            continue
        date, name, suffix = match.group(1), match.group(2), int(match.group(3) or 1)
        run = RunDir(path=path, date=date, name=name, suffix=suffix, meta=read_json(path / "meta.json"))
        found.setdefault(name, []).append(run)
    return found


def latest_run(runs: dict[str, list[RunDir]], name: str, target: str | None = "dev",
               notes: list[str] | None = None) -> RunDir | None:
    """The latest complete run of ``name`` for ``target`` (None: any target)."""
    candidates = sorted(runs.get(name, []), key=lambda run: (run.date, run.suffix, run.started), reverse=True)
    for run in candidates:
        if not run.complete:
            if notes is not None:
                notes.append(f"{rel(run.path)}: no meta.json (still running or aborted), skipped")
            continue
        if target is not None and run.target not in (None, target):
            if notes is not None:
                notes.append(f"{rel(run.path)}: target {run.target}, not {target}, skipped")
            continue
        return run
    return None


def latest_dir(parent: Path, pattern: str = "*", must_contain: str | None = None) -> Path | None:
    """The lexicographically latest subdirectory (dates sort correctly) holding ``must_contain``."""
    if not parent.is_dir():
        return None
    dirs = sorted((p for p in parent.glob(pattern) if p.is_dir()), reverse=True)
    for path in dirs:
        if must_contain is None or (path / must_contain).exists():
            return path
    return None


# ----------------------------------------------------------------------------- load test

# The k6 matrix of tools/loadtest (run-matrix defaults): 2 scenarios x 3 VU levels x 3 rounds.
LOADTEST_ROUNDS = 3
LOADTEST_LEVELS = [(scenario, vus) for scenario in ("cross-workshop", "hotspot") for vus in (10, 25, 50)]


def loadtest_active(frame):
    """Rows of a run-matrix raw.csv that are not superseded by a later round."""
    if frame is not None and "supersededBy" in frame.columns:
        frame = frame[frame["supersededBy"].isna() | (frame["supersededBy"].astype(str).str.len() == 0)]
    return frame


def loadtest_rounds(frame, target: str, scenario: str, vus: int) -> int:
    """Active rounds recorded for one (target, scenario, VU level)."""
    if frame is None or frame.empty:
        return 0
    rows = frame[(frame["target"].astype(str) == target) & (frame["scenario"].astype(str) == scenario) & (frame["vus"] == vus)]
    return int(len(rows))


def loadtest_complete(frame, target: str, rounds: int = LOADTEST_ROUNDS) -> bool:
    """True when every level of the matrix has all its rounds on ``target`` (a level quoted or
    drawn before that would mix finished and unfinished rounds)."""
    return all(loadtest_rounds(frame, target, s, v) >= rounds for s, v in LOADTEST_LEVELS)
