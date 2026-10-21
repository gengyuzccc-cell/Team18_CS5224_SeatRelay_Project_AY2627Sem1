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
BASELINE_GRAY = "#A3A9B2"


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
    """Three small horizontal bar charts (one axis each): per-session forms vs one queue."""
    facets = [
        ("Duplicate holds per workshop", "ReplayDupHoldEventsPerSessionMean", "ReplayDupHoldEventsUnifiedMean", 1, ""),
        ("Minutes until a freed seat is filled", "ReplayRefillMeanPerSessionMean", "ReplayRefillMeanUnifiedMean", 1, " min"),
        ("Different people who got a seat", "ReplayDistinctPerSessionMean", "ReplayDistinctUnifiedMean", 1, ""),
    ]
    w, gap = 166.0, 18.0          # mm per facet, gap between facets
    label_w, bar_h, row_gap = 0.0, 6.2, 5.4
    parts = []
    for i, (title, before_key, after_key, digits, unit) in enumerate(facets):
        x0 = i * (w + gap)
        before, after = num(m, before_key), num(m, after_key)
        top = max(before, after)
        span = w - 34.0             # room for the value label at the tip
        parts.append(f'<text x="{x0:.1f}" y="7" class="f-title">{esc(title)}</text>')
        for j, (name, value, color) in enumerate((("One form per session", before, BASELINE_GRAY),
                                                   ("SeatRelay", after, BLUE_DATA))):
            y = 13.5 + j * (bar_h + row_gap + 7.2)
            parts.append(f'<text x="{x0:.1f}" y="{y + 4.4:.1f}" class="f-label">{name}</text>')
            by = y + 6.6
            length = span * value / top if top else 0
            if length > 0:
                r = min(1.4, length / 2)
                parts.append(
                    f'<path d="M{x0:.1f},{by:.1f} h{length - r:.2f} q{r},0 {r},{r} v{bar_h - 2 * r:.2f} '
                    f'q0,{r} {-r},{r} h{-(length - r):.2f} z" fill="{color}"/>')
            parts.append(f'<line x1="{x0:.1f}" y1="{by - 1:.1f}" x2="{x0:.1f}" y2="{by + bar_h + 1:.1f}" stroke="{INK2}" stroke-width="0.5"/>')
            shown = f"{value:,.{digits}f}" if value else "0"
            parts.append(f'<text x="{x0 + length + 2.4:.1f}" y="{by + bar_h - 0.9:.1f}" class="f-value">{shown}{unit}</text>')
    total_w = 3 * w + 2 * gap
    return (f'<svg class="facets" viewBox="0 0 {total_w:.0f} 50" width="{total_w:.0f}mm" height="50mm" '
            f'role="img" aria-label="Simulation results: per-session forms versus one queue">{"".join(parts)}</svg>')


def load_chart(m: dict[str, str]) -> str:
    """Client-observed settle p95 vs virtual users, two scenarios, 5 s target (one y axis)."""
    vus = [10, 25, 50]
    words = {10: "Ten", 25: "TwentyFive", 50: "Fifty"}
    series = [
        ("Spread over 10 workshops", BLUE_DATA, [num(m, f"PerfDevCrossVU{words[v]}SettlePNinetyFiveMs") / 1000 for v in vus]),
        ("All on one workshop", ORANGE, [num(m, f"PerfDevHotspotVU{words[v]}SettlePNinetyFiveMs") / 1000 for v in vus]),
    ]
    W, H = 166.0, 104.0
    left, right, top, bottom = 15.0, 34.0, 6.0, 15.0
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
        p.append(f'<text x="{left - 2.4:.1f}" y="{y + 2.2:.2f}" class="c-tick" text-anchor="end">{s} s</text>')
    # target line, labelled; solid and muted (not a gridline: it is the acceptance target)
    ty = Y(5.0)
    p.append(f'<line x1="{left:.1f}" y1="{ty:.2f}" x2="{left + pw:.1f}" y2="{ty:.2f}" stroke="{INK2}" stroke-width="0.6"/>')
    p.append(f'<text x="{left + pw + 2.4:.1f}" y="{ty + 2.2:.2f}" class="c-note">target 5 s</text>')
    for v in vus:
        p.append(f'<text x="{X(v):.1f}" y="{top + ph + 7.2:.1f}" class="c-tick" text-anchor="middle">{v}</text>')
    p.append(f'<text x="{left + pw / 2:.1f}" y="{H - 0.6:.1f}" class="c-axis" text-anchor="middle">people using it at the same time</text>')
    for name, color, values in series:
        pts = " ".join(f"{X(v):.2f},{Y(s):.2f}" for v, s in zip(vus, values))
        p.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="1.0" stroke-linejoin="round" stroke-linecap="round"/>')
        for v, s in zip(vus, values):
            p.append(f'<circle cx="{X(v):.2f}" cy="{Y(s):.2f}" r="1.9" fill="{color}" stroke="{PAPER}" stroke-width="0.8"/>')
        end = values[-1]
        p.append(f'<text x="{X(50) + 3.2:.1f}" y="{Y(end) + 2.3:.2f}" class="c-end">{end:.2f} s</text>')
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
        "ReplayDupPerSession": f"{num(m, 'ReplayDupHoldEventsPerSessionMean'):.1f}",
    }
    html = fill((HERE / "poster.template.html").read_text(encoding="utf-8"), m, extra)
    (HERE / "poster.html").write_text(html, encoding="utf-8")
    print("wrote docs/poster/poster.html")
    if not args.no_render:
        return subprocess.call(["node", str(HERE / "render.mjs")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
