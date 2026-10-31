#!/usr/bin/env python3
"""Build the explicitly simulated research package, independently of field evidence.

python3 tools/research/simulate.py --plots
python3 tools/research/simulate.py --check

The CSV/JSON/Markdown/TeX pipeline uses the standard library. Plotting additionally uses the
repository's tools/experiments/requirements.txt. No recruitment, consent, recordings or human
observations are implied. All failure events and timing assumptions are declared in scenarios.json.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

# The report checker invokes this file with Python -I; load only this trusted sibling directory.
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from study import BALANCE, ORIGIN, ROOT, SOURCE, analyse, design_rows, generate_study, validate
from documents import interview_files, markdown_report, study_notes, tex_macros

DEFAULT_OUT = ROOT / "results/research"
TEX = ROOT / "report/generated/research.tex"


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def csv_text(rows):
    buf = io.StringIO(newline="")
    writer = csv.DictWriter(buf, fieldnames=list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


FIGURE_NAMES = ("paired-time", "completion", "sus", "organiser-steps")
FIGURE_INPUTS = (
    "summary.json",
    "paired-subjects.csv",
    "study-design.csv",
    "sus-sheet.csv",
    "manifest.json",
)


def figure_manifest(out):
    return {
        "source_type": ORIGIN,
        "plot_source_sha256": digest(
            Path(__file__).with_name("plot.py").read_text(encoding="utf-8")
        ),
        "inputs_sha256": {
            name: hashlib.sha256((out / name).read_bytes()).hexdigest() for name in FIGURE_INPUTS
        },
        "files_sha256": {
            f"{name}.{ext}": hashlib.sha256(
                (out / "figures" / f"{name}.{ext}").read_bytes()
            ).hexdigest()
            for name in FIGURE_NAMES
            for ext in ("png", "pdf")
        },
    }


def check_figures(out):
    path = out / "figures/manifest.json"
    try:
        actual = json.loads(path.read_text(encoding="utf-8"))
        expected = figure_manifest(out)
    except (OSError, ValueError) as error:
        raise ValueError(
            f"Missing or invalid research figures: {error}; regenerate with --plots"
        ) from error
    if actual != expected:
        raise ValueError("Research figures are stale or modified; regenerate with --plots")


def build_files(seed=None):
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    if seed is not None:
        source["seed"] = seed
    sessions, sus = generate_study(source, source["seed"])
    validate(source, sessions, sus)
    summary, paired, themes = analyse(source, sessions, sus)
    sensitivity = []
    for factor in (0.8, 1.0, 1.2):
        varied_sessions, varied_sus = generate_study(source, source["seed"], factor)
        varied, _, _ = analyse(source, varied_sessions, varied_sus)
        sensitivity.append(
            {
                "source_type": ORIGIN,
                "sr_time_factor": factor,
                "paired_reduction_pct": varied["paired_subject_median_reduction_pct"],
                "sr_faster_profiles": varied["sr_faster_profiles"],
            }
        )
    records, interviews, excerpts = interview_files(source)
    files = {
        **records,
        "interviews.csv": csv_text(interviews),
        "coded-excerpts.csv": csv_text(excerpts),
        "codebook.json": json_text(
            {"source_type": ORIGIN, "coding_unit": "scripted profile", "codes": source["codebook"]}
        ),
        "study-design.csv": csv_text(design_rows(source)),
        "session-sheet.csv": csv_text(sessions),
        "sus-sheet.csv": csv_text(sus),
        "paired-subjects.csv": csv_text(paired),
        "themes.csv": csv_text(themes),
        "sensitivity.csv": csv_text(sensitivity),
        "summary.json": json_text(summary),
        "summary.md": markdown_report(source, summary, themes, sensitivity),
        "research.tex": tex_macros(summary),
    }
    files.update(study_notes(summary, design_rows(source)))
    files["manifest.json"] = json_text(
        {
            "source_type": ORIGIN,
            "seed": source["seed"],
            "scenario_date": source["scenario_date"],
            "purpose": source["purpose"],
            "assumptions": source["assumptions"],
            "source_sha256": {
                str(p.relative_to(ROOT)): digest(p.read_text(encoding="utf-8"))
                for p in (
                    SOURCE,
                    BALANCE,
                    Path(__file__),
                    Path(__file__).with_name("study.py"),
                    Path(__file__).with_name("documents.py"),
                    Path(__file__).with_name("plot.py"),
                )
            },
            "counts": {
                "interview_profiles": len(interviews),
                "study_profiles": len(paired),
                "task_attempts": len(sessions),
                "sus_forms": len(sus),
            },
            "files_sha256": {name: digest(text) for name, text in sorted(files.items())},
            "disclosure": "Authored scenarios and generated responses, not human-subject evidence. No real Study*/Interview* report macros or real-evidence directories are populated.",
        }
    )
    return files


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--tex", type=Path)
    parser.add_argument("--seed", type=int)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify deterministic outputs and report macros without writing",
    )
    parser.add_argument(
        "--check-figures",
        action="store_true",
        help="also verify chart inputs and PNG/PDF integrity (requires --check)",
    )
    parser.add_argument(
        "--plots", action="store_true", help="render PNG/PDF charts with matplotlib"
    )
    args = parser.parse_args(argv)
    if args.check_figures and not args.check:
        parser.error("--check-figures requires --check")
    if args.seed is not None and not args.check and args.out.resolve() == DEFAULT_OUT.resolve():
        parser.error("Use --out for an alternate seed so the default report remains reproducible")
    files = build_files(args.seed)
    tex = args.tex or (
        TEX if args.out.resolve() == DEFAULT_OUT.resolve() else args.out / "research.tex"
    )
    if args.check:
        mismatches = [
            name
            for name, content in files.items()
            if not (args.out / name).exists()
            or (args.out / name).read_text(encoding="utf-8") != content
        ]
        if not tex.exists() or tex.read_text(encoding="utf-8") != files["research.tex"]:
            mismatches.append(str(tex))
        allowed = (
            set(files)
            | {f"figures/{name}.{ext}" for name in FIGURE_NAMES for ext in ("png", "pdf")}
            | {"figures/manifest.json"}
        )
        try:
            allowed.add(str(tex.resolve().relative_to(args.out.resolve())))
        except ValueError:
            pass
        unexpected = [
            str(p.relative_to(args.out))
            for p in args.out.rglob("*")
            if p.is_file()
            and not any(part.startswith(".") for part in p.relative_to(args.out).parts)
            and str(p.relative_to(args.out)) not in allowed
        ]
        mismatches.extend(f"unexpected file: {name}" for name in sorted(unexpected))
        if mismatches:
            raise SystemExit("Research differs from source: " + ", ".join(mismatches))
        if args.check_figures:
            try:
                check_figures(args.out)
            except ValueError as error:
                raise SystemExit(str(error)) from error
        print(
            f"research: {len(files)} deterministic files and report macros verified; 12 participants"
        )
        return 0
    for name, content in files.items():
        target = args.out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    tex.parent.mkdir(parents=True, exist_ok=True)
    tex.write_text(files["research.tex"], encoding="utf-8")
    if args.plots:
        from plot import render

        render(args.out)
        (args.out / "figures/manifest.json").write_text(
            json_text(figure_manifest(args.out)), encoding="utf-8"
        )
    print(f"wrote {len(files)} files to {args.out}; report macros {tex}; 12 participants")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
