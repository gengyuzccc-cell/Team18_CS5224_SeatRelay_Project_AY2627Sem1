"""Research arithmetic, paired unit, provenance and reproducibility regression checks."""
import csv
import copy
import contextlib
import io
import json
import statistics
import tempfile
import unittest
from pathlib import Path

from simulate import FIGURE_INPUTS, FIGURE_NAMES, build_files, check_figures, figure_manifest, main
from study import SOURCE, analyse, design_rows, generate_study, sus_score, validate


class ResearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = json.loads(SOURCE.read_text(encoding="utf-8"))
        cls.sessions, cls.sus = generate_study(cls.source, cls.source["seed"])
        cls.summary, cls.paired, cls.themes = analyse(cls.source, cls.sessions, cls.sus)

    def test_protocol_counts_and_balance(self):
        validate(self.source, self.sessions, self.sus)
        design = design_rows(self.source)
        self.assertEqual(len(self.sessions), 112)
        self.assertEqual(len(self.sus), 24)
        self.assertEqual(sum(r["track"] == "organiser" for r in design), 4)
        for track in ("participant", "organiser"):
            people = [p for p in design if p["track"] == track]
            self.assertEqual(sum(p["order"] == "SR_first" for p in people), len(people) // 2)
        for task in {r["task_id"] for r in self.sessions}:
            for condition in ("SR", "CTRL"):
                rows = [
                    r for r in self.sessions if r["task_id"] == task and r["condition"] == condition
                ]
                self.assertEqual(sum(r["dataset"] == "A" for r in rows), len(rows) // 2)

    def test_sus_uses_ten_items_and_reversal(self):
        self.assertEqual(sus_score([5, 1] * 5), 100)
        self.assertEqual(sus_score([1, 5] * 5), 0)
        self.assertEqual(sus_score([3] * 10), 50)
        with self.assertRaises(ValueError):
            sus_score([6] * 10)
        for invalid in (True, 3.0, "3"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                sus_score([invalid] * 10)
        for row in self.sus:
            self.assertEqual(row["sus_score"], sus_score([row[f"q{i}"] for i in range(1, 11)]))

    def test_time_comparison_has_twelve_independent_profiles(self):
        self.assertEqual(len(self.paired), 12)
        for row in self.paired:
            ctrl = sum(
                r["time_s"]
                for r in self.sessions
                if r["participant_id"] == row["participant_id"] and r["condition"] == "CTRL"
            )
            sr = sum(
                r["time_s"]
                for r in self.sessions
                if r["participant_id"] == row["participant_id"] and r["condition"] == "SR"
            )
            self.assertAlmostEqual(row["reduction_pct"], 100 * (ctrl - sr) / ctrl, places=3)
        self.assertEqual(
            self.summary["paired_subject_median_reduction_pct"],
            round(statistics.median(r["reduction_pct"] for r in self.paired), 2),
        )

    def test_completion_does_not_count_assisted_as_unassisted(self):
        sr = self.summary["conditions"]["SR"]
        self.assertEqual(sr["unassisted"] + sr["assisted"] + sr["failed"], sr["attempts"])
        self.assertGreater(sr["assisted"], 0)
        self.assertGreater(sr["failed"], 0)
        self.assertGreater(sr["completion_with_help_pct"], sr["completion_pct"])
        self.assertTrue(all(r["help_requests"] == 0 for r in self.sessions if r["success"] == "1"))

    def test_preserves_failure_and_timeout_distinction(self):
        fail = [r for r in self.sessions if r["success"] == "0"]
        self.assertTrue(any(r["time_s"] == 300 for r in fail))
        self.assertTrue(any(r["time_s"] < 300 for r in fail))
        self.assertTrue(all(r["success"] == "0" for r in self.sessions if r["time_s"] == 300))

    def test_market_uses_organiser_denominator_and_baseline(self):
        market = self.summary["interview_scenario"]
        self.assertEqual(market["event_weighted_multi_session_pct"], round(100 * 20 / 54, 2))
        self.assertEqual(market["baseline_coordination_hours_median"], 4.0)
        self.assertEqual(market["bargain_sgd_month_median"], 8)

    def test_source_labels_and_no_field_evidence_outputs(self):
        files = build_files()
        self.assertEqual(self.summary["source_type"], "SIMULATED")
        for path, content in files.items():
            self.assertNotIn("results/user-study/", path)
            self.assertNotIn("results/interviews/", path)
            if path.endswith(".csv"):
                rows = list(csv.DictReader(io.StringIO(content)))
                self.assertTrue(all(r["source_type"] == "SIMULATED" for r in rows), path)
        tex = files["research.tex"]
        self.assertNotIn("\\newcommand{\\Study", tex)
        self.assertNotIn("\\newcommand{\\Interview", tex)
        self.assertIn("\\newcommand{\\SimStudyN}{12}", tex)

    def test_generation_and_manifest_are_reproducible(self):
        first, second = build_files(), build_files()
        self.assertEqual(first, second)
        self.assertNotEqual(first["session-sheet.csv"], build_files(20261032)["session-sheet.csv"])
        manifest = json.loads(first["manifest.json"])
        self.assertEqual(manifest["counts"]["task_attempts"], 112)
        self.assertEqual(len(manifest["files_sha256"]), len(first) - 1)

    def test_rejects_corrupted_task_identity_outcomes_and_metadata(self):
        for key, value in (
            ("task_id", "unknown"),
            ("participant_id", "SIM-UNKNOWN"),
            ("condition", "unknown"),
            ("success", "invalid"),
            ("track", "organiser"),
            ("dataset", "wrong"),
            ("period", 2),
            ("errors", -1),
            ("help_requests", -1),
        ):
            rows = copy.deepcopy(self.sessions)
            rows[0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(self.source, rows, self.sus)

    def test_rejects_sus_from_another_participant_or_condition(self):
        for key, value in (
            ("participant_id", "SIM-UNKNOWN"),
            ("condition", "unknown"),
            ("source_type", "REAL"),
        ):
            rows = copy.deepcopy(self.sus)
            rows[0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(self.source, self.sessions, rows)

    def test_rejects_duplicate_profiles_and_authored_events(self):
        for field in ("study_profiles", "study_exceptions"):
            source = copy.deepcopy(self.source)
            source[field].append(copy.deepcopy(source[field][0]))
            with self.subTest(field=field), self.assertRaises(ValueError):
                generate_study(source, source["seed"])

    def test_failure_classification_does_not_depend_on_note_wording(self):
        source = copy.deepcopy(self.source)
        for event in source["study_exceptions"]:
            event["note"] = "A rewritten explanation with no numeric timeout marker"
        rows, _ = generate_study(source, source["seed"])
        self.assertEqual(
            [(r["success"], r["time_s"], r["failure_kind"]) for r in rows],
            [(r["success"], r["time_s"], r["failure_kind"]) for r in self.sessions],
        )

    def test_chart_manifest_detects_changed_data_or_corrupt_figures(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "figures").mkdir()
            for name in FIGURE_INPUTS:
                (out / name).write_text("input", encoding="utf-8")
            for name in FIGURE_NAMES:
                for ext in ("png", "pdf"):
                    (out / "figures" / f"{name}.{ext}").write_bytes(b"chart")
            manifest = out / "figures/manifest.json"
            manifest.write_text(json.dumps(figure_manifest(out)), encoding="utf-8")
            check_figures(out)
            chart = out / "figures/completion.pdf"
            chart.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "stale or modified"):
                check_figures(out)
            chart.write_bytes(b"chart")
            (out / "summary.json").write_text("different data", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "stale or modified"):
                check_figures(out)

    def test_cli_roundtrip_and_stale_file_detection(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            out = Path(tmp)
            # A custom TeX destination inside the output directory must also be accepted.
            args = ["--out", str(out), "--tex", str(out / "custom.tex")]
            self.assertEqual(main(args), 0)
            self.assertEqual(main([*args, "--check"]), 0)
            (out / "obsolete-round.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "unexpected file: obsolete-round.json"):
                main([*args, "--check"])

    def test_alternate_seed_requires_a_separate_output_directory(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            main(["--seed", "42"])
        self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
