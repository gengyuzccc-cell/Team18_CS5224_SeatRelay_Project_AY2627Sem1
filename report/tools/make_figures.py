#!/usr/bin/env python3
"""Result charts of the Final report, as PDF, from the files under ``results/``.

Writes ``report/figures/generated/<name>.pdf`` plus ``manifest.md`` (which source file each chart
was drawn from). A chart whose input does not exist yet is skipped with a note; the script never
stops on a missing or empty file. Run it again whenever ``results/`` changes (idempotent: the
same inputs give byte-identical PDFs).

    python3 -I report/tools/make_figures.py [--results DIR] [--out DIR] [--target dev]

Charts (sizes in cm; fonts 8 pt; no titles: the captions live in the LaTeX source)
  replay-comparison.pdf  17 x 5.2  UNIFIED vs PER_SESSION per seed: duplicate-hold events,
                                   distinct participants served / capacity, seat refill time
  replay-paired.pdf      17 x 6.2  the same seeds paired: distinct served and refill time,
                                   UNIFIED (x) against PER_SESSION (y)
  cost-crossover.pdf     8.5 x 6.4 monthly cost vs registrations/month: cloud list price and
                                   after free tier, on-prem fully amortised and increment only
  cost-unit.pdf          8.5 x 6.4 the same as cost per 1,000 registrations
  backfill-latency.pdf   17 x 4.4  expiry-driven backfill latency: histogram and ECDF (latest
                                   results/<date>-backfill of the target)
  settle-latency.pdf     17 x 5.2  command settle latency ECDFs, server-side and client-observed,
                                   one curve per functional experiment (smoke, correctness, ...)
  loadtest-p95.pdf       17 x 5.0  k6 matrix of the report target: p95 per VU level per scenario
  study-completion.pdf   17 x 5.2  user study: task completion by task and condition
  study-sus.pdf          8.5 x 5.0 user study: SUS per participant, paired
  study-time.pdf         8.5 x 5.0 user study: total task time per participant, paired

Percentiles are nearest-rank (tools/experiments/src/lib/results.ts), so markers match summary.md.
Dependencies: pandas and matplotlib only.
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import sys
import traceback
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
db.ensure_user_site()

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.ticker import FixedLocator, FuncFormatter, LogLocator, NullFormatter  # noqa: E402

CM = 1 / 2.54
WIDE, NARROW = 17 * CM, 8.5 * CM

# Categorical slots in fixed order (validated palette: adjacent CVD dE >= 9.1; slots 3-4 below
# 3:1 contrast on white, so every series also carries a line style / marker and a legend label).
BLUE, ORANGE, GREEN, YELLOW, PURPLE, PINK = "#2A78D6", "#EB6834", "#1BAF7A", "#EDA100", "#6250D6", "#E87BA4"
INK, MUTED, GRID = "#1F1F1D", "#52514E", "#E4E3DF"
MODE_COLOR = {"UNIFIED": BLUE, "PER_SESSION": ORANGE}
SCENARIO_LABEL = {"cross-workshop": "cross-workshop", "hotspot": "hot spot"}
# slide charts: drawn at their size on the 13.33 x 7.5 in slide, so the point sizes are what is projected
SLIDE_SIZE = (6.0, 3.5)
SLIDE_RC = {"font.size": 16, "axes.labelsize": 16, "xtick.labelsize": 15, "ytick.labelsize": 15,
            "legend.fontsize": 14, "axes.linewidth": 1.0, "xtick.major.width": 1.0, "ytick.major.width": 1.0,
            "xtick.major.size": 5, "ytick.major.size": 5}
COND_COLOR = {"SR": BLUE, "CTRL": ORANGE}
# Settle-latency series: colour follows the experiment, never its rank.
EXPERIMENT_STYLE = {
    "smoke": (BLUE, "solid"),
    "correctness": (ORANGE, "solid"),
    "preference-order": (GREEN, (0, (5, 1.5))),
    "concurrency": (YELLOW, (0, (5, 1.5))),
}

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 8,
    "axes.labelsize": 8,
    "axes.titlesize": 8,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "legend.fontsize": 8,
    "axes.edgecolor": MUTED,
    "axes.labelcolor": INK,
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "text.color": INK,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.6,
    "ytick.major.width": 0.6,
    "xtick.major.size": 2.5,
    "ytick.major.size": 2.5,
    "xtick.minor.size": 1.5,
    "ytick.minor.size": 1.5,
    "lines.linewidth": 1.4,
    "legend.frameon": False,
    "legend.handlelength": 2.2,
    "pdf.fonttype": 42,
    "savefig.dpi": 300,
    "figure.dpi": 100,
})


class Run:
    """Bookkeeping: what was drawn, from which files, and what was skipped."""

    def __init__(self, out: Path) -> None:
        self.out = out
        self.made: list[tuple[str, str, list[str]]] = []
        self.skipped: list[tuple[str, str]] = []
        self.notes: list[str] = []

    def save(self, fig, name: str, what: str, sources: list[str]) -> None:
        path = self.out / f"{name}.pdf"
        fig.savefig(path, format="pdf", metadata={"CreationDate": None, "ModDate": None, "Producer": None, "Creator": None})
        plt.close(fig)
        self.made.append((name, what, sources))

    def skip(self, name: str, why: str) -> None:
        self.skipped.append((name, why))


def style(ax, grid_axis: str = "y") -> None:
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    if grid_axis:
        ax.grid(True, axis=grid_axis, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def panel_letter(ax, letter: str) -> None:
    ax.text(-0.02, 1.02, f"({letter})", transform=ax.transAxes, ha="right", va="bottom", fontsize=9, fontweight="bold", color=INK)


def thousands(value, _pos=None) -> str:
    if value >= 1000:
        return f"{value / 1000:g}k" if value < 1_000_000 else f"{value / 1_000_000:g}M"
    return f"{value:g}"


def ecdf(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ordered = np.sort(values)
    return ordered, np.arange(1, ordered.size + 1) / ordered.size


# ============================================================================ replay

def replay_dir(runs, results: Path) -> Path | None:
    dated = sorted((r for r in runs.get("replay", []) if (r.path / "raw.csv").exists()), key=lambda r: (r.date, r.suffix), reverse=True)
    if dated:
        return dated[0].path
    return results / "replay" if (results / "replay" / "raw.csv").exists() else None


def box(ax, data: list[np.ndarray], colors: list[str], labels: list[str]) -> None:
    """Box = p25-p75, line = median, whiskers = p5-p95 (as results/replay/summary.md), diamond = mean."""
    parts = ax.boxplot(data, positions=range(len(data)), widths=0.5, whis=(5, 95), showfliers=False,
                       patch_artist=True, showmeans=True,
                       meanprops={"marker": "D", "markersize": 3.6, "markerfacecolor": "white", "markeredgecolor": INK, "markeredgewidth": 0.7},
                       medianprops={"color": INK, "linewidth": 1.1},
                       whiskerprops={"color": MUTED, "linewidth": 0.8}, capprops={"color": MUTED, "linewidth": 0.8})
    for patch, color in zip(parts["boxes"], colors):
        patch.set_facecolor(color + "55")
        patch.set_edgecolor(color)
        patch.set_linewidth(1.0)
    ax.set_xticks(range(len(data)), labels)
    ax.set_xlim(-0.6, len(data) - 0.4)


def chart_replay(run: Run, runs, results: Path) -> None:
    directory = replay_dir(runs, results)
    if directory is None:
        run.skip("replay-comparison", "no results/replay/raw.csv")
        run.skip("replay-paired", "no results/replay/raw.csv")
        return
    frame = db.read_csv(directory / "raw.csv", run.notes)
    needed = {"seed", "mode", "dup_hold_events", "fill_rate", "seat_refill_min_mean", "distinct_served"}
    if frame is None or not needed.issubset(frame.columns):
        run.skip("replay-comparison", f"{rel(directory / 'raw.csv')} lacks {sorted(needed - set(frame.columns if frame is not None else []))}")
        return
    modes = ["UNIFIED", "PER_SESSION"]
    colors = [MODE_COLOR[m] for m in modes]
    by = {m: frame[frame["mode"] == m] for m in modes}
    fig, axes = plt.subplots(1, 3, figsize=(WIDE, 5.2 * CM), constrained_layout=True)
    # (a) duplicate-hold events
    ax = axes[0]
    box(ax, [by[m]["dup_hold_events"].to_numpy(float) for m in modes], colors, modes)
    if (by["UNIFIED"]["dup_hold_events"] == 0).all():
        ax.annotate("0 in every workshop (C2)", xy=(0, 0), xytext=(-0.22, 9), textcoords=("data", "offset points"), ha="left", fontsize=7.5, color=MUTED)
    ax.set_ylabel("duplicate-hold events per workshop")
    ax.set_ylim(bottom=-2)
    style(ax)
    panel_letter(ax, "a")
    # (b) distinct participants served as share of capacity
    ax = axes[1]
    box(ax, [100 * by[m]["fill_rate"].to_numpy(float) for m in modes], colors, modes)
    ax.set_ylabel("distinct served / capacity (%)")
    style(ax)
    panel_letter(ax, "b")
    # (c) seat refill time, per-run mean
    ax = axes[2]
    data = [by[m]["seat_refill_min_mean"].dropna().to_numpy(float) for m in modes]
    data = [d[d > 0] for d in data]
    box(ax, data, colors, modes)
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
    ax.yaxis.set_minor_formatter(NullFormatter())
    ax.set_ylabel("mean seat refill time (min)")
    style(ax)
    panel_letter(ax, "c")
    zero = sum(int((by[m]["seat_refill_min_mean"] == 0).sum()) for m in modes)
    if zero:
        run.notes.append(f"replay-comparison (c): {zero} run(s) with a refill mean of exactly 0 min not drawn on the log axis")
    run.save(fig, "replay-comparison", "UNIFIED vs PER_SESSION per seed (box p25-p75, median line, whiskers p5-p95, diamond = mean)",
             [f"{rel(directory)}/raw.csv: dup_hold_events, fill_rate, seat_refill_min_mean by mode"])

    # Slide version (report/Slides.tex, slide 10): panel (a) alone, drawn at the size it is shown on
    # the 13.33 in slide (6.0 x 3.5 in) with 16 pt text, so nothing is scaled down when projected.
    with plt.rc_context(SLIDE_RC):
        fig, ax = plt.subplots(figsize=SLIDE_SIZE, constrained_layout=True)
        box(ax, [by[m]["dup_hold_events"].to_numpy(float) for m in modes], colors, ["one queue", "per-session forms"])
        if (by["UNIFIED"]["dup_hold_events"] == 0).all():
            ax.annotate("0 in every\nworkshop", xy=(0, 0), xytext=(-0.25, 14), textcoords=("data", "offset points"), ha="left", color=MUTED)
        ax.set_ylabel("duplicate holds\nper workshop")
        ax.set_ylim(bottom=-2)
        style(ax)
        run.save(fig, "slide-replay", "slide 10: duplicate-hold events per simulated workshop by mode (box p25-p75, median, whiskers p5-p95, diamond = mean)",
                 [f"{rel(directory)}/raw.csv: dup_hold_events by mode"])

    # paired scatter
    wide = frame.pivot_table(index="seed", columns="mode", values=["distinct_served", "seat_refill_min_mean"], aggfunc="first")
    fig, axes = plt.subplots(1, 2, figsize=(WIDE, 6.2 * CM), constrained_layout=True)
    ax = axes[0]
    pair = wide["distinct_served"].dropna()
    ax.scatter(pair["UNIFIED"], pair["PER_SESSION"], s=5, color=BLUE, alpha=0.45, linewidths=0)
    top = float(max(pair.max().max(), 1)) * 1.04
    ax.plot([0, top], [0, top], color=MUTED, linewidth=0.8, linestyle=(0, (4, 3)))
    below = 100.0 * (pair["PER_SESSION"] < pair["UNIFIED"]).mean()
    ax.text(0.04, 0.96, f"{below:.1f}% of {len(pair):,} seeds\nbelow y = x", transform=ax.transAxes, ha="left", va="top", fontsize=7.5, color=MUTED)
    ax.set_xlim(0, top)
    ax.set_ylim(0, top)
    ax.set_aspect("equal", adjustable="box")
    ax.set_xlabel("UNIFIED: distinct served (people)")
    ax.set_ylabel("PER_SESSION: distinct served")
    style(ax, "both")
    panel_letter(ax, "a")
    ax = axes[1]
    every = wide["seat_refill_min_mean"].dropna()
    above = 100.0 * (every["PER_SESSION"] > every["UNIFIED"]).mean()
    pair = every[(every["UNIFIED"] > 0) & (every["PER_SESSION"] > 0)]
    if len(pair) < len(every):
        run.notes.append(f"replay-paired (b): {len(every) - len(pair)} seed(s) with a refill mean of 0 min not drawn on the log axes (counted in the share)")
    ax.scatter(pair["UNIFIED"], pair["PER_SESSION"], s=5, color=ORANGE, alpha=0.45, linewidths=0)
    lo = float(min(pair.min().min(), 0.1))
    hi = float(pair.max().max()) * 1.3
    ax.plot([lo, hi], [lo, hi], color=MUTED, linewidth=0.8, linestyle=(0, (4, 3)))
    ax.text(0.97, 0.04, f"{above:.1f}% of {len(every):,} seeds\nabove y = x", transform=ax.transAxes, ha="right", va="bottom", fontsize=7.5, color=MUTED)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(lo, hi)
    ax.set_ylim(lo, hi)
    ax.set_aspect("equal", adjustable="box")
    fmt = FuncFormatter(lambda v, _p: f"{v:g}")
    ax.xaxis.set_major_formatter(fmt)
    ax.yaxis.set_major_formatter(fmt)
    ax.xaxis.set_minor_formatter(NullFormatter())
    ax.yaxis.set_minor_formatter(NullFormatter())
    ax.set_xlabel("UNIFIED: seat refill, run mean (min)")
    ax.set_ylabel("PER_SESSION: refill (min)")
    style(ax, "both")
    panel_letter(ax, "b")
    run.save(fig, "replay-paired", "per-seed pairs, UNIFIED on x, PER_SESSION on y, dashed y = x",
             [f"{rel(directory)}/raw.csv: distinct_served, seat_refill_min_mean pivoted by seed"])


# ============================================================================ cost

COST_SERIES = (
    ("cloud_list", "cloud, list price", BLUE, "solid"),
    ("cloud_after_free", "cloud, after free tier", BLUE, (0, (4, 2))),
    ("onprem_full", "on-prem, fully amortised", ORANGE, "solid"),
    ("onprem_increment", "on-prem, increment only", ORANGE, (0, (4, 2))),
)
COST_TIERS = (1_000, 10_000, 100_000)


def crossover_points(results: Path, notes: list[str]) -> list[tuple[float, float]]:
    path = results / "cost" / "model-summary.md"
    if not path.exists():
        return []
    points = []
    for table in db.markdown_tables(path.read_text(encoding="utf-8")):
        if table and "crossover_registrations" in table[0]:
            for row in table:
                try:
                    points.append((float(row["crossover_registrations"].replace(",", "")), float(row["usd_per_month_at_crossover"].replace(",", ""))))
                except (KeyError, ValueError):
                    notes.append(f"{rel(path)}: crossover row not numeric: {row}")
    return points


def chart_cost(run: Run, results: Path) -> None:
    path = results / "cost" / "crossover-curve.csv"
    frame = db.read_csv(path, run.notes)
    if frame is None or "registrations" not in frame.columns:
        run.skip("cost-crossover", f"no {rel(path)}")
        run.skip("cost-unit", f"no {rel(path)}")
        return
    present = [s for s in COST_SERIES if s[0] in frame.columns]
    points = crossover_points(results, run.notes)
    for name, per_k in (("cost-crossover", False), ("cost-unit", True)):
        fig, ax = plt.subplots(figsize=(NARROW, 6.4 * CM), constrained_layout=True)
        x = frame["registrations"].to_numpy(float)
        for column, label, color, dash in present:
            y = frame[column].to_numpy(float)
            if per_k:
                y = y / (x / 1000.0)
            mask = y > 0
            ax.plot(x[mask], y[mask], color=color, linestyle=dash, linewidth=1.4, label=label.replace("fully amortised", "full").replace("increment only", "increment"))
        for tier in COST_TIERS:
            if x.min() <= tier <= x.max():
                ax.axvline(tier, color=GRID, linewidth=0.8, zorder=0)
        if not per_k and points:
            ax.scatter([p[0] for p in points], [p[1] for p in points], s=14, facecolor="white", edgecolor=INK, linewidth=0.8, zorder=5, label="crossover")
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.xaxis.set_major_locator(LogLocator(base=10, numticks=12))
        ax.xaxis.set_minor_formatter(NullFormatter())
        ax.yaxis.set_minor_formatter(NullFormatter())
        ax.xaxis.set_major_formatter(FuncFormatter(thousands))
        ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
        ax.set_xlabel("registrations per month")
        ax.set_ylabel("USD per 1,000 registrations" if per_k else "USD per month")
        ax.set_xlim(x.min(), x.max())
        style(ax, "both")
        fig.legend(loc="outside upper center", ncol=2, columnspacing=0.8, handlelength=2.0)
        sources = [f"{rel(path)}: " + ", ".join(c for c, *_ in present)]
        if not per_k and points:
            sources.append(f"{rel(results / 'cost' / 'model-summary.md')}: section 3 crossover points")
        what = ("monthly cost by registrations (log-log), on-prem at the model's amortisation period; after-credits layer is 0 and not drawn"
                if not per_k else "cost per 1,000 registrations (log-log)")
        run.save(fig, name, what, sources)


# ============================================================================ latency charts

def chart_backfill(run: Run, runs, target: str) -> None:
    source = db.latest_run(runs, "backfill", target, run.notes)
    if source is None:
        run.skip("backfill-latency", f"no complete results/<date>-backfill run for target {target}")
        return
    frame = db.read_csv(source.path / "raw.csv", run.notes)
    if frame is None or not {"cause", "latencyMs"}.issubset(frame.columns):
        run.skip("backfill-latency", f"{rel(source.path)}/raw.csv has no cause/latencyMs rows")
        return
    expired = frame[frame["cause"] == "EXPIRED"]
    if "reallocatedAt" in expired.columns:
        expired = expired[expired["reallocatedAt"].fillna("").astype(str).str.len() > 0]
    values = pd.to_numeric(expired["latencyMs"], errors="coerce").dropna().to_numpy(float)
    if values.size == 0:
        run.skip("backfill-latency", f"{rel(source.path)}/raw.csv has no relayed EXPIRED samples")
        return
    seconds = values.max() >= 10_000
    scale, unit = (1000.0, "s") if seconds else (1.0, "ms")
    shown = values / scale
    p95 = db.nearest_rank(values, 95) / scale
    fig, axes = plt.subplots(1, 2, figsize=(WIDE, 4.4 * CM), constrained_layout=True)
    ax = axes[0]
    edges = np.histogram_bin_edges(shown, bins="auto")
    if edges.size > 41:
        edges = np.histogram_bin_edges(shown, bins=40)
    ax.hist(shown, bins=edges, color=BLUE, edgecolor="white", linewidth=0.6)
    ax.axvline(p95, color=INK, linewidth=0.9, linestyle=(0, (4, 2)))
    ax.text(p95, ax.get_ylim()[1] * 0.97, f" p95 {p95:,.0f} {unit}" if unit == "ms" else f" p95 {p95:.2f} {unit}", ha="left", va="top", fontsize=7.5, color=INK)
    ax.set_xlabel(f"backfill latency, reallocatedAt − releasedAt ({unit})")
    ax.set_ylabel("expiries")
    style(ax)
    panel_letter(ax, "a")
    ax = axes[1]
    xs, ys = ecdf(shown)
    positive = shown[shown > 0]
    log = positive.size == shown.size and positive.size > 0
    ax.step(np.concatenate([[xs[0]], xs]), np.concatenate([[0], ys]), where="post", color=BLUE, linewidth=1.4, label=f"expiry-driven (n = {shown.size})")
    ax.axhline(0.95, color=MUTED, linewidth=0.6, linestyle=(0, (2, 2)))
    target_s = 120.0
    if log:
        ax.set_xscale("log")
        target_x = target_s * (1000.0 / scale)
        ax.axvline(target_x, color=ORANGE, linewidth=1.0, linestyle=(0, (4, 2)), label="target p95 ≤ 120 s")
        ax.set_xlim(xs.min() * 0.8, max(target_x * 1.5, xs.max() * 1.2))
        ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
        ax.xaxis.set_minor_formatter(NullFormatter())
    ax.set_ylim(0, 1.02)
    ax.set_xlabel(f"backfill latency ({unit}{', log scale' if log else ''})")
    ax.set_ylabel("fraction of expiries ≤ x")
    style(ax, "both")
    ax.legend(loc="lower right", bbox_to_anchor=(0.86, 0.02))
    panel_letter(ax, "b")
    run.save(fig, "backfill-latency", f"expiry-driven backfill latency, {source.describe()}",
             [f"{rel(source.path)}/raw.csv: latencyMs where cause = EXPIRED and reallocatedAt set (pooled over runs)"])


SETTLE_SOURCES = (
    ("smoke", "raw.csv"),
    ("correctness", "latency.csv"),
    ("preference-order", "latency.csv"),
    ("concurrency", "raw.csv"),
)


def chart_settle(run: Run, runs, target: str) -> None:
    series = []
    sources = []
    for name, file in SETTLE_SOURCES:
        source = db.latest_run(runs, name, target, run.notes)
        if source is None:
            continue
        frame = db.read_csv(source.path / file, run.notes)
        if frame is None or not {"settleMs", "serverSettleMs"}.issubset(frame.columns):
            continue
        server = pd.to_numeric(frame["serverSettleMs"], errors="coerce").dropna().to_numpy(float)
        client = pd.to_numeric(frame["settleMs"], errors="coerce").dropna().to_numpy(float)
        if server.size == 0 and client.size == 0:
            continue
        series.append((name, server, client))
        sources.append(f"{rel(source.path)}/{file}: serverSettleMs, settleMs ({source.describe()})")
    if not series:
        run.skip("settle-latency", f"no settle-latency samples in smoke/correctness/preference-order/concurrency runs for target {target}")
        return
    fig, axes = plt.subplots(1, 2, figsize=(WIDE, 5.2 * CM), constrained_layout=True, sharey=True)
    for index, (column_index, label, letter) in enumerate(((1, "server settle, settledAt − acceptedAt (ms)", "a"), (2, "client-observed settle, POST → terminal poll (ms)", "b"))):
        ax = axes[index]
        drawn = []
        for name, server, client in series:
            values = server if column_index == 1 else client
            values = values[values > 0]
            if values.size == 0:
                continue
            color, dash = EXPERIMENT_STYLE.get(name, (PURPLE, "solid"))
            xs, ys = ecdf(values)
            ax.step(np.concatenate([[xs[0]], xs]), np.concatenate([[0], ys]), where="post", color=color, linestyle=dash, linewidth=1.3,
                    label=f"{name} (n = {values.size})")
            drawn.append(values)
        ax.axhline(0.95, color=MUTED, linewidth=0.6, linestyle=(0, (2, 2)))
        ax.set_xscale("log")
        ax.xaxis.set_major_locator(LogLocator(base=10, subs=(1, 2, 5)))
        ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
        ax.xaxis.set_minor_formatter(NullFormatter())
        ax.set_ylim(0, 1.02)
        ax.set_xlabel(label)
        if index == 0:
            ax.set_ylabel("fraction of commands ≤ x")
        style(ax, "both")
        panel_letter(ax, letter)
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="outside upper center", ncol=len(handles), handlelength=2.0)
    run.save(fig, "settle-latency", "command settle latency ECDFs per functional experiment (log x)", sources)


LOADTEST_SERIES = (
    ("readP95", "reads (GET)", BLUE, "solid", "o"),
    ("commandP95", "202 (POST)", ORANGE, "solid", "s"),
    ("settleP95", "settle, client-observed", GREEN, (0, (4, 1.5)), "^"),
    ("serverSettleP95", "settle, server-side", PURPLE, (0, (4, 1.5)), "D"),
)


def chart_loadtest(run: Run, results: Path, target: str = "dev") -> None:
    date_dir = db.latest_dir(results / "loadtest", "*", must_contain="raw.csv")
    if date_dir is None:
        run.skip("loadtest-p95", "no results/loadtest/<date>/raw.csv")
        return
    frame = db.read_csv(date_dir / "raw.csv", run.notes)
    if frame is None or not {"target", "scenario", "vus"}.issubset(frame.columns):
        run.skip("loadtest-p95", f"{rel(date_dir)}/raw.csv has no run-matrix rows")
        return
    frame = db.loadtest_active(frame)
    if not db.loadtest_complete(frame, target):
        # Drawn only once every level has all its rounds (the caption promises the median of them).
        done = sum(1 for s, v in db.LOADTEST_LEVELS if db.loadtest_rounds(frame, target, s, v) >= db.LOADTEST_ROUNDS)
        run.skip("loadtest-p95", f"{rel(date_dir)}/raw.csv: {target} matrix incomplete ({done} of {len(db.LOADTEST_LEVELS)} levels have {db.LOADTEST_ROUNDS} rounds)")
        return
    # The report figure shows the report target only (Fig. 4 is one row of two panels); other
    # targets (the on-prem reference) are quoted in the text from report_numbers.py.
    complete = [(t, s, v) for t in [target] for s, v in db.LOADTEST_LEVELS
                if db.loadtest_rounds(frame, t, s, v) >= db.LOADTEST_ROUNDS]
    frame = frame[[(str(r.target), str(r.scenario), int(r.vus)) in complete for r in frame.itertuples()]]
    present = [s for s in LOADTEST_SERIES if s[0] in frame.columns]
    frame = frame.copy()
    for column, *_ in present:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    # Same rule as report_numbers.py: a round in which no command settled (p95 0 or empty, settle timeouts > 0)
    # is above the client budget, so it enters the median as +inf, not as 0.
    if "settleTimeouts" in frame.columns:
        timeouts = pd.to_numeric(frame["settleTimeouts"], errors="coerce").fillna(0)
        for column in ("settleP95", "serverSettleP95"):
            if column in frame.columns:
                frame.loc[(frame[column].isna() | (frame[column] <= 0)) & (timeouts > 0), column] = np.inf
    levels = frame.groupby(["target", "scenario", "vus"])[[c for c, *_ in present]].median().reset_index()
    levels = levels.replace([np.inf, -np.inf], np.nan)
    targets = sorted(levels["target"].astype(str).unique(), key=lambda t: (t != "dev", t))
    scenarios = sorted(levels["scenario"].astype(str).unique(), key=lambda s: (s != "cross-workshop", s))
    fig, axes = plt.subplots(len(targets), len(scenarios), figsize=(WIDE, 5.0 * CM * len(targets)), constrained_layout=True, squeeze=False, sharey=True)
    letters = iter("abcdefgh")
    for r, target in enumerate(targets):
        for c, scenario in enumerate(scenarios):
            ax = axes[r][c]
            part = levels[(levels["target"].astype(str) == target) & (levels["scenario"].astype(str) == scenario)].sort_values("vus")
            for column, label, color, dash, marker in present:
                if part.empty or part[column].isna().all():
                    continue
                ax.plot(part["vus"], part[column], color=color, linestyle=dash, marker=marker, markersize=3.5, linewidth=1.3, label=label)
            for value, text in ((1000, "1 s"), (5000, "5 s")):
                ax.axhline(value, color=MUTED, linewidth=0.7, linestyle=(0, (2, 2)))
                ax.text(1.0, value, f" {text}", transform=ax.get_yaxis_transform(), ha="left", va="center", fontsize=7.5, color=MUTED)
            ax.set_yscale("log")
            ax.yaxis.set_major_locator(LogLocator(base=10, subs=(1, 2, 5)))
            ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
            ax.yaxis.set_minor_formatter(NullFormatter())
            if not part.empty:
                ax.set_xticks(sorted(part["vus"].unique()))
            ax.set_xlabel(f"virtual users ({target}, {SCENARIO_LABEL.get(scenario, scenario)})")
            if c == 0:
                ax.set_ylabel("p95 latency (ms)")
            style(ax, "both")
            panel_letter(ax, next(letters))
    handles, labels = axes[0][0].get_legend_handles_labels()
    if handles:
        fig.legend(handles, labels, loc="outside upper center", ncol=len(handles))
    run.save(fig, "loadtest-p95", "k6 matrix, median over rounds of each run's p95, dashed lines = 1 s and 5 s targets",
             [f"{rel(date_dir)}/raw.csv: " + ", ".join(c for c, *_ in present) + " (active rounds, median per VU level)"])

    # Slide version (report/Slides.tex, slide 10): the report target only, client-observed settle p95
    # of both scenarios plus the read p95 (the 202 p95 lies on top of it), at slide size with 16 pt text.
    slide = levels[levels["target"].astype(str) == target]
    with plt.rc_context(SLIDE_RC):
        fig, ax = plt.subplots(figsize=SLIDE_SIZE, constrained_layout=True)
        lines = (("settleP95", "cross-workshop", "settle (client), 10 workshops", GREEN, "solid", "^"),
                 ("settleP95", "hotspot", "settle (client), one hot workshop", PURPLE, (0, (4, 1.5)), "D"),
                 ("readP95", "cross-workshop", "reads", BLUE, "solid", "o"))
        for column, scenario, label, color, dash, marker in lines:
            part = slide[slide["scenario"].astype(str) == scenario].sort_values("vus")
            if column in part.columns and not part[column].isna().all():
                ax.plot(part["vus"], part[column], color=color, linestyle=dash, marker=marker, markersize=8, linewidth=2.4, label=label)
        for value, text in ((1000, "1 s"), (5000, "5 s target")):
            ax.axhline(value, color=MUTED, linewidth=1.2, linestyle=(0, (2, 2)))
            ax.text(0.99, value * 1.12, text, transform=ax.get_yaxis_transform(), ha="right", va="bottom", color=MUTED)
        ax.set_yscale("log")
        ax.set_ylim(150, 60000)
        ax.yaxis.set_major_locator(FixedLocator([300, 1000, 5000, 30000]))
        ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v / 1000:g} s" if v >= 1000 else f"{v:g} ms"))
        ax.yaxis.set_minor_formatter(NullFormatter())
        ax.set_xticks(sorted(slide["vus"].unique()))
        ax.set_xlabel(f"virtual users ({target})")
        ax.set_ylabel("p95, median of rounds")
        ax.legend(loc="upper left", fontsize=13)
        style(ax, "y")
        run.save(fig, "slide-loadtest", "slide 10: k6 client-observed settle p95 (both scenarios) and read p95 by virtual users, median of rounds",
                 [f"{rel(date_dir)}/raw.csv: settleP95, readP95 (target {target}; same +inf rule)"])


# ============================================================================ user study

TASKS = ["T1", "T2", "T3", "T4", "T5", "O1", "O2", "O3", "O4"]


def study_frames(results: Path, notes: list[str]):
    folder = results / "user-study"
    session = db.read_csv(folder / "session-sheet.csv", notes)
    sus = db.read_csv(folder / "sus-sheet.csv", notes)

    def clean(frame):
        if frame is None or "participant_id" not in frame.columns:
            return None
        frame = frame.copy()
        frame["participant_id"] = frame["participant_id"].astype(str).str.strip().str.upper()
        mask = frame["participant_id"].str.contains("EXAMPLE")
        if "notes" in frame.columns:
            mask |= frame["notes"].fillna("").astype(str).str.upper().str.contains("EXAMPLE")
        frame = frame[~mask]
        if "condition" in frame.columns:
            frame["condition"] = frame["condition"].astype(str).str.strip().str.upper()
            frame = frame[frame["condition"].isin(["SR", "CTRL"])]
        return frame if not frame.empty else None

    session, sus = clean(session), clean(sus)
    if sus is not None:
        q = [f"q{i}" for i in range(1, 11)]
        if set(q).issubset(sus.columns):
            values = sus[q].apply(pd.to_numeric, errors="coerce")
            valid = values.notna().all(axis=1) & values.isin([1, 2, 3, 4, 5]).all(axis=1)
            sus = sus[valid].copy()
            values = values[valid]
            sus["sus"] = ((values[[f"q{i}" for i in (1, 3, 5, 7, 9)]] - 1).sum(axis=1) + (5 - values[[f"q{i}" for i in (2, 4, 6, 8, 10)]]).sum(axis=1)) * 2.5
            sus = sus if not sus.empty else None
        else:
            sus = None
    return session, sus, folder


def chart_study(run: Run, results: Path) -> None:
    session, sus, folder = study_frames(results, run.notes)
    if session is None:
        for name in ("study-completion", "study-time"):
            run.skip(name, f"no participant rows in {rel(folder)}/session-sheet.csv")
    else:
        session = session.copy()
        session["task_id"] = session["task_id"].astype(str).str.strip().str.upper()
        session["success"] = session["success"].astype(str).str.strip().str.lower()
        session["time_s"] = pd.to_numeric(session["time_s"], errors="coerce")
        tasks = [t for t in TASKS if t in set(session["task_id"])]
        fig, ax = plt.subplots(figsize=(WIDE, 5.2 * CM), constrained_layout=True)
        width = 0.38
        for k, (cond, label) in enumerate((("SR", "SeatRelay"), ("CTRL", "Forms + Sheet"))):
            rates, ns = [], []
            for task in tasks:
                sub = session[(session["task_id"] == task) & (session["condition"] == cond) & (session["success"].isin(["1", "0", "assisted"]))]
                ns.append(len(sub))
                rates.append(100.0 * (sub["success"] == "1").mean() if len(sub) else np.nan)
            xs = np.arange(len(tasks)) + (k - 0.5) * width
            ax.bar(xs, rates, width=width * 0.92, color=COND_COLOR[cond], label=label, hatch=None if cond == "SR" else "////", edgecolor="white", linewidth=0.5)
        ax.axhline(90, color=MUTED, linewidth=0.7, linestyle=(0, (2, 2)))
        ax.set_xticks(range(len(tasks)), tasks)
        ax.set_ylim(0, 105)
        ax.set_ylabel("completed without hint (%)")
        style(ax)
        fig.legend(loc="outside upper center", ncol=2)
        run.save(fig, "study-completion", "task completion (success = 1) per task and condition; dashed = 90 % target",
                 [f"{rel(folder)}/session-sheet.csv: success by task_id and condition"])
        totals = session.dropna(subset=["time_s"]).pivot_table(index=["participant_id", "task_id"], columns="condition", values="time_s", aggfunc="first").dropna()
        if totals.empty or not {"SR", "CTRL"}.issubset(totals.columns):
            run.skip("study-time", "no task timed in both conditions")
        else:
            per = totals.groupby(level="participant_id")[["SR", "CTRL"]].sum()
            fig, ax = plt.subplots(figsize=(NARROW, 5.0 * CM), constrained_layout=True)
            for _, row in per.iterrows():
                ax.plot([0, 1], [row["CTRL"], row["SR"]], color="#A9A8A2", linewidth=0.7, marker="o", markersize=3, markerfacecolor="white")
            ax.plot([0, 1], [per["CTRL"].median(), per["SR"].median()], color=INK, linewidth=1.6, marker="D", markersize=4, label="median")
            ax.set_xticks([0, 1], ["Forms + Sheet", "SeatRelay"])
            ax.set_xlim(-0.3, 1.3)
            ax.set_ylabel("total task time per participant (s)")
            style(ax)
            ax.legend(loc="upper right")
            run.save(fig, "study-time", "paired total task time per participant (tasks done in both conditions)",
                     [f"{rel(folder)}/session-sheet.csv: time_s summed per participant over tasks timed in both conditions"])
    if sus is None:
        run.skip("study-sus", f"no valid SUS rows in {rel(folder)}/sus-sheet.csv")
        return
    wide = sus.pivot_table(index="participant_id", columns="condition", values="sus", aggfunc="first")
    fig, ax = plt.subplots(figsize=(NARROW, 5.0 * CM), constrained_layout=True)
    if {"SR", "CTRL"}.issubset(wide.columns):
        for _, row in wide[["CTRL", "SR"]].dropna().iterrows():
            ax.plot([0, 1], [row["CTRL"], row["SR"]], color="#A9A8A2", linewidth=0.7)
    for x, cond in ((0, "CTRL"), (1, "SR")):
        values = sus.loc[sus["condition"] == cond, "sus"].to_numpy(float)
        if values.size:
            ax.scatter(np.full(values.size, x), values, s=12, color=COND_COLOR[cond], zorder=3, edgecolor="white", linewidth=0.4)
            ax.plot([x - 0.18, x + 0.18], [values.mean()] * 2, color=INK, linewidth=1.6)
    ax.axhline(75, color=MUTED, linewidth=0.7, linestyle=(0, (2, 2)))
    ax.set_xticks([0, 1], ["Forms + Sheet", "SeatRelay"])
    ax.set_xlim(-0.4, 1.4)
    ax.set_ylim(0, 100)
    ax.set_ylabel("SUS score (0–100)")
    style(ax)
    run.save(fig, "study-sus", "SUS per participant and condition (lines join a participant; bar = mean; dashed = 75 target)",
             [f"{rel(folder)}/sus-sheet.csv: q1..q10 rescored (Brooke 1996)"])


# ============================================================================ main

def write_manifest(run: Run) -> None:
    lines = ["# Generated result charts", "",
             "Written by `report/tools/make_figures.py` from `results/`; do not edit. Re-run with",
             "`python3 -I report/tools/make_figures.py` after new results arrive.", "",
             "| Chart | What | Source |", "|---|---|---|"]
    for name, what, sources in run.made:
        lines.append(f"| `{name}.pdf` | {what} | " + "<br>".join(f"`{s}`" for s in sources) + " |")
    if run.skipped:
        lines += ["", "## Not drawn (input missing)", ""]
        lines += [f"- `{name}.pdf`: {why}" for name, why in run.skipped]
    (run.out / "manifest.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--results", default=str(db.RESULTS), help="results directory (default: <repo>/results)")
    parser.add_argument("--out", default=str(db.REPO_ROOT / "report" / "figures" / "generated"), help="output directory")
    parser.add_argument("--target", default="dev", help="target of the experiment runs to draw (default: dev)")
    args = parser.parse_args(argv)
    results, out = Path(args.results), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    runs = db.scan_runs(results)
    run = Run(out)
    jobs = (
        ("replay", lambda: chart_replay(run, runs, results)),
        ("cost", lambda: chart_cost(run, results)),
        ("backfill", lambda: chart_backfill(run, runs, args.target)),
        ("settle", lambda: chart_settle(run, runs, args.target)),
        ("loadtest", lambda: chart_loadtest(run, results, args.target)),
        ("study", lambda: chart_study(run, results)),
    )
    errors = 0
    for name, job in jobs:
        try:
            job()
        except Exception as error:  # one broken input must not stop the other charts
            errors += 1
            plt.close("all")
            run.notes.append(f"ERROR in {name} charts: {error!r}")
            traceback.print_exc()
    write_manifest(run)
    for name, what, sources in run.made:
        print(f"wrote {rel(out / (name + '.pdf'))}: {what}")
        for source in sources:
            print(f"      from {source}")
    for name, why in run.skipped:
        print(f"skipped {name}.pdf: {why}")
    for note in sorted(set(run.notes)):
        print(f"note: {note}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
