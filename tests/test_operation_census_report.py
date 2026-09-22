"""Offline report controls: synthetic schema2 only, no backend or live access."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "operation_census_report.py"
FIXTURE = ROOT / "tests" / "fixtures" / "operation-census-report" / "mixed-schema2.json"
spec = importlib.util.spec_from_file_location("operation_census_report", TOOL)
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def window(rows, *, recorded=None, observed=None):
    """Build synthetic snapshot accounting independently of report helpers."""
    body = fixture()
    body["records"] = copy.deepcopy(rows)
    recorded = len(rows) if recorded is None else recorded
    body["counters"] = dict.fromkeys(body["counters"], 0)
    body["counters"].update(recorded=recorded, observed=recorded if observed is None else observed,
                            evicted=max(0, recorded - 64))
    body.update(served=len(rows), truncated_by_limit=min(recorded, 64) - len(rows),
                evicted_derived=max(0, recorded - 64),
                oldest_seq=recorded - len(rows) + 1 if rows else None,
                newest_seq=recorded if rows else None)
    for index, row in enumerate(body["records"]):
        row["seq"] = recorded - len(rows) + index + 1
    for key, predicate in (
        ("nonterminal", lambda r: not r["terminal"]),
        ("no_response_start", lambda r: r.get("no_response_start", False)),
        ("unclassified_scope", lambda r: r["scope"] == "unknown"),
        ("unclassified_method", lambda r: r["method"] == "other"),
        ("unclassified_action", lambda r: "tool" in r and "action" not in r),
    ):
        body["counters"][key] = sum(bool(predicate(r)) for r in rows)
    counts = dict.fromkeys(body["provenance"]["scope_src_counts"], 0)
    for row in rows:
        counts[row["scope_src"]] += 1
    body["provenance"].update(scope_src_counts=counts,
                              declared_coverage=round(counts["declared"] / len(rows), 6) if rows else 0.0)
    return body


class ReportTests(unittest.TestCase):
    def test_real_shape_mixed_attempts_preserve_semantics_and_source(self):
        source = fixture()
        before = copy.deepcopy(source)
        report = reporter.build_report(source)
        self.assertEqual(source, before)
        self.assertEqual(report["unit"], "attempt")
        self.assertEqual(report["snapshot"]["counters"], source["counters"])
        self.assertEqual(report["snapshot"]["limits"], source["limits"])
        self.assertEqual(report["special_records"], {
            "diagnostic": [4], "nonterminal": [3], "no_response_start": [2]})
        yielded = report["timeline"][2]
        self.assertEqual((yielded["status"], yielded["outcome"], yielded["terminal"]),
                         (200, "unknown", False))
        self.assertEqual([r["seq"] for r in report["timeline"]], [1, 2, 3, 4, 5, 6])
        self.assertEqual([r["t_ms"] for r in report["timeline"]], [100, 120, 15000, 15001, 14900, 15500])
        self.assertEqual(report["coverage"]["observed_minus_accounted"], 1)
        self.assertEqual(report["coverage"]["observed_without_served_record"], 6)
        self.assertIn("incomplete", report["coverage"]["assessment"])
        self.assertEqual(report["coverage"]["measurement_coverage"]["lock_hold_ms"], {"known": 0, "missing": 6})
        self.assertEqual(report["coverage"]["dimensions"]["scope"]["unknown"], 1)
        text = reporter.render_markdown(report)
        for expected in ("managed_yield", "skipped_self", "dropped_stale_window", "missing", "No start timestamps", "logical", "locality"):
            self.assertIn(expected, text)

    def test_a2_queue_maximum_is_preserved_with_honest_missing_coverage(self):
        source = fixture()
        before = reporter.build_report(source)
        source["records"][0]["lock_queue_ahead_max"] = 3.0
        source["records"][1]["lock_queue_ahead_max"] = 0.0
        source["records"][2]["lock_queue_ahead_max"] = None
        result = reporter.build_report(source)
        self.assertEqual(result["timeline"][0]["lock_queue_ahead_max"], 3.0)
        self.assertEqual(result["timeline"][1]["lock_queue_ahead_max"], 0.0)
        self.assertIsNone(result["timeline"][2]["lock_queue_ahead_max"])
        self.assertNotIn("lock_queue_ahead_max", result["timeline"][3])
        self.assertEqual(result["coverage"]["measurement_coverage"]["lock_queue_ahead_max"],
                         {"known": 2, "missing": 4})
        self.assertEqual(result["ranks"], before["ranks"],
                         "queue depth is not a duration and cannot alter latency ranks")
        self.assertIn("lock_queue_ahead_max", reporter.render_markdown(result))
        for bad in (True, -1, "3", float("inf"), float("nan"), 2**53):
            with self.subTest(bad=bad):
                invalid = fixture()
                invalid["records"][0]["lock_queue_ahead_max"] = bad
                with self.assertRaises(reporter.ReportError):
                    reporter.build_report(invalid)

    def test_exact_percentiles_and_cumulative_ranking_with_missing_and_zero(self):
        rows = []
        for value in [1, 2, 3, 4, 5, 6, 7, 8, 9, 100, None]:
            row = copy.deepcopy(fixture()["records"][0])
            row["handler_ms"] = value
            row.pop("unattributed_ms", None)
            rows.append(row)
        other = copy.deepcopy(rows[0])
        other.update(route="/api/status", op="GET /api/status", handler_ms=200)
        rows.append(other)
        result = reporter.build_report(window(rows))["ranks"]["handler_ms"]
        self.assertEqual([r["identity"]["op"] for r in result], ["GET /api/status", "GET /api/orgs/{slug}"])
        self.assertEqual({k: result[1][k] for k in ("count", "known", "missing", "p50", "p90", "p99", "max", "cumulative")},
                         {"count": 11, "known": 10, "missing": 1, "p50": 5, "p90": 9, "p99": 100, "max": 100, "cumulative": 145})
        rows[0]["handler_ms"] = 0
        result = reporter.build_report(window(rows))["ranks"]["handler_ms"][1]
        self.assertEqual((result["known"], result["cumulative"]), (10, 144))

    def test_missing_only_groups_are_not_zero_and_ties_are_stable(self):
        rows = []
        for route, value in [("/z", None), ("/b", 1), ("/a", 1), ("/null", None)]:
            row = copy.deepcopy(fixture()["records"][0])
            row.update(route=route, op="GET " + route)
            row.pop("handler_ms")
            if route != "/z":
                row["handler_ms"] = value
            rows.append(row)
        ranks = reporter.build_report(window(rows))["ranks"]["handler_ms"]
        self.assertEqual([r["identity"]["route"] for r in ranks], ["/a", "/b", "/null", "/z"])
        self.assertEqual((ranks[-1]["known"], ranks[-1]["missing"]), (0, 1))
        self.assertTrue(all(ranks[-1][key] is None for key in ("p50", "p90", "p99", "max", "cumulative")))

    def test_subdimensions_and_missing_tool_action_do_not_collapse(self):
        row = copy.deepcopy(fixture()["records"][2])
        row.update(terminal=True, outcome="ok")
        row.pop("nonterminal_reason")
        rows = [copy.deepcopy(row) for _ in range(3)]
        rows[0]["sub"] = {"kind": "file"}
        rows[1]["sub"] = {"kind": "process"}
        rows[2].pop("action")
        rows[2].pop("action_of")
        rows[2]["op"] = "tool:orgtree_watchdog"
        result = reporter.build_report(window(rows))
        self.assertEqual(len(result["ranks"]["handler_ms"]), 3)
        self.assertEqual(result["snapshot"]["counters"]["unclassified_action"], 1)

    def test_loss_trimming_and_zero_limit_are_distinct(self):
        rows = [copy.deepcopy(fixture()["records"][0]) for _ in range(10)]
        source = window(rows, recorded=100, observed=103)
        source["counters"]["skipped_self"] = 3
        result = reporter.build_report(source)
        self.assertEqual((result["coverage"]["retained_in_ring"], result["coverage"]["retained_not_served"], result["coverage"]["evicted_attempts"]), (64, 54, 36))
        self.assertEqual([r["seq"] for r in result["timeline"]], list(range(91, 101)))
        empty = reporter.build_report(window([], recorded=100))
        self.assertEqual((empty["coverage"]["retained_not_served"], empty["coverage"]["evicted_attempts"]), (64, 36))
        self.assertEqual(empty["ranks"], {"handler_ms": [], "total_ms": []})

    def test_empty_and_disabled_windows_never_claim_complete_capture(self):
        for observed in (0, 5):
            source = window([], observed=observed)
            source["enabled"] = False
            source["counters"]["skipped_disabled"] = observed
            result = reporter.build_report(source)
            self.assertEqual(result["coverage"]["observed_attempts"], observed)
            self.assertIn("incomplete", result["coverage"]["assessment"])

    def test_stale_window_and_cross_reset_counters_are_not_current_denominators(self):
        source = window([])
        source["counters"].update(dropped_stale_window=2, rejected=1, skipped_self=1)
        result = reporter.build_report(source)
        self.assertEqual(result["coverage"]["observed_minus_accounted"], -2)
        self.assertIn("across reset", result["coverage"]["accounting_note"])
        self.assertEqual(result["coverage"]["observed_attempts"], 0)

    def test_negative_unattributed_is_preserved_without_subtracting_from_latency(self):
        report = reporter.build_report(fixture())
        self.assertEqual(report["timeline"][-1]["unattributed_ms"], -10)
        org = next(r for r in report["ranks"]["handler_ms"] if r["identity"]["op"] == "GET /api/orgs/{slug}")
        self.assertEqual((org["known"], org["missing"], org["cumulative"]), (2, 1, 40))

    def test_all_numeric_fields_reject_boolean_nonfinite_and_wrong_types(self):
        # Every numeric slot is attacked, including optional measurements.
        for field in ("seq", "t_ms", "v", "status", *reporter.MEASUREMENTS):
            for bad in (True, float("nan"), float("inf"), float("-inf"), "12"):
                with self.subTest(field=field, bad=bad):
                    source = fixture()
                    source["records"][0][field] = bad
                    with self.assertRaises(reporter.ReportError):
                        reporter.build_report(source)
        for field in reporter.COUNTERS:
            source = fixture()
            source["counters"][field] = True
            with self.subTest(counter=field), self.assertRaises(reporter.ReportError):
                reporter.build_report(source)
        self.assertEqual(reporter.build_report(fixture())["timeline"][0]["handler_ms"], 10)

    def test_corrupted_identity_order_window_and_accounting_fail_closed(self):
        mutations = [
            lambda s: s.update(schema_version=1),
            lambda s: s.update(schema_version=True),
            lambda s: s.update(instance=""),
            lambda s: s.update(window_generation=0),
            lambda s: s.update(window_generation=True),
            lambda s: s.update(window_started_at="2026-02-30T00:00:00Z"),
            lambda s: s.update(window_ms=1),
            lambda s: s["records"].reverse(),
            lambda s: s["records"][1].update(seq=1),
            lambda s: s["records"][0].update(seq=2),
            lambda s: s["records"][0].update(instance="foreign-process"),
            lambda s: s["records"][0].update(unit="logical_operation"),
            lambda s: s["records"][0].update(op="GET /other"),
            lambda s: s["records"][0].update(handler_ms=-1),
            lambda s: s["records"][2].update(outcome="ok"),
            lambda s: s["records"][2].update(terminal=True),
            lambda s: s["records"][1].update(handler_ms=0),
            lambda s: s["records"][3].update(diagnostic=False),
            lambda s: s["records"][0].update(outcome="server_error"),
            lambda s: s["records"][0].update(method="UNSAFE"),
            lambda s: s["records"][0].update(actual_database="invented"),
            lambda s: s.update(newest_seq=5),
            lambda s: s.update(served=5),
            lambda s: s.update(truncated_by_limit=1),
            lambda s: s.update(evicted_derived=1),
            lambda s: s["counters"].update(observed=5),
            lambda s: s["counters"].update(nonterminal=0),
            lambda s: s["counters"].update(nonterminal=2),
            lambda s: s["provenance"].update(declared_coverage=1),
            lambda s: s["provenance"].update(measures_storage_contacts=True),
            lambda s: s["provenance"]["scope_src_counts"].update(table=True),
            lambda s: s["vocabulary"]["scope"].append("imagined"),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(control=index):
                source = fixture()
                mutate(source)
                with self.assertRaises(reporter.ReportError):
                    reporter.build_report(source)

    def test_census_self_read_cannot_masquerade_as_work(self):
        row = copy.deepcopy(fixture()["records"][3])
        row.update(route="/api/diagnostics/operation-census", op="GET /api/diagnostics/operation-census")
        with self.assertRaisesRegex(reporter.ReportError, "self-reads"):
            reporter.build_report(window([row]))

    def test_structural_bounds_and_unknown_fields(self):
        for mutate in (
            lambda s: s.update(capacity=262145),
            lambda s: s.update(records=[{}] * 16385),
            lambda s: s.update(instance="x" * 4097),
            lambda s: s.update(window_ms=2**53),
            lambda s: s.update(live_endpoint="http://127.0.0.1"),
        ):
            source = fixture()
            mutate(source)
            with self.assertRaises(reporter.ReportError):
                reporter.build_report(source)

    def test_markdown_escapes_source_text_and_stays_deterministic(self):
        source = fixture()
        source["limits"].append("<script>alert(1)</script> | `token`")
        report = reporter.build_report(source)
        text = reporter.render_markdown(report)
        self.assertNotIn("<script>", text)
        self.assertIn("&lt;script&gt;", text)
        self.assertIn("&#124;", text)
        self.assertEqual(text, reporter.render_markdown(reporter.build_report(source)))


class FileAndCliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(TOOL), *map(str, args)], capture_output=True, text=True, timeout=15)

    def test_cli_json_markdown_hash_and_determinism(self):
        first = self.run_cli(FIXTURE)
        second = self.run_cli(FIXTURE)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, second.stdout)
        body = json.loads(first.stdout)
        self.assertEqual(body["source"]["sha256"], hashlib.sha256(FIXTURE.read_bytes()).hexdigest())
        self.assertEqual(body["source"]["bytes"], FIXTURE.stat().st_size)
        markdown = self.run_cli(FIXTURE, "--format", "markdown")
        self.assertEqual(markdown.returncode, 0, markdown.stderr)
        self.assertIn("Completion-offset timeline", markdown.stdout)
        self.assertIn("cumulative", markdown.stdout)
        self.assertNotIn("orgtree.api", sys.modules)

    def test_explicit_unsafe_cli_controls_refuse_before_any_input_open(self):
        for arguments in (
            ("http://127.0.0.1:1/api/diagnostics/operation-census",),
            ("https://example.invalid/snapshot.json",), ("-",),
            (r"\\server\share\snapshot.json",), ("//server/share/snapshot.json",),
            (FIXTURE, "--enable-capture"), (FIXTURE, "--endpoint", "http://127.0.0.1"),
            (FIXTURE, "--live"), (FIXTURE, "--format", "postgres"),
        ):
            with self.subTest(args=arguments):
                result = self.run_cli(*arguments)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, "")
        with patch.object(reporter.os, "open", side_effect=AssertionError("must not open")):
            for path in ("http://localhost/snapshot", r"\\server\share\snapshot", "-"):
                with self.assertRaises(reporter.ReportError):
                    reporter.read_snapshot(path)

    def test_invalid_json_duplicate_keys_nonfinite_and_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            good = FIXTURE.read_text(encoding="utf-8")
            for raw in ("{}{}", "[]", "{", '{"schema_version":2,"schema_version":2}',
                        good.replace('"handler_ms": 10', '"handler_ms": NaN', 1),
                        good.replace('"handler_ms": 10', '"handler_ms": 1e309', 1),
                        "[" * 1500 + "]" * 1500):
                path.write_text(raw, encoding="utf-8")
                result = self.run_cli(path)
                self.assertEqual(result.returncode, 2, raw[:80])
                self.assertEqual(result.stdout, "")
            with path.open("wb") as stream:
                stream.truncate(reporter.MAX_INPUT_BYTES + 1)
            with self.assertRaisesRegex(reporter.ReportError, "byte bound"):
                reporter.read_snapshot(path)
            path.write_bytes(FIXTURE.read_bytes())
            self.assertEqual(reporter.read_snapshot(path)[0]["served"], 6)

    def test_nonregular_and_symlink_inputs_refuse(self):
        with self.assertRaises(reporter.ReportError):
            reporter.read_snapshot(FIXTURE.parent)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "link.json"
            # Test the refusal itself without requiring Windows symlink privilege.
            original = Path.lstat
            def link_stat(path):
                if path == target:
                    class LinkInfo:
                        st_mode = 0o120777
                    return LinkInfo()
                return original(path)
            with patch.object(Path, "lstat", link_stat), self.assertRaisesRegex(reporter.ReportError, "links"):
                reporter.read_snapshot(target)


if __name__ == "__main__":
    unittest.main(verbosity=2)
