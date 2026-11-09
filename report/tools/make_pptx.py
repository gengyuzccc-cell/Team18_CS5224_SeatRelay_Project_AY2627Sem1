#!/usr/bin/env python3
"""PowerPoint copy of the slides, for presenting from PowerPoint, Keynote or WPS.

    python3 -I report/tools/make_pptx.py                         # report/Slides.pdf -> report/Slides.pptx
    python3 -I report/tools/make_pptx.py --pdf report/Slides-submission.pdf --out report/Slides-submission.pptx

The Beamer PDF (report/Slides.tex) stays the source and the file that is submitted. Each PDF page
becomes one 16:9 slide holding a 200 dpi image of that page, so the PowerPoint copy looks exactly
like the PDF (its text is not editable; edit Slides.tex and re-run). Every web link of the PDF
(\\url, \\href) stays clickable: a transparent link area sits over it (needs pypdf; without it the
copy is written without links). The notes of each slide hold its title and the speaker-notes file
for that slide (docs/walkthrough/part-N.md, from the slide table in docs/walkthrough/README.md);
no speaker is named in the deck or its notes.

Compatibility: the deck is a true widescreen deck (13.333 x 7.5 in, no 4:3 size type), and the
document properties (title, author, dates, slide count) are written fresh instead of the
python-pptx template's, so PowerPoint, Keynote, WPS and LibreOffice all open it without a repair
prompt. The script re-opens the written file and checks it before it reports success.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Emu

ROOT = Path(__file__).resolve().parents[2]
WALK = ROOT / "docs" / "walkthrough"
DPI = 200
SLIDE_W, SLIDE_H = Emu(12192000), Emu(6858000)  # PowerPoint's own 16:9 widescreen size
TITLE = "SeatRelay: CS5224 Group 18 presentation"
AUTHOR = "CS5224 Group 18"


def page_texts(pdf: Path) -> list[str]:
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(
        ["pdfinfo", str(pdf)], check=True, capture_output=True, text=True).stdout).group(1))
    return [subprocess.run(["pdftotext", "-f", str(p), "-l", str(p), "-layout", str(pdf), "-"],
                           check=True, capture_output=True, text=True).stdout for p in range(1, pages + 1)]


def page_links(pdf: Path) -> dict[int, list[tuple[float, float, float, float, str]]]:
    """1-based page -> [(left, top, width, height) as fractions of the page, uri] for each web link."""
    try:
        from pypdf import PdfReader
    except ImportError:
        print("make_pptx: pypdf not installed; the copy is written without clickable links", file=sys.stderr)
        return {}
    links: dict[int, list[tuple[float, float, float, float, str]]] = {}
    for number, page in enumerate(PdfReader(str(pdf)).pages, 1):
        box = page.mediabox
        x_min, y_min = float(box.left), float(box.bottom)
        width, height = float(box.width), float(box.height)
        for annot in page.get("/Annots") or []:
            annot = annot.get_object()
            action = annot.get("/A")
            uri = action.get("/URI") if action is not None else None
            if annot.get("/Subtype") != "/Link" or not uri:
                continue
            x0, y0, x1, y1 = (float(v) for v in annot["/Rect"])
            x0, x1 = sorted((x0, x1))
            y0, y1 = sorted((y0, y1))
            links.setdefault(number, []).append((
                (x0 - x_min) / width, (height - (y1 - y_min)) / height,
                (x1 - x0) / width, (y1 - y0) / height, str(uri)))
    return links


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


def add_link_area(slide, left: int, top: int, width: int, height: int, uri: str) -> None:
    """A transparent rectangle over a link of the page image: clickable in the slide show, invisible.
    It gets a 0 %-opacity fill rather than no fill, since PowerPoint only reacts to clicks on the
    filled area of a shape, and no theme style, so it casts no shadow."""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(left), Emu(top), Emu(width), Emu(height))
    shape.name = f"Link: {uri}"
    shape._element.nvSpPr.cNvPr.set("descr", uri)
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    colour = shape._element.spPr.find(qn("a:solidFill")).find(qn("a:srgbClr"))
    etree.SubElement(colour, qn("a:alpha")).set("val", "0")
    shape.line.fill.background()
    style = shape._element.find(qn("p:style"))
    if style is not None:
        shape._element.remove(style)
    shape.click_action.hyperlink.address = uri


def app_xml(slides: int) -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        '<TotalTime>0</TotalTime><Words>0</Words><Application>Microsoft Office PowerPoint</Application>'
        '<PresentationFormat>Widescreen</PresentationFormat><Paragraphs>0</Paragraphs>'
        f'<Slides>{slides}</Slides><Notes>{slides}</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips>'
        '<ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
        '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>'
    ).encode()


def thumbnail(png: Path) -> bytes | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    with Image.open(png) as image:
        small = image.convert("RGB")
        small.thumbnail((320, 180))
        buffer = io.BytesIO()
        small.save(buffer, "JPEG", quality=85)
        return buffer.getvalue()


def finish_package(out: Path, slides: int, thumb: bytes | None) -> None:
    """Rewrite the package with fresh extended properties (the template's say 0 slides, 4:3) and a
    thumbnail of slide 1 in place of the template's; every other part is copied unchanged."""
    with zipfile.ZipFile(out) as source:
        parts = [(info, source.read(info.filename)) for info in source.infolist()]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for info, data in parts:
            if info.filename == "docProps/app.xml":
                data = app_xml(slides)
            elif info.filename == "docProps/thumbnail.jpeg" and thumb is not None:
                data = thumb
            target.writestr(info.filename, data, compress_type=zipfile.ZIP_DEFLATED)


def check(out: Path, slides: int, links: int) -> None:
    """Re-open the written file: zip CRCs, every XML part well-formed, slide/link counts as built."""
    with zipfile.ZipFile(out) as package:
        bad = package.testzip()
        if bad is not None:
            sys.exit(f"{out}: corrupt zip member {bad}")
        names = package.namelist()
        if len(names) != len(set(names)):
            sys.exit(f"{out}: duplicate zip members")
        for name in names:
            if name.endswith((".xml", ".rels")):
                etree.fromstring(package.read(name))
    deck = Presentation(str(out))
    if len(deck.slides) != slides:
        sys.exit(f"{out}: {len(deck.slides)} slides, expected {slides}")
    found = sum(1 for slide in deck.slides for shape in slide.shapes
                if shape.click_action.hyperlink.address)
    if found != links:
        sys.exit(f"{out}: {found} links, expected {links}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", default=str(ROOT / "report" / "Slides.pdf"))
    ap.add_argument("--out", default=None, help="default: the PDF's name with .pptx")
    args = ap.parse_args()
    pdf = Path(args.pdf)
    out = Path(args.out) if args.out else pdf.with_suffix(".pptx")
    texts = page_texts(pdf)
    links = page_links(pdf)
    scripts = script_files()
    prs = Presentation()
    prs.slide_width, prs.slide_height = SLIDE_W, SLIDE_H
    prs._element.sldSz.attrib.pop("type", None)  # the template says screen4x3
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0, tzinfo=None)
    core = prs.core_properties
    core.title, core.author, core.last_modified_by = TITLE, AUTHOR, AUTHOR
    core.subject, core.comments, core.keywords = "", "", ""
    core.created = core.modified = now
    core.revision = 1
    blank = prs.slide_layouts[6]
    link_count = 0
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-png", str(pdf), f"{tmp}/s"], check=True)
        images = sorted(Path(tmp).glob("s-*.png"))
        if len(images) != len(texts):
            sys.exit(f"{len(images)} images for {len(texts)} pages")
        for number, (image, text) in enumerate(zip(images, texts), 1):
            slide = prs.slides.add_slide(blank)
            title = next((line.strip() for line in text.splitlines() if line.strip()), "")
            picture = slide.shapes.add_picture(str(image), Emu(0), Emu(0), prs.slide_width, prs.slide_height)
            picture.name = f"Slide {number}"
            picture._element.nvPicPr.cNvPr.set("descr", title or f"Slide {number}")
            for left, top, width, height, uri in links.get(number, []):
                add_link_area(slide, int(left * SLIDE_W), int(top * SLIDE_H),
                              int(width * SLIDE_W), int(height * SLIDE_H), uri)
                link_count += 1
            label = re.search(r"(?:Backup (B\d+)|(\d+)\s*/\s*\d+)\s*$", text.rstrip())
            key = (label.group(1) or label.group(2)) if label else None
            notes = [title]
            if key in scripts:
                notes.append(f"Speaker notes: docs/walkthrough/{scripts[key]}")
            slide.notes_slide.notes_text_frame.text = "\n".join(notes)
        prs.save(out)
        finish_package(out, len(texts), thumbnail(images[0]))
    check(out, len(texts), link_count)
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out} "
          f"({len(texts)} slides, {DPI} dpi, {link_count} clickable links)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
