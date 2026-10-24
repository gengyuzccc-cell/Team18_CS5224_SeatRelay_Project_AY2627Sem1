#!/usr/bin/env python3
"""Will the report still fit when the missing data arrive?

    python3 -I report/tools/page_budget_check.py [-m 10]

Copies report/ to a temporary directory, replaces the body of every pending macro in
generated/numbers.tex with a dummy value ("00.0"), so every \\IfPending switch takes its with-data
branch (interviews, user study, pilot and any other missing run), builds Final.tex there and prints
the page count and any overfull box. Nothing in report/ is changed. Run it after every edit to the
report text (docs/SUBMISSION-CHECKLIST.md, row 3.1): the real values are about as long as the dummy
ones, so a pass here means the final build will also fit.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPORT = Path(__file__).resolve().parents[1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-m", "--max-pages", type=int, default=10)
    args = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "report"
        shutil.copytree(REPORT, work, ignore=shutil.ignore_patterns("*.pdf", "*.aux", "*.log", "*.fdb_latexmk", "*.fls", "*.bbl", "*.bcf", "*.blg", "*.run.xml", "*.out", "*.nav", "*.snm", "*.toc"))
        for pdf in (REPORT / "figures").rglob("*.pdf"):
            target = work / pdf.relative_to(REPORT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(pdf, target)
        numbers = work / "generated" / "numbers.tex"
        text = numbers.read_text(encoding="utf-8")
        filled, count = re.subn(r"(\\newcommand\{\\[A-Za-z]+\}\{)\\pending\{.*\}\}$", r"\g<1>00.0}", text, flags=re.M)
        numbers.write_text(filled, encoding="utf-8")
        build = subprocess.run(["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", "Final.tex"],
                               cwd=work, capture_output=True, text=True)
        if build.returncode != 0:
            print(build.stdout[-3000:])
            sys.exit("page budget check: LaTeX build failed")
        pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(work / "Final.pdf")],
                                                                capture_output=True, text=True).stdout).group(1))
        log = (work / "Final.log").read_text(encoding="utf-8", errors="replace")
        overfull = len(re.findall(r"Overfull \\[hv]box", log))
        leftover = len(re.findall(r"\\pending\{", filled))
    ok = pages <= args.max_pages and overfull == 0
    print(f"page budget check: {count} pending macros filled with dummy values ({leftover} left), "
          f"pages={pages} (max {args.max_pages}), overfull={overfull}: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
