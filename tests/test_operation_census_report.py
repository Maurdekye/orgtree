"""Offline report controls: synthetic schema2/schema3/schema4 fixtures, no live access.

This process never imports the backend. The one producer-to-report round trip
runs the in-tree census in a CHILD process against a temporary data root with
capture on, and reads back only the snapshot file it wrote.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "operation_census_report.py"
FIXTURE = ROOT / "tests" / "fixtures" / "operation-census-report" / "mixed-schema2.json"
FIXTURE3 = ROOT / "tests" / "fixtures" / "operation-census-report" / "mixed-schema3.json"
FIXTURE4 = ROOT / "tests" / "fixtures" / "operation-census-report" / "mixed-schema4.json"
spec = importlib.util.spec_from_file_location("operation_census_report", TOOL)
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)

# ⚠ SCHEMA 2 OUTPUT MUST NEVER MOVE. sha256 of the CLI's stdout (read as text,
# so newlines are "\n", then UTF-8) for mixed-schema2.json, measured with
# tools/operation_census_report.py at a1f8fd9 — BEFORE schema3 support existed.
GOLDEN_SCHEMA2 = {
    "json": "3bef3d0c3442fdda0166d9051363c17f618b5b0e2a1059b456f5db05a577c195",
    "markdown": "535a759e31c0c7a89e53d8ebbe9b5f5d3711f181cb2fb0337ba2bf2ec6524dea",
}
# ⚠ SCHEMA 3 OUTPUT STAYS AS LANDED. The same measure for mixed-schema3.json,
# taken with the tool at cfef919 (P02-A4a) — before schema4 support existed.
GOLDEN_SCHEMA3 = {
    "json": "a4df53f7e36c28082548e5a5dc24a0c21a7bb04275b3b5c0d01c65e8a49eb828",
    "markdown": "7924880ef5d7a062e4fcb21c7056fb822a96b2fa5f4023e423f5e90a77ab8b59",
}
LABELS = ["transcript_records", "reply_events", "chat_window_index", "tool_waits", "file_deliveries"]


def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def fixture3():
    return json.loads(FIXTURE3.read_text(encoding="utf-8"))


def fixture4():
    return json.loads(FIXTURE4.read_text(encoding="utf-8"))


def recount_sidecars(rows):
    """Per-label sums over the rows' db.secondary blocks, recomputed here."""
    by_label = {}
    for row in rows:
        for label, block in row.get("db", {}).get("secondary", {}).items():
            by_label.setdefault(label, []).append({"db": block})
    return {label: recount(blocks) for label, blocks in by_label.items()}


def recount(rows):
    """Contact sums recomputed here, independently of the reporter's helpers."""
    fields = ("connects", "connect_failed", "checkouts", "statements", "statement_failed",
              "statement_busy", "engine_steps", "hidden_steps", "linked_threads")
    totals = {field: 0 for field in fields}
    kinds, failed = {}, {}
    for row in rows:
        db = row.get("db")
        if db is None:
            continue
        for field in fields:
            totals[field] += db[field]
        for kind, n in db["kinds"].items():
            kinds[kind] = kinds.get(kind, 0) + n
        for kind, n in db["kind_failed"].items():
            failed[kind] = failed.get(kind, 0) + n
    totals["kinds"], totals["kind_failed"] = kinds, failed
    return totals


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


class Schema3Tests(unittest.TestCase):
    """Schema 3: the primary store's observed SQLite contacts (P02-A3)."""

    def refuse(self, source, message=None):
        with self.subTest(message=message):
            with self.assertRaises(reporter.ReportError):
                reporter.build_report(source)

    def test_schema3_reports_v2_with_exact_contact_sums_and_no_derived_claim(self):
        source = fixture3()
        before = copy.deepcopy(source)
        report = reporter.build_report(source)
        self.assertEqual(source, before)
        self.assertEqual(report["report_schema"], "orgtree.operation-census-report/v2")
        self.assertEqual(report["limits"], reporter.LIMITS_V2)
        contacts = report["contacts"]
        # Exercised, not vacuous: the fixture carries real contacts, a failure,
        # a failed connect, a hidden step and a row with no evidence at all.
        self.assertEqual(contacts["totals"], recount(source["records"]))
        self.assertEqual(contacts["totals"]["statements"], 33)
        self.assertEqual(contacts["totals"]["kind_failed"], {"insert": 1})
        self.assertEqual((contacts["with_contact_evidence"], contacts["without_contact_evidence"],
                          contacts["without_contact_evidence_seqs"]), (5, 1, [2]))
        self.assertIs(contacts["complete"], False)
        self.assertEqual(contacts["measures"], "primary_sqlite_store_only")
        self.assertEqual(contacts["process_counters"],
                         {k: source["counters"][k] for k in reporter.DB_COUNTERS})
        self.assertEqual(report["snapshot"]["contact_coverage"], source["contact_coverage"])
        self.assertEqual(report["snapshot"]["limits"], source["limits"])
        org = next(r for r in contacts["by_operation"] if r["identity"]["op"] == "GET /api/orgs/{slug}")
        self.assertEqual((org["attempts"], org["with_contact_evidence"], org["without_contact_evidence"]), (3, 2, 1))
        self.assertEqual(org["statements"], 29)
        self.assertEqual(sum(r["statements"] for r in contacts["by_operation"]), 33)
        self.assertEqual([r["rank"] for r in contacts["by_operation"]], list(range(1, len(contacts["by_operation"]) + 1)))
        # The contact block derives nothing: no share, rate or locality number.
        words = {word for key in self._keys(contacts) for word in key.lower().split("_")}
        self.assertIn("statements", words, "the key scan saw the contact block")
        for banned in ("percent", "pct", "share", "ratio", "rate", "locality", "local", "proportion", "fraction"):
            self.assertNotIn(banned, words)
        self.assertIn("incomplete", report["coverage"]["assessment"])
        # Everything schema2 reports is reported the same way for schema3.
        schema2 = reporter.build_report(fixture())
        for key in ("ranks", "coverage", "special_records", "percentile_definition", "ranking_definition"):
            self.assertEqual(report[key], schema2[key], key)

    def _keys(self, value):
        if isinstance(value, dict):
            for key, item in value.items():
                yield key
                yield from self._keys(item)
        elif isinstance(value, list):
            for item in value:
                yield from self._keys(item)

    def test_a_row_without_a_db_block_is_unobserved_never_zero(self):
        source = fixture3()
        self.assertNotIn("db", source["records"][1])
        zeroed = copy.deepcopy(source)
        zeroed["records"][1]["db"] = copy.deepcopy(source["records"][3]["db"])
        zeroed["provenance"].update(rows_with_contact_evidence=6, rows_without_contact_evidence=0)
        zeroed["counters"]["db_unbound"] = 0
        a, b = reporter.build_report(source)["contacts"], reporter.build_report(zeroed)["contacts"]
        self.assertEqual(a["totals"], b["totals"], "a zero block and no block sum alike")
        self.assertEqual((a["without_contact_evidence"], b["without_contact_evidence"]), (1, 0),
                         "but only one of them was observed, and the report says which")

    def test_schema_dispatch_is_exact(self):
        for base in (fixture, fixture3, fixture4):
            for bad in (1, 5, 0, -3, True, False, 2.0, 3.0, 4.0, "2", "3", "4", None, [3], {"v": 3}):
                source = base()
                source["schema_version"] = bad
                self.refuse(source, f"{base.__name__} schema_version={bad!r}")
            source = base()
            del source["schema_version"]
            self.refuse(source, "missing schema_version")
        relabelled = fixture()
        relabelled["schema_version"] = 3
        self.refuse(relabelled, "schema2 body labelled 3")
        relabelled = fixture3()
        relabelled["schema_version"] = 2
        self.refuse(relabelled, "schema3 body labelled 2")
        for version in (3, 2):
            relabelled = fixture4()
            relabelled["schema_version"] = version
            self.refuse(relabelled, f"schema4 body labelled {version}")
        relabelled = fixture3()
        relabelled["schema_version"] = 4
        self.refuse(relabelled, "schema3 body labelled 4")
        self.refuse([], "not an object")

    def test_record_versions_must_match_their_snapshot(self):
        source = fixture3()
        source["records"][0]["v"] = 2
        self.refuse(source, "v2 row in schema3")
        source = fixture()
        source["records"][0]["v"] = 3
        self.refuse(source, "v3 row in schema2")
        source = fixture3()
        source["records"][4]["v"] = 4
        self.refuse(source, "v4 row in schema3")
        source = fixture4()
        source["records"][4]["v"] = 3
        self.refuse(source, "v3 row in schema4")

    def test_cross_schema_fields_are_refused(self):
        three = fixture3()
        for label, mutate in (
            ("db on schema2 row", lambda s: s["records"][0].update(db=copy.deepcopy(three["records"][0]["db"]))),
            ("contact_coverage on schema2", lambda s: s.update(contact_coverage=copy.deepcopy(three["contact_coverage"]))),
            ("db counter on schema2", lambda s: s["counters"].update(db_unbound=0)),
            ("db vocabulary on schema2", lambda s: s["vocabulary"].update(db_kind=list(reporter.DB_KINDS))),
            # A4a review N1: the COMPLETE schema-3 (and schema-4) vocabulary on
            # a schema-2 snapshot, not just one added key.
            ("complete schema3 vocabulary on schema2", lambda s: s.update(vocabulary=copy.deepcopy(reporter.VOCABULARY_V3))),
            ("complete schema4 vocabulary on schema2", lambda s: s.update(vocabulary=copy.deepcopy(reporter.VOCABULARY_V4))),
            ("contact provenance on schema2", lambda s: s["provenance"].update(rows_with_contact_evidence=0)),
        ):
            source = fixture()
            mutate(source)
            self.refuse(source, label)
        for label, mutate in (
            ("schema4 secondary block", lambda s: s["records"][0]["db"].update(secondary={})),
            ("schema4 coverage list", lambda s: s["contact_coverage"].update(secondary_stores=[])),
            ("schema4 measures", lambda s: s["provenance"].update(measures_storage_contacts="primary_and_listed_sidecar_sqlite_stores")),
            ("schema2 measures", lambda s: s["provenance"].update(measures_storage_contacts=False)),
            ("measures claims everything", lambda s: s["provenance"].update(measures_storage_contacts=True)),
            ("missing db counter", lambda s: s["counters"].pop("db_late")),
            ("missing coverage", lambda s: s.pop("contact_coverage")),
            ("missing contact provenance", lambda s: s["provenance"].pop("rows_with_contact_evidence")),
            ("schema2 vocabulary", lambda s: s.update(vocabulary=copy.deepcopy(fixture()["vocabulary"]))),
            ("extra vocabulary", lambda s: s["vocabulary"].update(db_secondary_store=["tool_waits"])),
        ):
            source = fixture3()
            mutate(source)
            self.refuse(source, label)

    def test_privacy_and_closed_set_negatives_fail_closed(self):
        mutations = []
        for key in ("sql", "path", "params", "slug", "duration_ms", "rows_examined", "database"):
            mutations.append((f"db extra {key}", lambda s, key=key: s["records"][0]["db"].update({key: "x"})))
        for field in reporter.DB_FIELDS:
            for bad in (True, -1, 1.5, "3", None, float("inf"), 2**53):
                mutations.append((f"db {field}={bad!r}", lambda s, f=field, b=bad: s["records"][0]["db"].update({f: b})))
        for field in reporter.DB_FIELDS + ("store", "kinds", "kind_failed"):
            mutations.append((f"db missing {field}", lambda s, f=field: s["records"][0]["db"].pop(f)))
        mutations += [
            ("db not an object", lambda s: s["records"][0].update(db=[])),
            ("unknown store", lambda s: s["records"][0]["db"].update(store="postgres")),
            ("unknown kind", lambda s: s["records"][0]["db"]["kinds"].update(vacuum=1)),
            ("uppercase kind", lambda s: s["records"][0]["db"]["kinds"].update(SELECT=1)),
            ("zero kind", lambda s: s["records"][0]["db"]["kinds"].update(ddl=0)),
            ("boolean kind", lambda s: s["records"][0]["db"]["kinds"].update(select=True)),
            ("kinds not an object", lambda s: s["records"][0]["db"].update(kinds=[])),
            ("unknown failed kind", lambda s: s["records"][5]["db"]["kind_failed"].update(merge=1)),
            ("coverage claims complete", lambda s: s["contact_coverage"].update(complete=True)),
            ("coverage complete as text", lambda s: s["contact_coverage"].update(complete="false")),
            ("coverage extra key", lambda s: s["contact_coverage"].update(database_path="C:/data/org.db")),
            ("coverage kinds reordered", lambda s: s["contact_coverage"]["kinds"].reverse()),
            ("coverage fields differ", lambda s: s["contact_coverage"]["fields"].append("rows")),
            ("coverage unknown primary", lambda s: s["contact_coverage"].update(primary_store="postgres")),
            ("coverage nothing instrumented", lambda s: s["contact_coverage"].update(instrumented=[])),
            ("coverage absolute path", lambda s: s["contact_coverage"]["instrumented"][0].update(path="C:/Users/someone/store.py")),
            ("coverage rooted path", lambda s: s["contact_coverage"]["instrumented"][0].update(path="/engine/store.py")),
            ("coverage parent path", lambda s: s["contact_coverage"]["uninstrumented"][0].update(path="../secret.py")),
            ("coverage non-source path", lambda s: s["contact_coverage"]["uninstrumented"][0].update(path="data/org.sqlite3")),
            ("coverage symbol text", lambda s: s["contact_coverage"]["uninstrumented"][0].update(symbol="SELECT * FROM agents")),
            ("coverage process text", lambda s: s["contact_coverage"]["other_processes"][0].update(process="Mail Hub")),
            ("coverage entry extra", lambda s: s["contact_coverage"]["instrumented"][0].update(slug="acme")),
            ("coverage process on instrumented", lambda s: s["contact_coverage"]["instrumented"][0].update(process="mailhub")),
            ("provenance extra claim", lambda s: s["provenance"].update(contact_share=0.5)),
        ]
        for label, mutate in mutations:
            source = fixture3()
            mutate(source)
            self.refuse(source, label)

    def test_producer_invariants_are_enforced_and_only_those(self):
        for label, mutate in (
            ("kinds do not sum to statements", lambda db: db.update(statements=db["statements"] + 1)),
            ("more failures than attempts of a kind", lambda db: db["kind_failed"].update(insert=2)),
            ("failure of a kind never attempted", lambda db: db["kind_failed"].update(delete=1)),
            ("statement_failed beyond failed kinds", lambda db: db.update(statement_failed=2)),
            ("busy beyond failed", lambda db: db.update(statement_busy=2, statement_failed=1)),
            ("failed connect beyond connects", lambda db: db.update(connect_failed=3)),
        ):
            source = fixture3()
            mutate(source["records"][5]["db"])
            self.refuse(source, label)
        for label, mutate in (
            ("db_unbound below unobserved rows", lambda s: s["counters"].update(db_unbound=0)),
            ("db_unbound beyond recorded bound", lambda s: s["counters"].update(db_unbound=2)),
            ("provenance miscounts evidence", lambda s: s["provenance"].update(rows_with_contact_evidence=6)),
            ("provenance miscounts absence", lambda s: s["provenance"].update(rows_without_contact_evidence=0)),
        ):
            source = fixture3()
            mutate(source)
            self.refuse(source, label)
        # POSITIVE CONTROLS: what the producer can legitimately emit is accepted.
        # A seal can land between a statement's kind update and its separate
        # failure/busy/connect-failure updates, so those may fall BELOW their
        # partners; and steps, checkouts and threads have no tie to statements.
        for label, mutate in (
            ("failure recorded on the kind only", lambda db: db.update(statement_failed=0, statement_busy=0)),
            ("connect counted without its failure", lambda db: db.update(connect_failed=0)),
            ("engine steps independent of statements", lambda db: db.update(engine_steps=0, hidden_steps=7)),
            ("checkouts and threads independent", lambda db: db.update(checkouts=9, linked_threads=4)),
        ):
            with self.subTest(accepted=label):
                source = fixture3()
                mutate(source["records"][5]["db"])
                reporter.build_report(source)
        source = fixture3()
        source["counters"]["db_unattributed"] = 10**6
        reporter.build_report(source)

    def test_schema3_markdown_is_escaped_deterministic_and_labelled(self):
        source = fixture3()
        source["limits"].append("<script>alert(1)</script> | `token`")
        report = reporter.build_report(source)
        text = reporter.render_markdown(report)
        self.assertNotIn("<script>", text)
        self.assertIn("&lt;script&gt;", text)
        self.assertIn("Observed storage contacts (primary SQLite store only)", text)
        self.assertIn("Contact coverage: incomplete", text)
        self.assertIn("db_unattributed", text)
        self.assertIn("engine/backend/orgtree/store.py", text)
        self.assertEqual(text, reporter.render_markdown(reporter.build_report(source)))
        self.assertNotIn("Observed storage contacts", reporter.render_markdown(reporter.build_report(fixture())))


class Schema4Tests(unittest.TestCase):
    """Schema 4: the listed sidecar stores, kept apart under db.secondary."""

    _keys = Schema3Tests._keys

    def refuse(self, source, message=None):
        with self.subTest(message=message):
            with self.assertRaises(reporter.ReportError):
                reporter.build_report(source)

    def test_schema4_reports_every_sidecar_apart_with_exact_sums(self):
        source = fixture4()
        before = copy.deepcopy(source)
        report = reporter.build_report(source)
        self.assertEqual(source, before)
        self.assertEqual(report["report_schema"], "orgtree.operation-census-report/v2")
        self.assertEqual(report["limits"], reporter.LIMITS_V2_SIDECARS)
        contacts = report["contacts"]
        self.assertEqual(contacts["measures"], "primary_and_listed_sidecar_sqlite_stores")
        self.assertIs(contacts["complete"], False)
        # Every label is exercised by the fixture, and each is summed apart.
        self.assertEqual(sorted(contacts["secondary_totals"]), sorted(LABELS))
        self.assertEqual(contacts["secondary_totals"], recount_sidecars(source["records"]))
        self.assertEqual(contacts["secondary_attempts"],
                         {label: sum(label in r.get("db", {}).get("secondary", {}) for r in source["records"])
                          for label in LABELS})
        # The primary store's numbers are exactly schema 3's: sidecars never leak in.
        three = reporter.build_report(fixture3())
        self.assertEqual(contacts["totals"], three["contacts"]["totals"])
        for key in ("ranks", "coverage", "special_records"):
            self.assertEqual(report[key], three[key], key)
        for item in contacts["by_operation"]:
            members = [r for r in source["records"] if r["op"] == item["identity"]["op"]]
            self.assertEqual(item["secondary"], recount_sidecars(members))
        self.assertEqual(sum(item["secondary"].get("tool_waits", {}).get("statements", 0)
                             for item in contacts["by_operation"]), 5)
        words = {word for key in self._keys(contacts) for word in key.lower().split("_")}
        for banned in ("percent", "pct", "share", "ratio", "rate", "locality", "local", "proportion", "fraction"):
            self.assertNotIn(banned, words)
        text = reporter.render_markdown(report)
        self.assertIn("primary SQLite store and listed sidecars", text)
        self.assertIn("Sidecar stores (kept apart from the primary store)", text)
        self.assertIn("secondary_stores:tool_waits", text)
        self.assertEqual(text, reporter.render_markdown(reporter.build_report(fixture4())))

    def test_schema3_reports_carry_no_sidecar_section(self):
        report = reporter.build_report(fixture3())
        self.assertNotIn("secondary_totals", report["contacts"])
        self.assertNotIn("secondary", report["contacts"]["by_operation"][0])
        self.assertNotIn("Sidecar stores", reporter.render_markdown(report))

    def test_sidecar_closed_set_privacy_and_invariant_negatives(self):
        row = 5   # seq 6 carries reply_events and file_deliveries
        mutations = [
            ("empty secondary", lambda s: s["records"][row]["db"].update(secondary={})),
            ("secondary not an object", lambda s: s["records"][row]["db"].update(secondary=[])),
            ("unknown label", lambda s: s["records"][row]["db"]["secondary"].update(other_store=copy.deepcopy(s["records"][row]["db"]["secondary"]["file_deliveries"]))),
            ("path as label", lambda s: s["records"][row]["db"]["secondary"].update({"C:/data/tool-waits.db": copy.deepcopy(s["records"][row]["db"]["secondary"]["file_deliveries"])})),
            ("uppercase label", lambda s: s["records"][row]["db"]["secondary"].update(TOOL_WAITS=copy.deepcopy(s["records"][row]["db"]["secondary"]["file_deliveries"]))),
            ("store inside a sidecar", lambda s: s["records"][row]["db"]["secondary"]["file_deliveries"].update(store="sqlite")),
            ("sidecar without contact", lambda s: s["records"][row]["db"]["secondary"].update(tool_waits={
                **{f: 0 for f in reporter.DB_FIELDS}, "kinds": {}, "kind_failed": {}})),
            ("sidecar kinds do not sum", lambda s: s["records"][row]["db"]["secondary"]["file_deliveries"].update(statements=3)),
            ("sidecar busy beyond failed", lambda s: s["records"][row]["db"]["secondary"]["file_deliveries"].update(statement_busy=2)),
            ("sidecar failed connect beyond connects", lambda s: s["records"][row]["db"]["secondary"]["reply_events"].update(connect_failed=2)),
            ("sidecar unknown kind", lambda s: s["records"][row]["db"]["secondary"]["file_deliveries"]["kinds"].update(vacuum=1)),
            ("sidecar missing field", lambda s: s["records"][row]["db"]["secondary"]["file_deliveries"].pop("engine_steps")),
            ("measures schema3", lambda s: s["provenance"].update(measures_storage_contacts="primary_sqlite_store_only")),
            ("schema3 vocabulary", lambda s: s.update(vocabulary=copy.deepcopy(reporter.VOCABULARY_V3))),
            ("labels reordered", lambda s: s["vocabulary"]["db_secondary_store"].reverse()),
            ("missing secondary_stores", lambda s: s["contact_coverage"].pop("secondary_stores")),
            ("empty secondary_stores", lambda s: s["contact_coverage"].update(secondary_stores=[])),
            ("secondary_stores unknown label", lambda s: s["contact_coverage"]["secondary_stores"][0].update(label="other_store")),
            ("secondary_stores without label", lambda s: s["contact_coverage"]["secondary_stores"][0].pop("label")),
            ("secondary_stores absolute path", lambda s: s["contact_coverage"]["secondary_stores"][0].update(path="C:/Users/x/transcript_records.py")),
            ("secondary_stores database file", lambda s: s["contact_coverage"]["secondary_stores"][0].update(path="data/transcript-records.sqlite3")),
            ("secondary_stores extra key", lambda s: s["contact_coverage"]["secondary_stores"][0].update(database="tool-waits.db")),
            ("coverage claims complete", lambda s: s["contact_coverage"].update(complete=True)),
        ]
        for key in ("sql", "path", "params", "slug", "duration_ms", "rows_examined", "file"):
            mutations.append((f"sidecar extra {key}", lambda s, key=key: s["records"][row]["db"]["secondary"]["file_deliveries"].update({key: "x"})))
        for bad in (True, -1, 1.5, "3", None, float("inf")):
            mutations.append((f"sidecar count {bad!r}", lambda s, b=bad: s["records"][row]["db"]["secondary"]["reply_events"].update(connects=b)))
        for label, mutate in mutations:
            source = fixture4()
            mutate(source)
            self.refuse(source, label)
        # Positive controls: the legitimate shapes are accepted.
        for label, mutate in (
            ("connect-only sidecar", lambda s: None),
            ("seal race on a sidecar failure", lambda s: s["records"][row]["db"]["secondary"]["file_deliveries"].update(statement_failed=0, statement_busy=0)),
            ("an attempt with no sidecar", lambda s: s["records"][row]["db"].pop("secondary")),
        ):
            with self.subTest(accepted=label):
                source = fixture4()
                mutate(source)
                reporter.build_report(source)


class Schema3RefusesSchema4FieldsTests(unittest.TestCase):
    """A schema-3 snapshot must refuse each schema-4 contact field on its own.

    Each injected value is COPIED FROM THE VALID SCHEMA-4 FIXTURE, so it is
    non-empty and well-formed. The refusal therefore cannot come from an
    emptiness or shape check on the value itself. Each negative pins its own
    refusal message, so the three paths cannot stand in for one another. Each
    control shows the identical content is accepted once the snapshot really
    is schema 4."""

    @staticmethod
    def as_schema4(source):
        """Upgrade a schema-3 snapshot to a valid schema-4 one, keeping any
        schema-4 content it already carries."""
        four = fixture4()
        upgraded = copy.deepcopy(source)
        upgraded["schema_version"] = 4
        for row in upgraded["records"]:
            row["v"] = 4
        upgraded["vocabulary"] = copy.deepcopy(four["vocabulary"])
        upgraded["provenance"]["measures_storage_contacts"] = four["provenance"]["measures_storage_contacts"]
        upgraded["contact_coverage"].setdefault("secondary_stores", copy.deepcopy(four["contact_coverage"]["secondary_stores"]))
        return upgraded

    def check(self, mutate, message):
        source = fixture3()
        reporter.build_report(source)   # the untouched schema-3 baseline is accepted
        mutate(source)
        with self.assertRaisesRegex(reporter.ReportError, message):
            reporter.build_report(source)
        # Discriminating control: the very same content passes as schema 4.
        report = reporter.build_report(self.as_schema4(source))
        self.assertEqual(report["report_schema"], "orgtree.operation-census-report/v2")
        return report

    def test_a_schema3_row_refuses_a_non_empty_db_secondary(self):
        secondary = copy.deepcopy(fixture4()["records"][5]["db"]["secondary"])
        self.assertEqual(sorted(secondary), ["file_deliveries", "reply_events"], "the injected block is non-empty")
        report = self.check(lambda s: s["records"][5]["db"].update(secondary=secondary),
                            r"^record\.db: unsupported fields$")
        self.assertEqual(sorted(report["contacts"]["secondary_totals"]), ["file_deliveries", "reply_events"])

    def test_schema3_coverage_refuses_secondary_stores(self):
        stores = copy.deepcopy(fixture4()["contact_coverage"]["secondary_stores"])
        self.assertEqual(len(stores), 6, "the injected list is the full, valid schema-4 list")
        report = self.check(lambda s: s["contact_coverage"].update(secondary_stores=stores),
                            r"^contact_coverage: unsupported fields$")
        self.assertEqual(report["snapshot"]["contact_coverage"]["secondary_stores"], stores)

    def test_a_schema3_vocabulary_refuses_db_secondary_store(self):
        labels = list(reporter.DB_SECONDARY_STORES)
        self.assertEqual(fixture4()["vocabulary"]["db_secondary_store"], labels)
        self.check(lambda s: s["vocabulary"].update(db_secondary_store=labels),
                   r"^incompatible schema3 vocabulary$")

    def test_the_three_refusals_are_distinct_paths(self):
        """Each injection alone trips only its own check: the messages differ,
        and each one appears for exactly one of the three injections."""
        four = fixture4()
        injections = {
            "row": lambda s: s["records"][5]["db"].update(secondary=copy.deepcopy(four["records"][5]["db"]["secondary"])),
            "coverage": lambda s: s["contact_coverage"].update(secondary_stores=copy.deepcopy(four["contact_coverage"]["secondary_stores"])),
            "vocabulary": lambda s: s["vocabulary"].update(db_secondary_store=list(reporter.DB_SECONDARY_STORES)),
        }
        messages = {}
        for name, mutate in injections.items():
            source = fixture3()
            mutate(source)
            with self.assertRaises(reporter.ReportError) as caught:
                reporter.build_report(source)
            messages[name] = str(caught.exception)
        self.assertEqual(messages, {"row": "record.db: unsupported fields",
                                    "coverage": "contact_coverage: unsupported fields",
                                    "vocabulary": "incompatible schema3 vocabulary"})


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(TOOL), *map(str, args)], capture_output=True, text=True, timeout=15)

    def test_schema2_and_schema3_output_bytes_match_their_goldens(self):
        for fixture_path, goldens in ((FIXTURE, GOLDEN_SCHEMA2), (FIXTURE3, GOLDEN_SCHEMA3)):
            for fmt, digest in goldens.items():
                with self.subTest(fixture=fixture_path.name, format=fmt):
                    result = self.run_cli(fixture_path, "--format", fmt)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(hashlib.sha256(result.stdout.encode("utf-8")).hexdigest(), digest)

    def test_schema3_and_schema4_cli_json_and_markdown(self):
        for fixture_path in (FIXTURE3, FIXTURE4):
            with self.subTest(fixture=fixture_path.name):
                first, second = self.run_cli(fixture_path), self.run_cli(fixture_path)
                self.assertEqual(first.returncode, 0, first.stderr)
                self.assertEqual(first.stdout, second.stdout)
                body = json.loads(first.stdout)
                self.assertEqual(body["report_schema"], "orgtree.operation-census-report/v2")
                self.assertEqual(body["source"]["sha256"], hashlib.sha256(fixture_path.read_bytes()).hexdigest())
                markdown = self.run_cli(fixture_path, "--format", "markdown")
                self.assertEqual(markdown.returncode, 0, markdown.stderr)
                self.assertIn("Observed storage contacts", markdown.stdout)
        self.assertNotIn("orgtree.api", sys.modules)


# The in-tree census, driven in a child process: a temporary data root, capture
# switched on in THAT process only, requests through the app's test client (no
# lifespan, so no hub starts), and the snapshot written to one file. Five more
# attempts go through the census's own bind/observe, exactly as the access
# middleware does, around the real sidecar sites (transcript_records.database,
# toolwait.records) or, for the two sites that need an agent transcript or a
# delivery seat, around the sidecar class on its own file as its site opens it.
PRODUCER = r"""
import contextlib, json, os, sqlite3, sys
from pathlib import Path
sys.path[:0] = json.loads(os.environ["CENSUS_ROUNDTRIP_ROOTS"])
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from fastapi.testclient import TestClient
from engine.launch import load_app
app, *_ = load_app()
from orgtree import census, census_contacts, ledger, reply_events, store, toolwait, transcript_records
census.reset()
census.set_enabled(True)
client = TestClient(app)
headers = {"X-Orgtree-Desktop-Token": "operator"}
slug = "report-roundtrip"
store.create_org(slug)
with store.write_org(slug) as org:
    org.hire(ledger.USER, None, "haiku", 0, "probe")
    store.save_org(org)
store._POOL.close_all(slug)
reply_events.lookup(slug, "probe", 0, "x", "s")


def sidecar_file(label, name):
    path = str(Path(store.DATA_ROOT) / name)
    with contextlib.closing(sqlite3.connect(path, timeout=10, factory=census_contacts.sidecar(label))) as conn, conn:
        conn.execute("SELECT 1").fetchone()


def attempt(route, body):
    token = census.bind()
    try:
        body()
    finally:
        census.observe("POST", route, 200, 1.0, 1.0, 0, 1)
        census.unbind(token)


def transcripts():
    with transcript_records.database() as conn:
        conn.execute("SELECT COUNT(*) FROM transcript_sources").fetchone()


statuses = [
    client.get("/api/orgs/" + slug, headers=headers).status_code,
    client.get("/api/orgs/" + slug, headers=headers).status_code,
    client.get("/api/orgs/report-roundtrip-missing", headers=headers).status_code,
    client.post("/api/agent", headers=headers, content=b"{not json").status_code,
    client.post("/api/agent", headers=headers, json={"org": slug, "node": "probe",
        "tool": "orgtree_watchdog", "args": {"action": "list"}}).status_code,
    client.get("/api/orgs/" + slug + "/nodes/probe/reply-events", headers=headers).status_code,
]
attempt("/synthetic/transcript-records", transcripts)
attempt("/synthetic/tool-waits", toolwait.records)
attempt("/synthetic/chat-window-index", lambda: sidecar_file("chat_window_index", "chat-window-index.sqlite3"))
attempt("/synthetic/file-deliveries", lambda: sidecar_file("file_deliveries", "file-deliveries.db"))
attempt("/synthetic/two-sidecars", lambda: (transcripts(), toolwait.records()))
snapshot = census.snapshot()
census.set_enabled(False)
store._POOL.close_all(slug)
with open(os.environ["CENSUS_ROUNDTRIP_OUT"], "w", encoding="utf-8") as stream:
    json.dump({"statuses": statuses, "snapshot": snapshot}, stream)
"""


class ProducerRoundTripTests(unittest.TestCase):
    """The verified consumer: what the in-tree producer actually emits is what
    this report accepts, and anything it does not know is refused."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="census-report-roundtrip-")
        base = Path(cls.tmp.name)
        (base / "data").mkdir()
        (base / "home").mkdir()
        out = base / "produced.json"
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("ORGTREE_", "PYTHON"))}
        env.update(ORGTREE_DATA=str(base / "data"), HOME=str(base / "home"),
                   USERPROFILE=str(base / "home"), ORGTREE_V2_TOKEN="operator",
                   CENSUS_ROUNDTRIP_OUT=str(out),
                   CENSUS_ROUNDTRIP_ROOTS=json.dumps([str(ROOT), str(ROOT / "engine" / "backend"),
                                                      str(ROOT / "tests")]))
        child = subprocess.run([sys.executable, "-I", "-B", "-c", PRODUCER], cwd=str(ROOT), env=env,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        if child.returncode:
            raise AssertionError("producer child failed:\n" + child.stderr[-4000:])
        produced = json.loads(out.read_text(encoding="utf-8"))
        cls.statuses = produced["statuses"]
        cls.snapshot = produced["snapshot"]
        cls.path = base / "snapshot.json"
        cls.path.write_text(json.dumps(cls.snapshot), encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_cli(self, path, *args):
        return subprocess.run([sys.executable, str(TOOL), str(path), *args], capture_output=True, text=True, timeout=15)

    def test_the_producer_snapshot_is_reported_with_exact_contact_sums(self):
        self.assertEqual(self.statuses, [200, 200, 404, 422, 200, 200])
        self.assertEqual(self.snapshot["schema_version"], 4)
        rows = self.snapshot["records"]
        self.assertEqual(len(rows), 11)
        # Exercised: some attempt really reached the store, some did not, and
        # every sidecar label was really contacted.
        self.assertTrue(any(r["db"]["statements"] > 0 for r in rows), rows)
        self.assertTrue(any(r["db"]["statements"] == 0 for r in rows), rows)
        self.assertEqual(sorted(recount_sidecars(rows)), sorted(LABELS))
        result = self.run_cli(self.path)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["report_schema"], "orgtree.operation-census-report/v2")
        contacts = report["contacts"]
        self.assertEqual(contacts["totals"], recount(rows))
        self.assertEqual(contacts["secondary_totals"], recount_sidecars(rows))
        self.assertEqual(contacts["with_contact_evidence"], sum("db" in r for r in rows))
        for group in contacts["by_operation"]:
            members = [r for r in rows if r["op"] == group["identity"]["op"]]
            self.assertEqual(group["statements"], sum(r["db"]["statements"] for r in members))
            self.assertEqual(group["secondary"], recount_sidecars(members))
        self.assertIs(contacts["complete"], False)
        self.assertEqual(report["snapshot"]["contact_coverage"], self.snapshot["contact_coverage"])
        self.assertIn("incomplete", report["coverage"]["assessment"])
        markdown = self.run_cli(self.path, "--format", "markdown")
        self.assertEqual(markdown.returncode, 0, markdown.stderr)

    def test_a_field_the_report_does_not_know_is_refused(self):
        """Producer drift fails closed: a new field or label anywhere is exit 2."""
        sidecar_row = next(i for i, r in enumerate(self.snapshot["records"]) if "secondary" in r["db"])
        for label, mutate in (
            ("record db field", lambda s: s["records"][0]["db"].update(rows_examined=0)),
            ("record field", lambda s: s["records"][0].update(db_secondary={})),
            ("top-level section", lambda s: s.update(contact_sidecars={})),
            ("process counter", lambda s: s["counters"].update(db_new=0)),
            ("coverage field", lambda s: s["contact_coverage"].update(sidecar_paths=[])),
            ("new sidecar label", lambda s: s["records"][sidecar_row]["db"]["secondary"].update(
                new_store=next(iter(s["records"][sidecar_row]["db"]["secondary"].values())))),
            ("sidecar field", lambda s: next(iter(s["records"][sidecar_row]["db"]["secondary"].values())).update(pages=0)),
            ("next schema", lambda s: s.update(schema_version=5)),
        ):
            with self.subTest(label), tempfile.TemporaryDirectory() as directory:
                source = copy.deepcopy(self.snapshot)
                mutate(source)
                path = Path(directory) / "drift.json"
                path.write_text(json.dumps(source), encoding="utf-8")
                result = self.run_cli(path)
                self.assertEqual(result.returncode, 2, label)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
