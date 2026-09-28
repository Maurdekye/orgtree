"""tools/pypg/cutover_verify.py: the independent check an outside agent (or
the user's own agent) runs after the first-launch conversion. These tests
cover its two comparisons without PostgreSQL: the file walk, and one org's
rows (the PostgreSQL side is built with the product's own work-item layout,
``orgtree.workrows``, which the verifier re-implements independently). The
database start/stop path is exercised by the rehearsal on a real copy.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import workrows

_SPEC = importlib.util.spec_from_file_location(
    "cutover_verify", Path(__file__).resolve().parents[1] / "tools" / "pypg" / "cutover_verify.py")
cv = importlib.util.module_from_spec(_SPEC)
sys.modules["cutover_verify"] = cv
_SPEC.loader.exec_module(cv)


def item(slug: str, title: str = "t") -> dict:
    return {"slug": slug, "title": title, "status": "open"}


def sqlite_side(items: list[dict] | None = None) -> dict:
    doc = [("name", '"Acme"'), ("version", "3")]
    if items is not None:
        doc.append(("work_items", json.dumps(items)))
    return {"doc": sorted(doc), "nodes": [("n1", 0, '{"name":"lead"}'), ("n2", 1, '{"name":"two"}')],
            "log_d": [(1, "mail_log", "n1", "2026-09-01T00:00:00Z", '{"text":"hi"}')],
            "log_l": [(1, "user_mail_log", None, '{"x":1}')], "meta": [("schema_version", "1")]}


def pg_side(src: dict, items: list[dict] | None) -> dict:
    doc = [r for r in src["doc"] if r[0] != "work_items"]
    if items is not None:
        doc += list(workrows.split(items).items())
    return {**src, "doc": sorted(doc)}


class FileWalk(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="orgtree-verify-test-"))
        self.backup, self.data = self.tmp / "backup", self.tmp / "data"
        for rel, text in {"orgs/acme.db": "db", "scratch/o/a/uploads/p.png": "img", "turnlog/o/a/t.jsonl": "t",
                          "app-settings.json": "{}"}.items():
            (self.backup / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.backup / rel).write_text(text)
        shutil.copytree(self.backup, self.data)
        # what the cutover does
        (self.data / "pre-postgres" / "orgs").mkdir(parents=True)
        (self.data / "orgs" / "acme.db").rename(self.data / "pre-postgres" / "orgs" / "acme.db")
        (self.data / "orgs" / "acme.pg").write_text("{}")
        for rel in ("store-backend.json", "orgtree-product-root.json", "pg/cluster/x", "conversion/current.json",
                    "conversion/20260928T1-1/import.json", "host-logs/20260928/x.json"):
            (self.data / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.data / rel).write_text("x")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_clean_cutover_has_no_problems(self) -> None:
        out = cv.compare_files(self.backup, self.data)
        self.assertEqual(out["problems"], [])
        self.assertEqual((out["org_files_moved"], out["markers"]), (["acme.db"], ["acme"]))
        self.assertEqual(out["compared_by_kind"]["attachments"], 1)
        self.assertEqual(out["compared_by_kind"]["transcripts"], 1)

    def test_a_changed_attachment_or_moved_org_file_fails_in_both_modes(self) -> None:
        (self.data / "scratch/o/a/uploads/p.png").write_text("IMG")
        (self.data / "pre-postgres/orgs/acme.db").write_text("DB")
        for after in (False, True):
            problems = cv.compare_files(self.backup, self.data, after)["problems"]
            self.assertEqual(len(problems), 2, (after, problems))

    def test_an_org_file_left_in_orgs_fails(self) -> None:
        (self.data / "orgs" / "acme.db").write_text("db")
        self.assertIn("still in orgs/", " ".join(cv.compare_files(self.backup, self.data)["problems"]))

    def test_other_changes_fail_exactly_and_are_listed_after_launch(self) -> None:
        (self.data / "app-settings.json").write_text('{"changed": true}')
        (self.data / "new-thing.json").write_text("{}")
        (self.data / "turnlog/o/a/t.jsonl").unlink()
        exact = cv.compare_files(self.backup, self.data)
        self.assertEqual(len(exact["problems"]), 3, exact["problems"])
        after = cv.compare_files(self.backup, self.data, True)
        self.assertEqual(after["problems"], [])
        self.assertEqual(after["changed_since_backup_count"], 3)

    def test_a_missing_attachment_fails_even_after_launch(self) -> None:
        (self.data / "scratch/o/a/uploads/p.png").unlink()
        self.assertEqual(len(cv.compare_files(self.backup, self.data, True)["problems"]), 1)


class OrgRows(unittest.TestCase):
    ITEMS = [item("b"), item("a"), item("c", "third")]

    def test_identical_rows_with_the_work_item_layout_pass(self) -> None:
        src = sqlite_side(self.ITEMS)
        out = cv.compare_org("acme", src, pg_side(src, self.ITEMS), 2)
        self.assertEqual(out["problems"], [])
        s, p = out["counts"]["sqlite"], out["counts"]["postgres"]
        self.assertEqual((s["agents"], s["open_work_items"], s["mail_log"]), (2, 3, 1))
        self.assertEqual(s, {**p, "rows": s["rows"]})
        self.assertEqual({t: d["sqlite"] == d["postgres"] for t, d in out["sha256"].items()},
                         dict.fromkeys(cv.TABLES, True))
        self.assertEqual(out["samples"]["sqlite"], out["samples"]["postgres"])
        # no work items on either side is fine too
        src = sqlite_side(None)
        self.assertEqual(cv.compare_org("acme", src, pg_side(src, None), 2)["problems"], [])

    def test_any_changed_row_fails(self) -> None:
        src = sqlite_side(self.ITEMS)
        cases = {
            "log value": lambda d: d.update(log_d=[(1, "mail_log", "n1", "2026-09-01T00:00:00Z", '{"text":"HI"}')]),
            "log seq": lambda d: d.update(log_l=[(2, "user_mail_log", None, '{"x":1}')]),
            "missing agent": lambda d: d.update(nodes=d["nodes"][:1]),
            "agent order": lambda d: d.update(nodes=[("n1", 5, '{"name":"lead"}'), d["nodes"][1]]),
            "meta": lambda d: d.update(meta=[]),
            "doc": lambda d: d.update(doc=[r for r in d["doc"] if r[0] != "name"]),
        }
        for label, change in cases.items():
            dst = pg_side(src, self.ITEMS)
            change(dst)
            self.assertTrue(cv.compare_org("acme", src, dst, 2)["problems"], label)

    def test_work_items_must_match_in_content_and_order(self) -> None:
        src = sqlite_side(self.ITEMS)
        for label, items in {"order": [self.ITEMS[1], self.ITEMS[0], self.ITEMS[2]],
                             "content": [self.ITEMS[0], self.ITEMS[1], item("c", "THIRD")],
                             "missing": self.ITEMS[:2]}.items():
            problems = cv.compare_org("acme", src, pg_side(src, items), 2)["problems"]
            self.assertTrue(any("work-item lists differ" in p for p in problems), (label, problems))
        self.assertTrue(cv.compare_org("acme", src, pg_side(src, None), 2)["problems"])

    def test_a_broken_postgres_layout_is_reported(self) -> None:
        src = sqlite_side(self.ITEMS)
        dst = pg_side(src, self.ITEMS)
        dst["doc"] = [r for r in dst["doc"] if r[0] != workrows.PREFIX + "a"]
        self.assertTrue(any("has no row" in p for p in cv.compare_org("acme", src, dst, 2)["problems"]))
        dst = pg_side(src, self.ITEMS)
        dst["doc"] = [(k, '{"format":"other","ids":[]}' if k == "work_items" else v) for k, v in dst["doc"]]
        self.assertTrue(any("layout" in p for p in cv.compare_org("acme", src, dst, 2)["problems"]))

    def test_after_launch_additions_pass_but_losses_fail(self) -> None:
        src = sqlite_side(self.ITEMS)
        dst = pg_side(src, self.ITEMS[:2])  # "c" was closed after the launch...
        dst["log_l"] = dst["log_l"] + [(2, "work_items_archive", None, json.dumps(item("c")))]  # ...and archived
        dst["log_d"] = dst["log_d"] + [(2, "mail_log", "n2", None, '{"text":"new"}')]
        dst["nodes"] = [("n1", 0, '{"name":"lead","state":"idle"}'), dst["nodes"][1], ("n3", 2, "{}")]
        out = cv.compare_org("acme", src, dst, 2, after_launch=True)
        self.assertEqual(out["problems"], [])
        self.assertTrue(out["changed_since_backup"])
        for label, change in {
                "a lost agent": lambda d: d.update(nodes=d["nodes"][1:]),
                "a changed history row": lambda d: d.update(log_d=[(1, "mail_log", "n1", None, "{}")] + d["log_d"][1:]),
                "a vanished work item": lambda d: d.update(log_l=d["log_l"][:1])}.items():
            broken = {k: list(v) for k, v in dst.items()}
            change(broken)
            self.assertTrue(cv.compare_org("acme", src, broken, 2, after_launch=True)["problems"], label)

    def test_after_launch_allows_only_the_restart_notice_trim(self) -> None:
        # Rehearsal 2 (a copy of live data): each start's restart notice keeps
        # an agent's newest 100 mail_log rows (archive_keep=100), so agents
        # already at 100 lost their oldest rows. That is listed, not failed.
        keep = 100
        self.assertEqual(cv.MAIL_ARCHIVE_KEEP, keep)
        src = sqlite_side(self.ITEMS)
        steer = (0, "steered_log", "n1", None, "{}")  # older than every mail row
        mail = [(seq, "mail_log", "n1", None, json.dumps({"n": seq})) for seq in range(1, keep + 1)]
        other = (keep + 2, "mail_log", "n2", None, "{}")
        src["log_d"] = [steer] + mail + [other]
        notices = [(1000 + i, "mail_log", "n1", None, '{"from":"orgtree"}') for i in range(2)]
        dst = pg_side(src, self.ITEMS)
        dst["log_d"] = [steer] + mail[2:] + [other] + notices  # n1: rows 1-2 trimmed, two notices, 100 left
        out = cv.compare_org("acme", src, dst, 2, after_launch=True)
        self.assertEqual(out["problems"], [])
        self.assertTrue(any("restart notice" in c and "2 oldest" in c for c in out["changed_since_backup"]),
                        out["changed_since_backup"])
        for label, rows in {
                "fewer than the kept number remain": [steer] + mail[2:] + [other] + notices[:1],
                "a row lost from the middle": [steer] + mail[:5] + mail[7:] + [other] + notices,
                "a trimmed-age row changed, not removed": [steer, (1, "steered_log", "n1", None, "{}")] + mail[2:]
                + [other] + notices,
                "a lost row that is not mail_log": mail[2:] + [other] + notices,
                "another agent's row under the kept number": [steer] + mail[2:] + notices,
        }.items():
            broken = {**dst, "log_d": rows}
            self.assertTrue(cv.compare_org("acme", src, broken, 2, after_launch=True)["problems"], label)
        # the exact mode never allows it
        self.assertTrue(cv.compare_org("acme", src, dst, 2)["problems"])

    def test_the_kept_number_matches_the_engines_restart_notice(self) -> None:
        # the verifier may not import the engine, so pin its constant to the source
        source = (Path(__file__).resolve().parents[1] / "engine" / "backend" / "orgtree" / "restart_wake.py") \
            .read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"archive_keep=(\d+)", source), [str(cv.MAIL_ARCHIVE_KEEP)])


class Independence(unittest.TestCase):
    def test_the_verifier_imports_neither_pgimport_nor_orgtree(self) -> None:
        source = Path(cv.__file__).read_text(encoding="utf-8")
        for name in ("pgimport", "orgtree", "engine"):
            self.assertNotRegex(source, rf"(?m)^\s*(import|from)\s+{name}\b", name)


if __name__ == "__main__":
    unittest.main()
