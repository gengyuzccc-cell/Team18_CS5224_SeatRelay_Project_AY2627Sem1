#!/usr/bin/env python3
"""Check that every generated number in the report traces back to results/.

    python3 -I report/tools/check_numbers.py

1. Regenerates report/generated/ into a temporary directory with report_numbers.py and requires
   numbers.tex, pending.tex and README.md to be byte-identical to the committed ones, so every
   macro the PDF prints is reproducible from the files in results/ (and the pinned series).
2. Reads the macro -> source table of report/generated/README.md and requires every file named by
   a macro that has a value (results/..., report/..., tools/..., docs/...) to exist.
3. Lists the macros that are still pending (no data yet).

Exits 1 on any mismatch or missing source; prints a one-line summary either way.
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "report" / "generated"
FILES = ("numbers.tex", "pending.tex", "README.md")
PATH_RE = re.compile(r"\b((?:results|report|tools|docs)/[A-Za-z0-9_.\-/<>*]+)")


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
    pending = [macro for macro, value, _ in rows if "pending" in value.lower()]
    for p in problems:
        print("FAIL:", p)
    print(f"check_numbers: {len(rows)} macros, {len(rows) - len(pending)} with values, {checked} source paths checked, "
          f"{len(pending)} pending, "
          f"{len(problems)} problems")
    if pending:
        print("pending:", ", ".join(pending[:40]) + (" ..." if len(pending) > 40 else ""))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
