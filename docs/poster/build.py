#!/usr/bin/env python3
"""Build the STePS poster (A1 portrait) from report/generated/numbers.tex.

    python3 -I docs/poster/build.py            # writes docs/poster/poster.html, then renders it
    python3 -I docs/poster/build.py --no-render

Every measured value on the poster is a macro of report/generated/numbers.tex (which
report/tools/report_numbers.py generates from results/), filled into poster.template.html as
{{MacroName}}; the two charts are drawn here from the same macros. render.mjs then prints the page
with Chromium (Playwright from tools/e2e) to:

    docs/poster/seatrelay-steps-poster.png   A1 at 150 dpi (3508 x 4967 px), the "poster image"
    docs/poster/seatrelay-steps-poster.pdf   A1 vector PDF for printing
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NUMBERS = ROOT / "report" / "generated" / "numbers.tex"

PAPER = "#FBFAF7"
INK = "#1B2430"
INK2 = "#4A5361"
MUTED = "#7A8290"
GRID = "#E3E0D8"
BLUE_DATA = "#2867B2"   # validated pair (dataviz validate_palette.js, light surface #FBFAF7)
ORANGE = "#E07000"
BASELINE_GRAY = "#878E99"


def macros() -> dict[str, str]:
    text = NUMBERS.read_text(encoding="utf-8")
    found = {}
    for name, value in re.findall(r"\\newcommand\{\\([A-Za-z]+)\}\{(.*)\}", text):
        found[name] = value.replace("{,}", ",")
    return found


def num(m: dict[str, str], name: str) -> float:
    value = m[name]
    if "pending" in value:
        sys.exit(f"{name} is pending in numbers.tex; the poster only shows measured values")
    return float(value.replace(",", ""))


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def comparison_facets(m: dict[str, str]) -> str:
    """Three small horizontal bar charts (one axis each): a separate automatic waitlist per session
    vs one queue, from the mechanism replay (results/replay/)."""
    facets = [
        ("Second seats held at the end", "ReplayDupConfirmedPerSessionMean", "ReplayDupConfirmedUnifiedMean",
         lambda v: f"{v:.1f}" if v else "0 (not allowed)"),
        ("Minutes to refill a freed seat", "ReplayRefillMeanPerSessionMedian", "ReplayRefillMeanUnifiedMedian",
         lambda v: f"{v:.1f} min"),
        ("Seats given to different people", "ReplayFillRatePerSessionMean", "ReplayFillRateUnifiedMean",
         lambda v: f"{v * 100:.1f} %"),
    ]
    w, gap = 166.0, 18.0          # mm per facet (the three-column grid below), gap between facets
    bar_h = 8.0
    parts = []
    for i, (title, before_key, after_key, show) in enumerate(facets):
        x0 = i * (w + gap)
        before, after = num(m, before_key), num(m, after_key)
        top = max(before, after)
        span = w - 56.0             # room for the value label at the tip
        parts.append(f'<text x="{x0:.1f}" y="8" class="f-title">{esc(title)}</text>')
        for j, (name, value, color) in enumerate((("Separate waitlist per session", before, BASELINE_GRAY),
                                                   ("SeatRelay, one queue", after, BLUE_DATA))):
            y = 16 + j * 25
            parts.append(f'<text x="{x0:.1f}" y="{y + 5.6:.1f}" class="f-label">{name}</text>')
            by = y + 8.4
            length = span * value / top if top else 0
            if length > 0:
                r = min(1.6, length / 2)
                parts.append(
                    f'<path d="M{x0:.1f},{by:.1f} h{length - r:.2f} q{r},0 {r},{r} v{bar_h - 2 * r:.2f} '
                    f'q0,{r} {-r},{r} h{-(length - r):.2f} z" fill="{color}"/>')
            parts.append(f'<line x1="{x0:.1f}" y1="{by - 1:.1f}" x2="{x0:.1f}" y2="{by + bar_h + 1:.1f}" stroke="{INK2}" stroke-width="0.5"/>')
            parts.append(f'<text x="{x0 + length + 2.6:.1f}" y="{by + bar_h - 0.6:.1f}" class="f-value">{esc(show(value))}</text>')
    total_w = 3 * w + 2 * gap
    return (f'<svg class="facets" viewBox="-0.5 0 {total_w + 1:.0f} 63" width="{total_w + 1:.0f}mm" height="63mm" '
            f'role="img" aria-label="Simulation results: a separate waitlist per session versus one queue">{"".join(parts)}</svg>')


def load_chart(m: dict[str, str]) -> str:
    """Client-observed settle p95 vs virtual users, two scenarios, 5 s target (one y axis)."""
    vus = [10, 25, 50]
    words = {10: "Ten", 25: "TwentyFive", 50: "Fifty"}
    series = [
        ("Spread over 10 workshops", BLUE_DATA, [num(m, f"PerfDevCrossVU{words[v]}SettlePNinetyFiveMs") / 1000 for v in vus]),
        ("All on one workshop", ORANGE, [num(m, f"PerfDevHotspotVU{words[v]}SettlePNinetyFiveMs") / 1000 for v in vus]),
    ]
    W, H = 166.0, 86.0
    left, right, top, bottom = 17.0, 32.0, 6.0, 24.0
    pw, ph = W - left - right, H - top - bottom
    ymax = 5.5

    def X(v: float) -> float:
        return left + (v - 10) / 40 * pw

    def Y(s: float) -> float:
        return top + ph - s / ymax * ph

    p = []
    for s in range(0, 6):
        y = Y(s)
        p.append(f'<line x1="{left:.1f}" y1="{y:.2f}" x2="{left + pw:.1f}" y2="{y:.2f}" stroke="{GRID}" stroke-width="0.35"/>')
        p.append(f'<text x="{left - 2.6:.1f}" y="{y + 2.4:.2f}" class="c-tick" text-anchor="end">{s} s</text>')
    # target line, labelled; solid and muted (not a gridline: it is the acceptance target)
    ty = Y(5.0)
    p.append(f'<line x1="{left:.1f}" y1="{ty:.2f}" x2="{left + pw:.1f}" y2="{ty:.2f}" stroke="{INK2}" stroke-width="0.6"/>')
    p.append(f'<text x="{left + pw + 2.6:.1f}" y="{ty + 2.4:.2f}" class="c-note">target</text>')
    for v in vus:
        p.append(f'<text x="{X(v):.1f}" y="{top + ph + 8.6:.1f}" class="c-tick" text-anchor="middle">{v}</text>')
    p.append(f'<text x="{left + pw / 2:.1f}" y="{H - 3.2:.1f}" class="c-axis" text-anchor="middle">simulated users (k6), each registering non-stop</text>')
    for name, color, values in reversed(series):  # the blue series last, so its first marker is not hidden
        pts = " ".join(f"{X(v):.2f},{Y(s):.2f}" for v, s in zip(vus, values))
        p.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="1.0" stroke-linejoin="round" stroke-linecap="round"/>')
        for v, s in zip(vus, values):
            p.append(f'<circle cx="{X(v):.2f}" cy="{Y(s):.2f}" r="1.9" fill="{color}" stroke="{PAPER}" stroke-width="0.8"/>')
        end = values[-1]
        p.append(f'<text x="{X(50) + 3.4:.1f}" y="{Y(end) + 2.6:.2f}" class="c-end">{end:.2f} s</text>')
    return (f'<svg class="chart" viewBox="0 0 {W:.0f} {H:.0f}" width="{W:.0f}mm" height="{H:.0f}mm" role="img" '
            f'aria-label="Load test: time from request to final answer, 95th percentile, by number of concurrent users">'
            f'{"".join(p)}</svg>')


def fill(template: str, m: dict[str, str], extra: dict[str, str]) -> str:
    def repl(match: re.Match) -> str:
        key = match.group(1)
        if key in extra:
            return extra[key]
        if key not in m:
            sys.exit(f"unknown macro {{{{{key}}}}} in the poster template")
        if "pending" in m[key]:
            sys.exit(f"{key} is pending in numbers.tex; the poster only shows measured values")
        return esc(m[key])
    return re.sub(r"\{\{([A-Za-z]+)\}\}", repl, template)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-render", action="store_true", help="write poster.html only")
    args = ap.parse_args()
    m = macros()
    extra = {
        "FACETS": comparison_facets(m),
        "LOADCHART": load_chart(m),
        "BackfillPNinetyFiveS": f"{num(m, 'BackfillExpiredPNinetyFiveS'):.2f}",
        "SettleCrossFiftyS": f"{num(m, 'PerfDevCrossVUFiftySettlePNinetyFiveMs') / 1000:.2f}",
        "SettleHotFiftyS": f"{num(m, 'PerfDevHotspotVUFiftySettlePNinetyFiveMs') / 1000:.2f}",
        "RecoveryMin": f"{num(m, 'FailureBeforeCommitSettleMedianS') / 60:.0f}",
        "RefillMeanPerSession": f"{num(m, 'ReplayRefillMeanPerSessionMean'):.1f}",
        "RefillMeanUnified": f"{num(m, 'ReplayRefillMeanUnifiedMean'):.1f}",
        "CrossoverThousands": f"{round(num(m, 'CostCrossoverListFullRegs') / 1000):.0f},000",
    }
    html = fill((HERE / "poster.template.html").read_text(encoding="utf-8"), m, extra)
    (HERE / "poster.html").write_text(html, encoding="utf-8")
    print("wrote docs/poster/poster.html")
    if not args.no_render:
        return subprocess.call(["node", str(HERE / "render.mjs")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
