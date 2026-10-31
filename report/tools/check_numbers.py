#!/usr/bin/env python3
"""Check that every generated number in the report traces back to results/.

    python3 -I report/tools/check_numbers.py

1. Regenerates report/generated/ into a temporary directory with report_numbers.py and requires
   numbers.tex, pending.tex and README.md to be byte-identical to the committed ones, so every
   macro the PDF prints is reproducible from the files in results/ (and the pinned series).
2. Reads the macro -> source table of report/generated/README.md and requires every file named by
   a macro that has a value (results/..., report/..., tools/..., docs/...) to exist.
3. Checks results/RUNS.md against the run directories: every results/<date>-<name>[-n]/meta.json
   must have a row whose start, experiment, target, commit and run id match it, so a run added
   without updating the register (which is maintained by hand) is caught.
4. Lists the macros that are still pending (no data yet).

Exits 1 on any mismatch or missing source; prints a one-line summary either way.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "report" / "generated"
FILES = ("numbers.tex", "pending.tex", "README.md")
PATH_RE = re.compile(r"\b((?:results|report|tools|docs)/[A-Za-z0-9_.\-/<>*]+)")
RESULTS = ROOT / "results"
RUNS_MD = RESULTS / "RUNS.md"
RUN_DIR = re.compile(r"^(\d{4}-\d{2}-\d{2})-(.+?)(?:-(\d+))?$")


def regenerate(out: Path) -> None:
    subprocess.run(
        [sys.executable, "-I", str(ROOT / "report" / "tools" / "report_numbers.py"), "--out", str(out)],
        check=True, stdout=subprocess.DEVNULL,
    )


def sources(readme: str) -> list[tuple[str, str, list[str]]]:
    rows = []
    for line in readme.splitlines():
        m = re.match(r"\| `\\([A-Za-z]+)` \| (.*?) \| (.*) \|$", line)
        if m:
            rows.append((m.group(1), m.group(2), PATH_RE.findall(m.group(3))))
    return rows


def register_rows(markdown: str) -> dict[str, dict[str, str]]:
    """results/RUNS.md rows keyed by the `results dir` column."""
    rows: dict[str, dict[str, str]] = {}
    header: list[str] | None = None
    for line in markdown.splitlines():
        if not line.startswith("|"):
            header = None
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if header is None:
            header = cells
            continue
        if all(set(cell) <= set("-: ") for cell in cells):
            continue
        row = dict(zip(header, cells))
        if row.get("results dir"):
            rows[row["results dir"]] = row
    return rows


def run_row(path: Path) -> dict[str, str] | None:
    """The register row a run directory's meta.json implies (same derivation for every harness)."""
    try:
        meta = json.loads((path / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    target = meta.get("target")
    target = target.get("name") if isinstance(target, dict) else (target or meta.get("stage") or "")
    commit = meta.get("commit") or {}
    if isinstance(commit, str):
        commit = {"hash": commit.split()[0], "dirty": "(dirty)" in commit}
    match = RUN_DIR.match(path.name)
    return {
        "start (UTC)": str(meta.get("startedAt") or meta.get("ranAt") or ""),
        "experiment": str(meta.get("name") or (match.group(2) if match else path.name)),
        "target": str(target),
        "commit (dirty?)": str(commit.get("hash") or "")[:7] + (" (dirty)" if commit.get("dirty") else ""),
        "run id": str(meta.get("runId") or "")[:8],
        "results dir": path.name,
    }


def check_register() -> tuple[int, list[str]]:
    """Every run directory with a meta.json has a matching RUNS.md row; returns (runs checked, problems)."""
    if not RUNS_MD.exists():
        return 0, ["results/RUNS.md is missing"]
    rows = register_rows(RUNS_MD.read_text(encoding="utf-8"))
    problems: list[str] = []
    checked = 0
    for path in sorted(p for p in RESULTS.iterdir() if p.is_dir() and RUN_DIR.match(p.name)):
        expected = run_row(path)
        if expected is None:
            continue  # not a harness run (no meta.json): listed by hand below the table
        checked += 1
        actual = rows.get(path.name)
        if actual is None:
            problems.append(f"results/RUNS.md has no row for results/{path.name} (meta.json exists)")
            continue
        for column, value in expected.items():
            if actual.get(column, "") != value:
                problems.append(f"results/RUNS.md row {path.name}: {column} is '{actual.get(column, '')}', meta.json says '{value}'")
    return checked, problems


def main() -> int:
    problems: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        regenerate(Path(tmp))
        for name in FILES:
            if (Path(tmp) / name).read_bytes() != (GENERATED / name).read_bytes():
                problems.append(f"report/generated/{name} differs from a fresh run of report_numbers.py")
    rows = sources((GENERATED / "README.md").read_text(encoding="utf-8"))
    checked = 0
    for macro, value, paths in rows:
        if "pending" in value.lower():
            continue  # no data yet: its future source file is named but need not exist
        for raw in paths:
            path = raw.rstrip(".,;:)")
            if any(ch in path for ch in "<>*"):
                continue  # a pattern (e.g. results/<date>/...), not a concrete file
            checked += 1
            if not (ROOT / path).exists():
                problems.append(f"\\{macro}: source {path} does not exist")
    runs_checked, register_problems = check_register()
    problems.extend(register_problems)
    research = subprocess.run(
        [sys.executable, "-I", str(ROOT / "tools/research/simulate.py"), "--check", "--check-figures"],
        capture_output=True, text=True,
    )
    if research.returncode:
        problems.append("research is not reproducible: " + (research.stdout + research.stderr).strip())
    else:
        print(research.stdout.strip())
    pending = [macro for macro, value, _ in rows if "pending" in value.lower()]
    for p in problems:
        print("FAIL:", p)
    print(f"check_numbers: {len(rows)} macros, {len(rows) - len(pending)} with values, {checked} source paths checked, "
          f"{runs_checked} run directories checked against results/RUNS.md, {len(pending)} pending, "
          f"{len(problems)} problems")
    if pending:
        print("pending:", ", ".join(pending[:40]) + (" ..." if len(pending) > 40 else ""))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
