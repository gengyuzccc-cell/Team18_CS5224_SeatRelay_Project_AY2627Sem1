#!/usr/bin/env python3
"""PowerPoint copy of the slides, for presenting from PowerPoint or Keynote.

    python3 -I report/tools/make_pptx.py                         # report/Slides.pdf -> report/Slides.pptx
    python3 -I report/tools/make_pptx.py --pdf report/Slides-submission.pdf --out report/Slides-submission.pptx

The Beamer PDF (report/Slides.tex) stays the source and the file that is submitted. Each PDF page
becomes one 16:9 slide holding a 200 dpi image of that page, so the PowerPoint copy looks exactly
like the PDF (its text is not editable; edit Slides.tex and re-run). The notes of each slide hold
its title and the speaker-notes file for that slide (docs/walkthrough/part-N.md, from the slide
table in docs/walkthrough/README.md); no speaker is named in the deck or its notes.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu, Inches

ROOT = Path(__file__).resolve().parents[2]
WALK = ROOT / "docs" / "walkthrough"
DPI = 200


def page_texts(pdf: Path) -> list[str]:
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(
        ["pdfinfo", str(pdf)], check=True, capture_output=True, text=True).stdout).group(1))
    return [subprocess.run(["pdftotext", "-f", str(p), "-l", str(p), "-layout", str(pdf), "-"],
                           check=True, capture_output=True, text=True).stdout for p in range(1, pages + 1)]


def script_files() -> dict[str, str]:
    """Slide label ("1".."14", "B1".."B8") -> speaker-notes file, via the owner column of the slide
    table in docs/walkthrough/README.md and the Speaker line of each part file."""
    owner_part: dict[str, str] = {}
    for path in sorted(WALK.glob("part-*.md")):
        speaker = re.search(r"\*\*Speakers?:\*\*([^\n]*)", path.read_text(encoding="utf-8"))
        for name in re.findall(r"\b([A-Z]{2,}(?: [A-Z]{2,})+)\b", speaker.group(1) if speaker else ""):
            owner_part.setdefault(name, path.name)
    files: dict[str, str] = {}
    for line in (WALK / "README.md").read_text(encoding="utf-8").splitlines():
        m = re.match(r"\| (B?\d+(?:–B?\d+)?) \| ([^|]*) \|", line)
        if not m:
            continue
        owner = re.search(r"\b([A-Z]{2,}(?: [A-Z]{2,})+)\b", m.group(2))
        part = owner_part.get(owner.group(1)) if owner else None
        if part is None:
            continue
        label = m.group(1)
        span = re.match(r"(B?)(\d+)–B?(\d+)", label)
        if span:
            for n in range(int(span.group(2)), int(span.group(3)) + 1):
                files[f"{span.group(1)}{n}"] = part
        else:
            files[label] = part
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", default=str(ROOT / "report" / "Slides.pdf"))
    ap.add_argument("--out", default=None, help="default: the PDF's name with .pptx")
    args = ap.parse_args()
    pdf = Path(args.pdf)
    out = Path(args.out) if args.out else pdf.with_suffix(".pptx")
    texts = page_texts(pdf)
    scripts = script_files()
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    blank = prs.slide_layouts[6]
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-png", str(pdf), f"{tmp}/s"], check=True)
        images = sorted(Path(tmp).glob("s-*.png"))
        if len(images) != len(texts):
            sys.exit(f"{len(images)} images for {len(texts)} pages")
        for image, text in zip(images, texts):
            slide = prs.slides.add_slide(blank)
            slide.shapes.add_picture(str(image), Emu(0), Emu(0), prs.slide_width, prs.slide_height)
            title = next((line.strip() for line in text.splitlines() if line.strip()), "")
            label = re.search(r"(?:Backup (B\d+)|(\d+)\s*/\s*\d+)\s*$", text.rstrip())
            key = (label.group(1) or label.group(2)) if label else None
            notes = [title]
            if key in scripts:
                notes.append(f"Speaker notes: docs/walkthrough/{scripts[key]}")
            slide.notes_slide.notes_text_frame.text = "\n".join(notes)
    prs.save(out)
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out} ({len(texts)} slides, {DPI} dpi)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
