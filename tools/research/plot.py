"""Publication charts of the simulated prototype dataset (not human observations)."""
from __future__ import annotations

import csv
import json
import os
import tempfile
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "seatrelay-research-mpl"))
os.environ.setdefault(
    "XDG_CACHE_HOME", str(Path(tempfile.gettempdir()) / "seatrelay-research-cache")
)
Path(os.environ["MPLCONFIGDIR"]).mkdir(parents=True, exist_ok=True)
Path(os.environ["XDG_CACHE_HOME"]).mkdir(parents=True, exist_ok=True)

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

BLUE, ORANGE, INK, GRID = "#216a9f", "#ce7438", "#183247", "#dce4eb"


def read(path):
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def finish(fig, directory, name, seed):
    fig.text(
        0.015,
        0.012,
        f"SIMULATED research | 12 generated profiles | seed {seed}",
        color="#576979",
        fontsize=7,
    )
    fig.tight_layout(rect=(0, 0.045, 1, 1))
    fig.savefig(directory / f"{name}.png", dpi=180, facecolor="white")
    fig.savefig(
        directory / f"{name}.pdf",
        facecolor="white",
        metadata={
            "Title": f"SIMULATED research: {name}",
            "CreationDate": None,
            "ModDate": None,
        },
    )
    plt.close(fig)


def render(out: Path):
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 9,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.labelcolor": INK,
            "text.color": INK,
            "axes.edgecolor": GRID,
            "axes.axisbelow": True,
            "pdf.fonttype": 42,
        }
    )
    directory = out / "figures"
    directory.mkdir(exist_ok=True)
    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    seed = json.loads((out / "manifest.json").read_text(encoding="utf-8"))["seed"]
    design = read(out / "study-design.csv")
    rows = read(out / "paired-subjects.csv")
    fig, axes = plt.subplots(1, 2, figsize=(10.2, 3.7), sharey=False)
    for ax, track, title in zip(
        axes,
        ["participant", "organiser"],
        ["Participant track (5 tasks)", "Organiser track (4 tasks)"],
    ):
        selected = [r for r in rows if r["track"] == track]
        labels = []
        for r in selected:
            values = [float(r["ctrl_total_s"]), float(r["sr_total_s"])]
            ax.plot([0, 1], values, color=GRID, zorder=1)
            ax.scatter([0, 1], values, c=[ORANGE, BLUE], s=24, zorder=2)
            labels.append((values[1], r["participant_id"].replace("SIM-", "")))
        # Space close profile labels vertically and connect them back to their actual points.
        label_y = -float("inf")
        gap = max(float(r["sr_total_s"]) for r in selected) * 0.055
        for value, label in sorted(labels):
            label_y = max(value, label_y + gap)
            ax.annotate(
                label,
                xy=(1, value),
                xytext=(1.13, label_y),
                fontsize=7,
                va="center",
                arrowprops={"arrowstyle": "-", "color": "#a5b4c1", "lw": 0.6},
            )
        ax.set_xticks([0, 1], ["Forms + sheet", "SeatRelay"])
        ax.set_xlim(-0.25, 1.4)
        ax.set_ylim(bottom=0)
        ax.set_ylabel("Total task time per participant (s)")
        ax.set_title(title, loc="left", fontweight="bold")
        ax.grid(axis="y", color=GRID, linewidth=0.6)
    fig.suptitle("Paired task time", x=0.015, ha="left", fontweight="bold")
    finish(fig, directory, "paired-time", seed)

    sr, ctrl = [summary["conditions"][c] for c in ("SR", "CTRL")]
    fig, ax = plt.subplots(figsize=(7.8, 3.2))
    starts = np.zeros(2)
    for key, title, color in [
        ("unassisted", "Without help", BLUE),
        ("assisted", "With help", "#a7bbcb"),
        ("failed", "Failed", ORANGE),
    ]:
        counts = np.array([sr[key], ctrl[key]])
        ax.barh([1, 0], counts, left=starts, color=color, height=0.44, label=title)
        for y, start, n in zip([1, 0], starts, counts):
            if n:
                ax.text(
                    start + n / 2,
                    y,
                    str(n),
                    ha="center",
                    va="center",
                    color="white" if key != "assisted" else INK,
                    fontweight="bold",
                )
        starts += counts
    ax.set_yticks([1, 0], ["SeatRelay", "Forms + sheet"])
    ax.set_xlabel("Task attempts (56 per condition; 12 generated profiles)")
    ax.set_xlim(0, 56)
    ax.set_title("Task completion", loc="left", fontweight="bold", pad=38)
    ax.legend(ncol=3, loc="lower left", bbox_to_anchor=(0, 1.04), frameon=False)
    finish(fig, directory, "completion", seed)

    sus = read(out / "sus-sheet.csv")
    fig, ax = plt.subplots(figsize=(7.8, 3.6))
    for i, person in enumerate(design):
        a, b = [
            next(
                float(r["sus_score"])
                for r in sus
                if r["participant_id"] == person["participant_id"] and r["condition"] == c
            )
            for c in ("CTRL", "SR")
        ]
        ax.plot([a, b], [i, i], color=GRID, linewidth=1.5)
        ax.scatter([a, b], [i, i], c=[ORANGE, BLUE], s=23)
    ax.set_yticks(range(len(design)), [p["participant_id"].replace("SIM-", "") for p in design])
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xlabel("SUS score (0–100; not a satisfaction percentage)")
    ax.axvline(75, color="#718493", linestyle="--", linewidth=0.8, label="Reference 75")
    ax.set_title("Ten-item SUS responses — generated profiles", loc="left", fontweight="bold")
    ax.scatter([], [], color=BLUE, label="SeatRelay")
    ax.scatter([], [], color=ORANGE, label="Forms + sheet")
    ax.legend(loc="lower left", frameon=False, ncol=3)
    finish(fig, directory, "sus", seed)

    fig, ax = plt.subplots(figsize=(7.8, 3.0))
    vals = [ctrl["median_organiser_steps"], sr["median_organiser_steps"]]
    bars = ax.barh([1, 0], vals, color=[ORANGE, BLUE], height=0.4)
    ax.set_yticks([1, 0], ["Forms + sheet", "SeatRelay"])
    ax.set_xlabel("Median actions per organiser across four tasks (4 generated profiles)")
    ax.set_xlim(0, max(vals) * 1.2)
    ax.bar_label(bars, labels=[f"{v:g}" for v in vals], padding=5)
    ax.set_title("Organiser work — declared action-count model", loc="left", fontweight="bold")
    finish(fig, directory, "organiser-steps", seed)
