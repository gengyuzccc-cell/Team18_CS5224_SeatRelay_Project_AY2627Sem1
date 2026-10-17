#!/usr/bin/env python3
"""Histograms and CDFs of the latency experiments' raw samples (plan §3 step 16, §7).

Generic over every experiment directory written by tools/experiments
(``results/<YYYY-MM-DD>-<name>/raw.csv`` + ``meta.json``): it finds the latency-like columns
(names ending in ``Ms`` or ``Seconds``) of ``raw.csv`` (and ``latency.csv`` when present),
optionally splits them by a grouping column, and writes per column

    <run>/plots/<file>-<column>-hist.png    histogram (shared bins across groups)
    <run>/plots/<file>-<column>-cdf.png     empirical CDF with the p95 reference line
    <run>/plots/<file>-<column>-stats.csv   n / p50 / p95 / p99 / max / mean per group

and prints the stats as Markdown. Percentiles are nearest-rank, the same definition as
``tools/experiments/src/lib/results.ts``, so the numbers match summary.md.

Examples
    python3 tools/experiments/analysis/plot_results.py                      # every results/*/
    python3 tools/experiments/analysis/plot_results.py results/2026-10-30-backfill \
        --value latencyMs --group cause
    python3 tools/experiments/analysis/plot_results.py results/*-concurrency --value settleMs \
        --group phase --log-x
    python3 tools/experiments/analysis/plot_results.py results/2026-10-30-backfill \
        results/2026-10-31-backfill --value latencyMs --combine --out results/plots
    python3 tools/experiments/analysis/plot_results.py --loadtest           # every results/loadtest/*/
    python3 tools/experiments/analysis/plot_results.py --loadtest results/loadtest/2026-11-01

``--loadtest`` reads the k6 matrix (``results/loadtest/<date>/raw.csv`` of tools/loadtest
run-matrix) instead: per target and scenario, the median over the rounds of each run's p95
(reads, 202, client-observed settle, server-side settle) against the VU level, with the plan §4
targets as reference lines (1 s reads / 202, 5 s settle), written to
``<date>/plots/loadtest-<target>-<scenario>-p95.png`` plus a Markdown table. Superseded
attempts (``supersededBy`` set) are left out, as in summary.md.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RESULTS = REPO_ROOT / "results"
LATENCY_FILES = ("raw.csv", "latency.csv")
LATENCY_COLUMN = re.compile(r"(Ms|_ms|Seconds|_s)$")
GROUP_CANDIDATES = ("cause", "phase", "variant", "fault", "type", "step", "case")
MAX_GROUPS = 8

# Categorical slots in fixed order (validated light-mode palette: adjacent CVD ΔE ≥ 9.1).
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
# Secondary encoding so identity never rests on color alone (print, CVD, low-contrast slots).
LINESTYLES = ["solid", "solid", "solid", (0, (6, 2)), (0, (6, 2)), (0, (2, 2)), (0, (2, 2)), (0, (8, 2, 2, 2))]
SURFACE = "#fcfcfb"
TEXT_PRIMARY = "#0b0b0b"
TEXT_SECONDARY = "#52514e"
GRID = "#e4e3df"
OTHER = "#8a8984"


def nearest_rank(values: np.ndarray, p: float) -> float:
    """Smallest value such that at least p % of the samples are <= it (NaN when empty)."""
    if values.size == 0:
        return math.nan
    ordered = np.sort(values)
    rank = math.ceil(min(100.0, max(0.0, p)) / 100.0 * ordered.size)
    return float(ordered[min(ordered.size - 1, max(0, rank - 1))])


@dataclass
class GroupStats:
    group: str
    n: int
    p50: float
    p95: float
    p99: float
    max: float
    mean: float


def stats_of(group: str, values: np.ndarray) -> GroupStats:
    return GroupStats(
        group=group,
        n=int(values.size),
        p50=nearest_rank(values, 50),
        p95=nearest_rank(values, 95),
        p99=nearest_rank(values, 99),
        max=float(values.max()) if values.size else math.nan,
        mean=float(values.mean()) if values.size else math.nan,
    )


def latency_columns(frame: pd.DataFrame) -> list[str]:
    """Columns named like a latency with at least two numeric values that are not all equal
    (a constant column such as expiry-race's ``marginMs`` is a parameter, not a measurement)."""
    columns = []
    for column in frame.columns:
        if not LATENCY_COLUMN.search(str(column)):
            continue
        numeric = pd.to_numeric(frame[column], errors="coerce").dropna()
        if numeric.size >= 2 and numeric.nunique() > 1:
            columns.append(str(column))
    return columns


def pick_group(frame: pd.DataFrame, requested: str | None) -> str | None:
    if requested is not None:
        if requested not in frame.columns:
            raise SystemExit(f"--group {requested}: no such column (have {', '.join(map(str, frame.columns))})")
        return requested
    for candidate in GROUP_CANDIDATES:
        if candidate in frame.columns:
            distinct = frame[candidate].dropna().astype(str).nunique()
            if 2 <= distinct <= 2 * MAX_GROUPS:
                return candidate
    return None


def grouped_values(frame: pd.DataFrame, column: str, group: str | None) -> list[tuple[str, np.ndarray]]:
    """(label, values) per group, largest groups first; beyond MAX_GROUPS folded into 'Other'."""
    values = pd.to_numeric(frame[column], errors="coerce")
    if group is None:
        clean = values.dropna().to_numpy(dtype=float)
        return [(column, clean)] if clean.size else []
    labels = frame[group].fillna("(none)").astype(str)
    parts = []
    for label, series in values.groupby(labels, sort=False):
        clean = series.dropna().to_numpy(dtype=float)
        if clean.size:
            parts.append((str(label), clean))
    parts.sort(key=lambda part: (-part[1].size, part[0]))
    if len(parts) > MAX_GROUPS:
        head = parts[: MAX_GROUPS - 1]
        rest = np.concatenate([part[1] for part in parts[MAX_GROUPS - 1 :]])
        parts = [*head, ("Other", rest)]
    return parts


def unit_for(column: str, all_values: np.ndarray, requested: str) -> tuple[float, str]:
    """(divisor, unit label) so that values / divisor are in the chosen unit."""
    if column.endswith("Seconds") or column.endswith("_s"):
        return 1.0, "s"
    if requested == "s" or (requested == "auto" and all_values.size and np.nanmax(np.abs(all_values)) >= 10_000):
        return 1000.0, "s"
    return 1.0, "ms"


def style_axes(ax: plt.Axes) -> None:
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=TEXT_SECONDARY, labelsize=9)
    ax.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def new_figure() -> tuple[plt.Figure, plt.Axes]:
    figure, ax = plt.subplots(figsize=(7.2, 4.0), dpi=150)
    figure.patch.set_facecolor(SURFACE)
    style_axes(ax)
    return figure, ax


def color_of(index: int, label: str) -> str:
    return OTHER if label == "Other" else SERIES[index % len(SERIES)]


def finish(figure: plt.Figure, ax: plt.Axes, title: str, subtitle: str, xlabel: str, ylabel: str, legend: bool, path: Path) -> None:
    ax.set_xlabel(xlabel, color=TEXT_SECONDARY, fontsize=9)
    ax.set_ylabel(ylabel, color=TEXT_SECONDARY, fontsize=9)
    figure.suptitle(title, x=0.01, ha="left", color=TEXT_PRIMARY, fontsize=11, fontweight="bold")
    ax.set_title(subtitle, loc="left", color=TEXT_SECONDARY, fontsize=8.5)
    if legend:
        handle = ax.legend(frameon=False, fontsize=8, labelcolor=TEXT_PRIMARY, loc="best")
        for text in handle.get_texts():
            text.set_color(TEXT_PRIMARY)
    figure.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(path, facecolor=SURFACE)
    plt.close(figure)


def fmt(value: float, unit: str) -> str:
    if math.isnan(value):
        return "n/a"
    return f"{value:.2f} {unit}" if unit == "s" else f"{value:.0f} {unit}"


def legend_label(label: str, values: np.ndarray, unit: str) -> str:
    return f"{label} (n={values.size}, p95 {fmt(nearest_rank(values, 95), unit)})"


def plot_hist(parts, divisor, unit, title, subtitle, column, path: Path, log_x: bool) -> None:
    figure, ax = new_figure()
    scaled = [(label, values / divisor) for label, values in parts]
    everything = np.concatenate([values for _, values in scaled])
    if log_x and np.all(everything > 0):
        edges = np.logspace(math.log10(everything.min()), math.log10(everything.max() if everything.max() > everything.min() else everything.min() * 10), 40)
        ax.set_xscale("log")
    else:
        edges = np.histogram_bin_edges(everything, bins="auto")
        if edges.size > 61:
            edges = np.histogram_bin_edges(everything, bins=60)
    if len(scaled) == 1:
        label, values = scaled[0]
        # Filled bars with a surface gap between neighbours.
        ax.hist(values, bins=edges, color=color_of(0, label), edgecolor=SURFACE, linewidth=1.0)
    else:
        for index, (label, values) in enumerate(scaled):
            ax.hist(
                values, bins=edges, histtype="step", linewidth=1.6, color=color_of(index, label),
                linestyle=LINESTYLES[index % len(LINESTYLES)], label=legend_label(label, values, unit),
            )
    finish(figure, ax, title, subtitle, f"{column} ({unit})", "samples", len(scaled) > 1, path)


def plot_cdf(parts, divisor, unit, title, subtitle, column, path: Path, log_x: bool) -> None:
    figure, ax = new_figure()
    for index, (label, values) in enumerate(parts):
        ordered = np.sort(values / divisor)
        # Start every curve at 0 so a constant sample is a full-height step, not a stub.
        ordered = np.concatenate([[ordered[0]], ordered])
        fraction = np.arange(0, ordered.size) / (ordered.size - 1)
        ax.step(
            ordered, fraction, where="post", linewidth=1.6, color=color_of(index, label),
            linestyle=LINESTYLES[index % len(LINESTYLES)], label=legend_label(label, values / divisor, unit),
        )
    ax.axhline(0.95, color=TEXT_SECONDARY, linewidth=0.8, linestyle=(0, (4, 3)))
    ax.text(ax.get_xlim()[0], 0.955, " p95", color=TEXT_SECONDARY, fontsize=8, va="bottom")
    ax.set_ylim(0, 1.02)
    if log_x and all(np.all(values > 0) for _, values in parts):
        ax.set_xscale("log")
    finish(figure, ax, title, subtitle, f"{column} ({unit})", "fraction of samples ≤ x", len(parts) > 1, path)


def write_stats(rows: list[GroupStats], divisor: float, unit: str, path: Path) -> str:
    frame = pd.DataFrame(
        [
            {
                "group": row.group, "n": row.n, f"p50_{unit}": row.p50 / divisor, f"p95_{unit}": row.p95 / divisor,
                f"p99_{unit}": row.p99 / divisor, f"max_{unit}": row.max / divisor, f"mean_{unit}": row.mean / divisor,
            }
            for row in rows
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(path, index=False)
    header = f"| group | n | p50 {unit} | p95 {unit} | p99 {unit} | max {unit} | mean {unit} |"
    lines = [header, "|---|---|---|---|---|---|---|"]
    digits = 2 if unit == "s" else 0
    for row in rows:
        cells = [row.p50, row.p95, row.p99, row.max, row.mean]
        lines.append(f"| {row.group} | {row.n} | " + " | ".join(f"{value / divisor:.{digits}f}" for value in cells) + " |")
    return "\n".join(lines)


def run_label(run_dir: Path) -> str:
    meta_path = run_dir / "meta.json"
    target = ""
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
            target = meta.get("target", {}).get("name", "") if isinstance(meta.get("target"), dict) else ""
        except (OSError, ValueError):
            target = ""
    return f"{run_dir.name}{f' ({target})' if target else ''}"


def csv_files(run_dir: Path, requested: str | None) -> list[Path]:
    names = [requested] if requested else list(LATENCY_FILES)
    return [run_dir / name for name in names if (run_dir / name).exists()]


def read_frame(csv_path: Path) -> pd.DataFrame | None:
    """The CSV as a frame, or None (with a note on stderr) when it has no header at all: the
    harness writes a 1-byte raw.csv for a run without sample rows (e.g. failure-recovery with
    fault flags off, or an aborted trial). One such run must not stop a batch."""
    try:
        if not csv_path.read_text().strip():
            print(f"{csv_path}: empty (the run produced no sample rows), skipped", file=sys.stderr)
            return None
        return pd.read_csv(csv_path)
    except pd.errors.EmptyDataError:
        print(f"{csv_path}: empty (the run produced no sample rows), skipped", file=sys.stderr)
        return None
    except (OSError, UnicodeDecodeError, pd.errors.ParserError) as error:
        print(f"{csv_path}: not readable ({error}), skipped", file=sys.stderr)
        return None


def plot_run(run_dir: Path, args: argparse.Namespace) -> int:
    produced = 0
    out_dir = Path(args.out) / run_dir.name if args.out else run_dir / "plots"
    for csv_path in csv_files(run_dir, args.file):
        frame = read_frame(csv_path)
        if frame is None:
            continue
        columns = args.value or latency_columns(frame)
        columns = [column for column in columns if column in frame.columns]
        if not columns:
            continue
        group = pick_group(frame, args.group)
        for column in columns:
            parts = grouped_values(frame, column, group)
            if not parts:
                continue
            everything = np.concatenate([values for _, values in parts])
            divisor, unit = unit_for(column, everything, args.unit)
            stem = f"{csv_path.stem}-{column}"
            title = f"{run_label(run_dir)}: {column}"
            subtitle = f"{everything.size} samples from {csv_path.name}" + (f", by {group}" if group else "")
            plot_hist(parts, divisor, unit, title, subtitle, column, out_dir / f"{stem}-hist.png", args.log_x)
            plot_cdf(parts, divisor, unit, title, subtitle, column, out_dir / f"{stem}-cdf.png", args.log_x)
            table = write_stats([stats_of(label, values) for label, values in parts], divisor, unit, out_dir / f"{stem}-stats.csv")
            print(f"\n### {title}\n\n{subtitle}; plots in {out_dir}\n\n{table}")
            produced += 1
    return produced


def plot_combined(run_dirs: list[Path], args: argparse.Namespace) -> int:
    if not args.value or len(args.value) != 1:
        raise SystemExit("--combine needs exactly one --value column")
    column = args.value[0]
    parts = []
    for run_dir in run_dirs:
        for csv_path in csv_files(run_dir, args.file):
            frame = read_frame(csv_path)
            if frame is None:
                continue
            if column in frame.columns:
                values = pd.to_numeric(frame[column], errors="coerce").dropna().to_numpy(dtype=float)
                if values.size:
                    parts.append((run_label(run_dir), values))
                break
    if not parts:
        print(f"no run has a numeric column {column}", file=sys.stderr)
        return 0
    if len(parts) > MAX_GROUPS:
        print(f"{len(parts)} runs: only the first {MAX_GROUPS} are overlaid (fixed palette order)", file=sys.stderr)
        parts = parts[:MAX_GROUPS]
    out_dir = Path(args.out) if args.out else DEFAULT_RESULTS / "plots"
    everything = np.concatenate([values for _, values in parts])
    divisor, unit = unit_for(column, everything, args.unit)
    title = f"{column}: {len(parts)} runs compared"
    subtitle = ", ".join(label for label, _ in parts)
    plot_cdf(parts, divisor, unit, title, subtitle, column, out_dir / f"compare-{column}-cdf.png", args.log_x)
    plot_hist(parts, divisor, unit, title, subtitle, column, out_dir / f"compare-{column}-hist.png", args.log_x)
    table = write_stats([stats_of(label, values) for label, values in parts], divisor, unit, out_dir / f"compare-{column}-stats.csv")
    print(f"\n### {title}\n\nplots in {out_dir}\n\n{table}")
    return 1


LOADTEST_SERIES = (
    ("readP95", "reads (GET /workshops)"),
    ("commandP95", "202 (POST …/commands)"),
    ("settleP95", "settle, client-observed"),
    ("serverSettleP95", "settle, server-side"),
)
LOADTEST_TARGETS_MS = ((1000.0, "1 s target: reads, 202"), (5000.0, "5 s target: settle"))


def loadtest_levels(frame: pd.DataFrame) -> pd.DataFrame:
    """Median over the rounds of each p95 column per (target, scenario, vus); active rows only."""
    if "supersededBy" in frame.columns:
        frame = frame[frame["supersededBy"].isna() | (frame["supersededBy"].astype(str).str.len() == 0)]
    present = [column for column, _ in LOADTEST_SERIES if column in frame.columns]
    numeric = frame[["target", "scenario", "vus", *present]].copy()
    for column in present:
        numeric[column] = pd.to_numeric(numeric[column], errors="coerce")
    grouped = numeric.groupby(["target", "scenario", "vus"], sort=True)
    levels = grouped[present].median()
    levels["rounds"] = grouped.size()
    return levels.reset_index()


def plot_loadtest_dir(date_dir: Path, args: argparse.Namespace) -> int:
    frame = read_frame(date_dir / "raw.csv")
    if frame is None or frame.empty or not {"target", "scenario", "vus"}.issubset(frame.columns):
        print(f"{date_dir}: no run-matrix rows, skipped", file=sys.stderr)
        return 0
    levels = loadtest_levels(frame)
    out_dir = Path(args.out) / date_dir.name if args.out else date_dir / "plots"
    produced = 0
    for (target, scenario), part in levels.groupby(["target", "scenario"], sort=True):
        part = part.sort_values("vus")
        figure, ax = new_figure()
        drawn = 0
        for index, (column, label) in enumerate(LOADTEST_SERIES):
            if column not in part.columns or part[column].isna().all():
                continue
            ax.plot(
                part["vus"], part[column], marker="o", markersize=4, linewidth=1.6, color=SERIES[index],
                linestyle=LINESTYLES[index], label=label,
            )
            drawn += 1
        if drawn == 0:
            plt.close(figure)
            continue
        for value, label in LOADTEST_TARGETS_MS:
            ax.axhline(value, color=TEXT_SECONDARY, linewidth=0.8, linestyle=(0, (4, 3)))
            ax.text(part["vus"].min(), value, f" {label}", color=TEXT_SECONDARY, fontsize=7.5, va="bottom")
        ax.set_xticks(sorted(part["vus"].unique()))
        if args.log_x:
            ax.set_yscale("log")
        rounds = "/".join(str(int(n)) for n in part["rounds"])
        title = f"Load test {date_dir.name}: {target} · {scenario}"
        subtitle = f"p95 per run, median of the rounds per VU level (rounds {rounds}); from {date_dir.name}/raw.csv"
        finish(figure, ax, title, subtitle, "virtual users", "p95 (ms)", True, out_dir / f"loadtest-{target}-{scenario}-p95.png")
        columns = [column for column, _ in LOADTEST_SERIES if column in part.columns]
        lines = [
            "| VUs | rounds | " + " | ".join(f"{column} (ms)" for column in columns) + " |",
            "|---|---|" + "---|" * len(columns),
        ]
        for _, row in part.iterrows():
            cells = ["n/a" if pd.isna(row[column]) else f"{row[column]:.0f}" for column in columns]
            lines.append(f"| {int(row['vus'])} | {int(row['rounds'])} | " + " | ".join(cells) + " |")
        print(f"\n### {title}\n\n{subtitle}; plot in {out_dir}\n\n" + "\n".join(lines))
        produced += 1
    return produced


def discover_loadtest(paths: list[str], results_dir: Path) -> list[Path]:
    if not paths:
        return sorted(path.parent for path in (results_dir / "loadtest").glob("*/raw.csv"))
    return discover(paths, results_dir)


def discover(paths: list[str], results_dir: Path) -> list[Path]:
    if not paths:
        return sorted(path.parent for path in results_dir.glob("*/raw.csv"))
    found = []
    for raw in paths:
        path = Path(raw)
        if path.is_file():
            path = path.parent
        if not path.is_dir():
            raise SystemExit(f"{raw}: not a results directory")
        found.append(path)
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("runs", nargs="*", help="results/<date>-<name> directories (or their raw.csv); default: every results/*/")
    parser.add_argument("--results", default=str(DEFAULT_RESULTS), help="results base directory for the default discovery")
    parser.add_argument("--file", help="CSV file inside each run directory (default: raw.csv and latency.csv)")
    parser.add_argument("--value", action="append", help="column to plot (repeatable); default: every *Ms / *Seconds column")
    parser.add_argument("--group", help=f"grouping column (default: the first of {', '.join(GROUP_CANDIDATES)} with 2..16 values)")
    parser.add_argument("--unit", choices=("auto", "ms", "s"), default="auto", help="display unit for *Ms columns (auto: s when max ≥ 10 s)")
    parser.add_argument("--log-x", action="store_true", help="logarithmic x axis (heavy tails)")
    parser.add_argument("--combine", action="store_true", help="overlay one --value column across all given runs")
    parser.add_argument("--out", help="output directory (default: <run>/plots, or results/plots for --combine)")
    parser.add_argument("--loadtest", action="store_true", help="plot the k6 matrix (results/loadtest/<date>/raw.csv): p95 vs VUs per target and scenario")
    args = parser.parse_args(argv)

    if args.loadtest:
        date_dirs = discover_loadtest(args.runs, Path(args.results))
        if not date_dirs:
            print(f"no loadtest/*/raw.csv under {args.results}", file=sys.stderr)
            return 1
        if sum(plot_loadtest_dir(date_dir, args) for date_dir in date_dirs) == 0:
            print("nothing to plot: no run-matrix p95 columns in the selected files", file=sys.stderr)
            return 1
        return 0

    run_dirs = discover(args.runs, Path(args.results))
    if not run_dirs:
        print(f"no results/*/raw.csv under {args.results}", file=sys.stderr)
        return 1
    produced = plot_combined(run_dirs, args) if args.combine else sum(plot_run(run_dir, args) for run_dir in run_dirs)
    if produced == 0:
        print("nothing to plot: no latency-like numeric columns (*Ms, *Seconds) in the selected files", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
