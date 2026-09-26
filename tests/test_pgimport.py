"""orgtree.pgimport (PYPG PG-2): extraction, recognition, manifests, the
resumable import and the cutover — against a SQLite stand-in for PG-0's
PostgreSQL tables (``FakeSink``), which keeps the one-transaction-per-org
contract the real sink must keep. No PostgreSQL and no live data: every root
is a temporary folder.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import importlib.util

from orgtree import store

_SPEC = importlib.util.spec_from_file_location(
    "pgimport", Path(__file__).resolve().parents[1] / "tools" / "pypg" / "pgimport.py")
pgimport = importlib.util.module_from_spec(_SPEC)
sys.modules["pgimport"] = pgimport
_SPEC.loader.exec_module(pgimport)
from orgtree.ledger import Org
ImportRefused = pgimport.ImportRefused


class FakeSink:
    """PG-0's layout stand-in: the seam's five tables with an ``org`` column,
    plus one receipt row per org, in one SQLite file. ``replace_org`` is one
    transaction. ``fail_after`` raises after that many inserted rows (inside
    the transaction), and ``corrupt`` alters one value on the way in."""

    def __init__(self, path: Path, *, fail_after: int | None = None, corrupt: bool = False, pause: Path | None = None,
                 reorder: bool = False, orgs_dir: Path | None = None) -> None:
        self.path, self.fail_after, self.corrupt, self.pause = path, fail_after, corrupt, pause
        self.reorder, self.orgs_dir = reorder, orgs_dir
        self.corrupted = 0  # proves the corruption control actually fired
        self.reordered = 0  # the same for the byte-level control
        self.finished: list[str] = []
        self.crashed_after: int | None = None
        conn = self._conn()
        for table, cols in pgimport.COLUMNS.items():
            conn.execute(f"CREATE TABLE IF NOT EXISTS pg_{table} (org TEXT NOT NULL, {', '.join(cols)})")
        conn.execute("CREATE TABLE IF NOT EXISTS pg_receipts (org TEXT PRIMARY KEY, receipt TEXT NOT NULL)")
        conn.close()

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, isolation_level=None, timeout=30)

    def recorded(self, slug):
        conn = self._conn()
        try:
            row = conn.execute("SELECT receipt FROM pg_receipts WHERE org=?", (slug,)).fetchone()
        finally:
            conn.close()
        return json.loads(row[0]) if row else None

    def replace_org(self, slug, rows, receipt):
        conn = self._conn()
        written = 0
        try:
            conn.execute("BEGIN IMMEDIATE")
            for table, cols in pgimport.COLUMNS.items():
                conn.execute(f"DELETE FROM pg_{table} WHERE org=?", (slug,))
                for row in rows[table]:
                    if self.fail_after is not None and written >= self.fail_after:
                        self.crashed_after = written  # proves the crash came mid-import
                        raise RuntimeError("injected crash inside the org's transaction")
                    if self.pause is not None and written == 1:
                        self.pause.write_text("paused")
                        import time
                        time.sleep(600)  # the test kills the process here
                    row = list(row)
                    if self.corrupt and table == "nodes" and not self.corrupted:
                        row[-1] = json.dumps({"corrupted": True})
                        self.corrupted += 1
                    if self.reorder and table == "nodes" and not self.reordered:
                        # the same value with its keys reversed: equal as JSON,
                        # different as bytes
                        parsed = json.loads(row[-1])
                        row[-1] = json.dumps(dict(reversed(list(parsed.items()))), separators=(",", ":"))
                        self.reordered += 1
                    conn.execute(f"INSERT INTO pg_{table} (org, {', '.join(cols)}) VALUES (?{', ?' * len(cols)})",
                                 (slug, *row))
                    written += 1
            conn.execute("INSERT OR REPLACE INTO pg_receipts VALUES (?, ?)", (slug, json.dumps(receipt)))
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def finish_org(self, slug):
        self.finished.append(slug)
        if self.orgs_dir is not None:
            (self.orgs_dir / f"{slug}{pgimport.MARKER_EXT}").write_text(json.dumps({"org_id": 1, "slug": slug}))

    def read_org(self, slug):
        conn = self._conn()
        try:
            return {t: [tuple(r) for r in conn.execute(f"SELECT {', '.join(c)} FROM pg_{t} WHERE org=?", (slug,))]
                    for t, c in pgimport.COLUMNS.items()}
        finally:
            conn.close()


def sample_doc(name: str = "Acme") -> dict:
    org = Org.create(name, [str(Path(tempfile.gettempdir()) / "ws")], "acceptEdits", workspace=str(Path(tempfile.gettempdir()) / "ws"))
    d = json.loads(json.dumps(dict(org.d)))
    d["nodes"] = {"n1": {"id": "n1", "name": "lead", "state": "live"},
                  "n2": {"id": "n2", "name": "old", "state": "archived", "parent": "n1"}}
    d["mail_log"] = {"n1": [{"at": "2026-09-25T10:00:00Z", "text": "hello"}], "n2": []}
    d["events"] = [{"at": "2026-09-25T10:00:01Z", "kind": "hire"}, {"at": None, "kind": "x", "n": 1.5}]
    d["notices"] = {"n1": [{"text": "fyi"}]}
    return d


def write_db(path: Path, doc: dict) -> None:
    conn = store._open_conn(str(path), create=True)
    try:
        conn.execute("BEGIN IMMEDIATE")
        store._write_doc(conn, doc, None)
        store._meta_set(conn, "schema_version", store._SCHEMA_VERSION)
        conn.execute("COMMIT")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()


def tree_digest(folder: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir()) if p.is_file()}


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="orgtree-pgimport-test-"))
        self.root = self.tmp / "root"
        (self.root / "orgs").mkdir(parents=True)
        self.sink_path = self.tmp / "sink.db"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def orgs(self) -> Path:
        return self.root / "orgs"

    def sink(self, **kw) -> FakeSink:
        return FakeSink(self.sink_path, **kw)


class Extraction(Base):
    def test_a_json_org_extracts_to_exactly_what_the_store_would_migrate(self) -> None:
        doc = sample_doc()
        jp = self.orgs() / "acme.json"
        jp.write_text(json.dumps(doc), encoding="utf-8")
        got = pgimport.extract_json("acme", jp)
        # The store's own migration of the same bytes, in another folder.
        other = self.tmp / "other.db"
        write_db(other, doc)
        conn = sqlite3.connect(other)
        ref, _, _ = pgimport._read_tables(conn)
        conn.close()
        for table in ("doc", "nodes", "log_d", "log_l"):
            self.assertEqual(got.rows[table], ref[table], table)
        self.assertEqual(pgimport.problems(got), [])
        self.assertEqual(got.source_fingerprint, hashlib.sha256(jp.read_bytes()).hexdigest())

    def test_extracting_a_database_leaves_every_file_untouched(self) -> None:
        write_db(self.orgs() / "acme.db", sample_doc())
        before = tree_digest(self.orgs())
        got = pgimport.extract_sqlite("acme", self.orgs() / "acme.db")
        self.assertEqual(tree_digest(self.orgs()), before)
        self.assertEqual(len(got.rows["nodes"]), 2)
        self.assertEqual({r[1] for r in got.rows["log_d"]}, {"mail_log"})

    def test_uncheckpointed_wal_rows_are_included(self) -> None:
        db = self.orgs() / "acme.db"
        write_db(db, sample_doc())
        writer = store._open_conn(str(db))
        try:
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("INSERT INTO log_l(sect, at, val) VALUES ('events', NULL, '{\"kind\":\"late\"}')")
            writer.execute("COMMIT")
            self.assertGreater((self.orgs() / "acme.db-wal").stat().st_size, 0, "the row must still be in the WAL")
            got = pgimport.extract_sqlite("acme", db)
        finally:
            writer.close()
        self.assertIn('{"kind":"late"}', [r[3] for r in got.rows["log_l"]])

    def test_every_org_create_key_is_recognised(self) -> None:
        org = Org.create("X", [str(self.tmp)], "acceptEdits", workspace=str(self.tmp))
        self.assertEqual(sorted(set(org.d) - pgimport.KNOWN_DOC_KEYS), [])


class Recognition(Base):
    def rows_for(self, doc: dict) -> pgimport.OrgRows:
        jp = self.orgs() / "acme.json"
        jp.write_text(json.dumps(doc), encoding="utf-8")
        return pgimport.extract_json("acme", jp)

    def test_an_unrecognised_section_is_a_problem(self) -> None:
        doc = sample_doc()
        doc["brand_new_section"] = {"x": 1}
        self.assertIn("unrecognised section 'brand_new_section'", pgimport.problems(self.rows_for(doc)))

    def test_split_owner_rows_need_their_container(self) -> None:
        # PG-3d stores mail/delivering/notices as a container row plus one
        # row per owner (store.SPLIT_SEP); those rows are recognised data
        org = self.rows_for(sample_doc())
        keys = [r[0] for r in org.rows["doc"]]
        owner_rows = [k for k in keys if store.split_section_of(k)]
        self.assertTrue(owner_rows, keys)
        self.assertEqual(pgimport.problems(org), [])
        sect = store.split_section_of(owner_rows[0])
        org.rows["doc"] = [r for r in org.rows["doc"] if r[0] != sect]
        self.assertIn(f"owner row {owner_rows[0]!r} has no {sect!r} container row", pgimport.problems(org))
        org = self.rows_for(sample_doc())
        org.rows["doc"].append(("name" + store.SPLIT_SEP + "n1", "[]"))
        self.assertIn(f"unrecognised section {'name' + store.SPLIT_SEP + 'n1'!r}", pgimport.problems(org))

    def test_a_legacy_lifecycle_document_row_is_recognised(self) -> None:
        # the 2.1.x engine keeps the lifecycle ledger as ONE doc row
        # (lifecycle.py: doc.setdefault("lifecycle", [])); v3's store loads it
        # and converts it to log rows on its next save
        db = self.orgs() / "acme.db"
        write_db(db, sample_doc())
        ledger = [{"at": "2026-09-25T10:00:02Z", "kind": "send", "node": "n1"}]
        conn = sqlite3.connect(db)
        conn.execute("DELETE FROM log_l WHERE sect='lifecycle'")
        conn.execute("INSERT INTO doc(key, val) VALUES ('lifecycle', ?)", (json.dumps(ledger),))
        conn.commit()
        self.assertEqual(store.reconstruct_full(conn)["lifecycle"], ledger)
        conn.close()
        self.assertEqual(pgimport.problems(pgimport.extract_sqlite("acme", db)), [])
        conn = sqlite3.connect(db)
        conn.execute("INSERT INTO log_l(sect, at, val) VALUES ('lifecycle', NULL, '{}')")
        conn.commit()
        conn.close()
        self.assertIn("section 'lifecycle' has both a document row and log rows",
                      pgimport.problems(pgimport.extract_sqlite("acme", db)))

    def test_only_logs_that_used_to_be_document_rows_may_be_one(self) -> None:
        org = self.rows_for(sample_doc())
        org.rows["doc"] = [r for r in org.rows["doc"] if r[0] != "events"] + [("events", "[]")]
        org.rows["log_l"] = [r for r in org.rows["log_l"] if r[1] != "events"]
        self.assertIn("section 'events' is a lazy log but is stored as a document row", pgimport.problems(org))

    def test_values_jsonb_cannot_hold_are_problems(self) -> None:
        org = self.rows_for(sample_doc())
        org.rows["doc"].append(("name", '{"a": NaN}'))
        org.rows["doc"].append(("slug", '"a\\u0000b"'))
        found = " | ".join(pgimport.problems(org))
        self.assertIn("not strict JSON", found)
        self.assertIn("NUL", found)

    def test_structural_surprises_are_problems(self) -> None:
        db = self.orgs() / "acme.db"
        write_db(db, sample_doc())
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE extra (x)")
        conn.execute("ALTER TABLE meta ADD COLUMN note TEXT")
        conn.execute("INSERT INTO log_l(sect, at, val) VALUES ('mystery', NULL, '1')")
        conn.execute("INSERT INTO log_d(sect, owner, at, val) VALUES ('mystery_d', 'n1', NULL, '1')")
        conn.execute("INSERT INTO doc(key, val) VALUES ('events', '[]')")
        conn.commit()
        conn.close()
        found = " | ".join(pgimport.problems(pgimport.extract_sqlite("acme", db)))
        for expected in ("unrecognised table 'extra'", "table 'meta' has unrecognised", "list-log section 'mystery'",
                         "dict-log section 'mystery_d'", "'events' is a lazy log but is stored as a document row"):
            self.assertIn(expected, found)

    def test_a_nul_in_plain_text_meta_is_a_problem(self) -> None:
        # PostgreSQL text refuses NUL too; plain meta values are not JSON, so
        # only the raw check can see it.
        org = self.rows_for(sample_doc())
        org.rows["meta"] = [(k, v) for k, v in org.rows["meta"] if k != "source_json_sha256"]
        org.rows["meta"].append(("source_json_sha256", "ab\x00cd"))
        self.assertIn("meta row 'source_json_sha256': value contains a NUL character, which PostgreSQL refuses",
                      pgimport.problems(org))

    def test_unknown_meta_keys_are_problems_but_owner_lists_are_not(self) -> None:
        org = self.rows_for(sample_doc())
        org.rows["meta"].append(("owners:mail_log", "[]"))
        self.assertEqual(pgimport.problems(org), [])
        org.rows["meta"].append(("owners:not_a_log", "[]"))
        org.rows["meta"].append(("surprise", "1"))
        found = pgimport.problems(org)
        self.assertIn("unrecognised meta key 'owners:not_a_log'", found)
        self.assertIn("unrecognised meta key 'surprise'", found)

    def test_the_orgs_folder_is_classified_and_surprises_refused(self) -> None:
        write_db(self.orgs() / "a.db", sample_doc())
        (self.orgs() / "b.json").write_text(json.dumps(sample_doc("B")))
        (self.orgs() / "a.json.premigration").write_text("{}")
        (self.orgs() / "c.db").write_bytes((self.orgs() / "a.db").read_bytes())
        (self.orgs() / "c.json").write_text("{}")
        (self.orgs() / "d.db.migrating").write_text("")
        (self.orgs() / "notes.txt").write_text("")
        layout = pgimport.classify_orgs_dir(self.root)
        self.assertEqual(sorted(layout["orgs"]), ["a", "b", "c"])
        self.assertEqual(layout["orgs"]["b"]["source"], "json")
        self.assertEqual(layout["ignored"], ["orgs/a.json.premigration"])
        refused = " | ".join(layout["refused"])
        self.assertIn("c.json: a .json beside c.db", refused)
        self.assertIn("d.db.migrating", refused)
        self.assertIn("notes.txt: unrecognised file", refused)

    def test_postgres_markers_beside_a_source_are_expected_and_alone_refused(self) -> None:
        write_db(self.orgs() / "a.db", sample_doc())
        (self.orgs() / "a.pg").write_text("{}")
        (self.orgs() / "b.json").write_text(json.dumps(sample_doc("B")))
        (self.orgs() / "b.pg").write_text("{}")
        (self.orgs() / "ghost.pg").write_text("{}")
        layout = pgimport.classify_orgs_dir(self.root)
        self.assertEqual(sorted(layout["orgs"]), ["a", "b"])
        self.assertEqual(layout["markers"], ["orgs/a.pg", "orgs/b.pg"])
        self.assertEqual(layout["refused"], ["orgs/ghost.pg: a PostgreSQL marker with no SQLite/JSON source beside it"])

    def test_the_marker_extension_is_pg0s(self) -> None:
        from orgtree import pgstore
        self.assertEqual(pgimport.MARKER_EXT, pgstore.MARKER_EXT)


class Manifests(Base):
    def test_key_order_inside_a_value_does_not_matter_but_everything_else_does(self) -> None:
        rows = {t: [] for t in pgimport.TABLES}
        rows["nodes"] = [("n1", 0, '{"a":1,"b":2}')]
        base = pgimport.manifest(rows)
        same = dict(rows, nodes=[("n1", 0, '{"b":2,"a":1}')])
        self.assertEqual(pgimport.manifest(same), base, "a jsonb store may reorder keys")
        for changed in ([("n1", 0, '{"a":1,"b":3}')], [("n1", 1, '{"a":1,"b":2}')],
                        [("n2", 0, '{"a":1,"b":2}')], [("n1", 0, '{"a":1,"b":2}'), ("n3", 2, "{}")],
                        [("n1", 0, '{"a":1.0,"b":2}')]):
            self.assertNotEqual(pgimport.manifest(dict(rows, nodes=changed)), base, changed)

    def test_the_order_rows_are_read_back_in_does_not_matter(self) -> None:
        # A PostgreSQL SELECT without ORDER BY may return rows in any order.
        rows = {t: [] for t in pgimport.TABLES}
        rows["log_l"] = [(1, "events", None, '{"k":1}'), (2, "events", None, '{"k":2}'), (3, "notice_log", None, "3")]
        rows["doc"] = [("a", "1"), ("b", "2")]
        shuffled = {t: list(reversed(v)) for t, v in rows.items()}
        self.assertEqual(pgimport.manifest(shuffled), pgimport.manifest(rows))

    def test_log_rows_are_checked_per_section(self) -> None:
        rows = {t: [] for t in pgimport.TABLES}
        rows["log_d"] = [(1, "mail_log", "n1", None, "1"), (2, "steered_log", "n1", None, "2")]
        m = pgimport.manifest(rows)
        self.assertEqual(m["sections"]["log_d:mail_log"]["count"], 1)
        moved = dict(rows, log_d=[(1, "mail_log", "n2", None, "1"), (2, "steered_log", "n1", None, "2")])
        mm = pgimport.manifest(moved)
        self.assertNotEqual(mm["sections"]["log_d:mail_log"], m["sections"]["log_d:mail_log"])
        self.assertEqual(mm["sections"]["log_d:steered_log"], m["sections"]["log_d:steered_log"])


class Importing(Base):
    def populate(self) -> None:
        write_db(self.orgs() / "acme.db", sample_doc())
        (self.orgs() / "beta.json").write_text(json.dumps(sample_doc("Beta")), encoding="utf-8")

    def test_dry_run_reports_counts_and_writes_nothing(self) -> None:
        self.populate()
        before = tree_digest(self.orgs())
        report = pgimport.dry_run(self.root)
        self.assertTrue(report["importable"], report["refused"])
        self.assertEqual(report["orgs"]["acme"]["manifest"]["tables"]["nodes"]["count"], 2)
        self.assertEqual(report["orgs"]["beta"]["source"], "json")
        self.assertEqual(tree_digest(self.orgs()), before)
        self.assertFalse(self.sink_path.exists())

    def test_import_reads_back_identically_and_a_rerun_skips(self) -> None:
        self.populate()
        before = tree_digest(self.orgs())
        first = pgimport.import_root(self.root, self.sink())
        self.assertEqual({v["action"] for v in first["orgs"].values()}, {"imported"})
        again = pgimport.import_root(self.root, self.sink())
        self.assertEqual({v["action"] for v in again["orgs"].values()}, {"already_imported"})
        self.assertEqual({s: v["manifest_sha256"] for s, v in first["orgs"].items()},
                         {s: v["manifest_sha256"] for s, v in again["orgs"].items()})
        self.assertEqual(tree_digest(self.orgs()), before, "the old files are the rollback: untouched")

    def test_an_unrecognised_org_refuses_before_anything_is_written(self) -> None:
        self.populate()
        doc = sample_doc("Gamma")
        doc["brand_new_section"] = 1
        (self.orgs() / "gamma.json").write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaisesRegex(ImportRefused, "gamma: unrecognised section 'brand_new_section'"):
            pgimport.import_root(self.root, self.sink())
        self.assertIsNone(self.sink().recorded("acme"), "nothing may be imported when any org is refused")

    def test_rt10_a_crash_inside_an_org_leaves_nothing_and_a_rerun_is_identical(self) -> None:
        self.populate()
        crashing = self.sink(fail_after=3)
        with self.assertRaisesRegex(RuntimeError, "injected crash"):
            pgimport.import_root(self.root, crashing)
        self.assertEqual(crashing.crashed_after, 3, "three rows were inside the transaction when it crashed")
        self.assertIsNone(self.sink().recorded("acme"))
        self.assertEqual(self.sink().read_org("acme")["nodes"], [], "the half-written org rolled back")
        done = pgimport.import_root(self.root, self.sink())
        clean = FakeSink(self.tmp / "clean.db")
        reference = pgimport.import_root(self.root, clean)
        self.assertEqual(done["orgs"], reference["orgs"])
        for slug in ("acme", "beta"):
            self.assertEqual(pgimport.manifest(self.sink().read_org(slug)), pgimport.manifest(clean.read_org(slug)))

    def test_rt10_a_killed_import_process_is_resumed(self) -> None:
        self.populate()
        pause = self.tmp / "paused.flag"
        child = textwrap.dedent(f'''
            import sys
            sys.path[:0] = {[p for p in sys.path if p]!r}
            from pathlib import Path
            import test_pgimport as t
            pgimport = t.pgimport
            pgimport.import_root(Path({str(self.root)!r}), t.FakeSink(Path({str(self.sink_path)!r}), pause=Path({str(pause)!r})), only=["acme"])
        ''')
        proc = subprocess.Popen([sys.executable, "-c", child], cwd=str(Path(__file__).parent),
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(600):
                if pause.exists() or proc.poll() is not None:
                    break
                import time
                time.sleep(0.05)
            self.assertTrue(pause.exists(), proc.stderr.read().decode(errors="replace") if proc.poll() is not None else "")
            proc.kill()
        finally:
            proc.wait(timeout=30)
            proc.stderr.close()
        self.assertIsNone(self.sink().recorded("acme"), "a killed transaction must leave no receipt")
        self.assertEqual(self.sink().read_org("acme")["nodes"], [])
        result = pgimport.import_root(self.root, self.sink())
        self.assertEqual(result["orgs"]["acme"]["action"], "imported")
        self.assertEqual(pgimport.manifest(self.sink().read_org("acme")),
                         pgimport.dry_run(self.root)["orgs"]["acme"]["manifest"])

    def test_a_sink_that_alters_a_row_is_caught_on_read_back(self) -> None:
        self.populate()
        sink = self.sink(corrupt=True)
        with self.assertRaisesRegex(ImportRefused, "acme: read-back does not match the source in \\['nodes'\\]"):
            pgimport.import_root(self.root, sink)
        self.assertEqual(sink.corrupted, 1, "the control must actually have altered a row")

    def test_a_sink_that_reorders_keys_is_caught_byte_for_byte(self) -> None:
        # PG-0 keeps `val` as text, so a faithful import is byte-identical;
        # the manifest alone (canonical JSON) would not see this
        self.populate()
        sink = self.sink(reorder=True)
        with self.assertRaisesRegex(ImportRefused, "acme: read-back is not byte-identical to the source in \\['nodes'\\]"):
            pgimport.import_root(self.root, sink)
        self.assertEqual(sink.reordered, 1, "the control must actually have reordered a value")

    def test_every_org_is_finished_whether_imported_or_skipped(self) -> None:
        self.populate()
        first = self.sink()
        pgimport.import_root(self.root, first)
        self.assertEqual(sorted(first.finished), ["acme", "beta"])
        again = self.sink()
        pgimport.import_root(self.root, again)
        self.assertEqual(sorted(again.finished), ["acme", "beta"], "a skipped org still gets its marker")

    def test_a_running_engine_refuses_the_import(self) -> None:
        fd = os.open(store.owner_file(str(self.root)), os.O_RDWR | os.O_CREAT, 0o644)
        try:
            self.assertTrue(store._try_lock(fd))
            with self.assertRaisesRegex(ImportRefused, "stop the engine first"):
                with pgimport.engine_stopped(self.root):
                    self.fail("the body must not run while the root is owned")
        finally:
            os.close(fd)
        with pgimport.engine_stopped(self.root):
            pass  # free again once the holder is gone

    def test_a_changed_source_is_imported_again(self) -> None:
        self.populate()
        pgimport.import_root(self.root, self.sink())
        doc = sample_doc("Beta")
        doc["events"].append({"kind": "later"})
        (self.orgs() / "beta.json").write_text(json.dumps(doc), encoding="utf-8")
        again = pgimport.import_root(self.root, self.sink())
        self.assertEqual(again["orgs"]["beta"]["action"], "imported")
        self.assertEqual(again["orgs"]["acme"]["action"], "already_imported")

    def test_a_damaged_target_is_replaced_even_with_a_matching_receipt(self) -> None:
        self.populate()
        pgimport.import_root(self.root, self.sink())
        conn = sqlite3.connect(self.sink_path)
        conn.execute("DELETE FROM pg_log_l WHERE org='acme'")
        conn.commit()
        conn.close()
        again = pgimport.import_root(self.root, self.sink())
        self.assertEqual(again["orgs"]["acme"]["action"], "imported")


class CommandLine(Base):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        tool = Path(__file__).resolve().parents[1] / "tools" / "pypg" / "pgimport.py"
        return subprocess.run([sys.executable, str(tool), *args], capture_output=True, text=True, timeout=120)

    def test_dry_run_exit_codes_and_report(self) -> None:
        write_db(self.orgs() / "acme.db", sample_doc())
        before = tree_digest(self.orgs())
        out = self.tmp / "report.json"
        ok = self.run_cli("dry-run", "--root", str(self.root), "--out", str(out))
        self.assertEqual(ok.returncode, 0, ok.stderr)
        report = json.loads(out.read_text(encoding="utf-8"))
        self.assertTrue(report["importable"])
        repo = Path(__file__).resolve().parents[1]
        self.assertTrue(Path(report["provenance"]["store"]).is_relative_to(repo), report["provenance"])
        (self.orgs() / "notes.txt").write_text("")
        refused = self.run_cli("dry-run", "--root", str(self.root))
        self.assertEqual(refused.returncode, 3, refused.stderr)
        self.assertIn("notes.txt: unrecognised file", json.loads(refused.stdout)["refused"][0])
        (self.orgs() / "notes.txt").unlink()
        self.assertEqual(tree_digest(self.orgs()), before)
        self.assertEqual(self.run_cli("dry-run", "--root", str(self.tmp / "nowhere")).returncode, 2)


class Cutover(Base):
    def sink(self, **kw) -> FakeSink:
        return FakeSink(self.sink_path, orgs_dir=self.orgs(), **kw)

    def ready(self) -> tuple[dict, dict, dict]:
        write_db(self.orgs() / "acme.db", sample_doc())
        (self.orgs() / "beta.json").write_text(json.dumps(sample_doc("Beta")), encoding="utf-8")
        (self.root / pgimport.PROTOTYPE_MARKER).write_text("{}")
        before = tree_digest(self.orgs())
        dry = pgimport.dry_run(self.root)
        return before, dry, pgimport.import_root(self.root, self.sink())

    def test_cutover_needs_a_clean_complete_matching_import(self) -> None:
        write_db(self.orgs() / "acme.db", sample_doc())
        (self.orgs() / "beta.json").write_text(json.dumps(sample_doc("Beta")), encoding="utf-8")
        (self.root / pgimport.PROTOTYPE_MARKER).write_text("{}")
        before = tree_digest(self.orgs())
        dry = pgimport.dry_run(self.root)
        partial = pgimport.import_root(self.root, self.sink(), only=["acme"])
        with self.assertRaisesRegex(ImportRefused, "orgs not imported: \\['beta'\\]"):
            pgimport.write_cutover(self.root, dry, partial)
        full = pgimport.import_root(self.root, self.sink())
        bad = json.loads(json.dumps(full))
        bad["orgs"]["acme"]["manifest_sha256"] = "0" * 64
        with self.assertRaisesRegex(ImportRefused, "differ from the dry run"):
            pgimport.write_cutover(self.root, dry, bad)
        with self.assertRaisesRegex(ImportRefused, "not clean"):
            pgimport.write_cutover(self.root, dict(dry, refused=["x"]), full)
        self.assertFalse((self.root / pgimport.CUTOVER_FILE).exists())
        record = pgimport.write_cutover(self.root, dry, full)
        on_disk = json.loads((self.root / pgimport.CUTOVER_FILE).read_text(encoding="utf-8"))
        self.assertEqual(on_disk, {k: v for k, v in record.items() if k != "moved"})
        self.assertEqual(on_disk["schema"], "orgtree.store-backend/v1")
        self.assertEqual(on_disk["backend"], "postgres")
        self.assertEqual(sorted(on_disk["orgs"]), ["acme", "beta"])
        # the old files moved aside byte for byte; only PG-0's markers remain
        self.assertEqual(tree_digest(self.root / pgimport.ROLLBACK_DIR), {k: v for k, v in before.items()})
        self.assertEqual(sorted(p.name for p in self.orgs().iterdir()), ["acme.pg", "beta.pg"])
        self.assertEqual(sorted(record["moved"]), sorted(before))
        # what PG-0's postgres start-up checks for: no stray SQLite/JSON org
        self.assertEqual(store.active_databases(str(self.root)), [])
        self.assertEqual(store.pending_migrations(str(self.root)), [])

    def test_a_cut_over_root_is_not_imported_again(self) -> None:
        _, dry, full = self.ready()
        pgimport.write_cutover(self.root, dry, full)
        with self.assertRaisesRegex(ImportRefused, "already cut over"):
            pgimport.dry_run(self.root)
        with self.assertRaisesRegex(ImportRefused, "already cut over"):
            pgimport.import_root(self.root, self.sink())

    def test_an_interrupted_move_is_finished_and_never_overwrites(self) -> None:
        before, dry, full = self.ready()
        pgimport.write_cutover(self.root, dry, full)
        # as if the moves had stopped after the record: one file back in orgs/
        os.rename(self.root / pgimport.ROLLBACK_DIR / "beta.json", self.orgs() / "beta.json")
        self.assertEqual(pgimport.complete_cutover(self.root), ["beta.json"])
        self.assertEqual(tree_digest(self.root / pgimport.ROLLBACK_DIR), before)
        self.assertEqual(pgimport.complete_cutover(self.root), [], "idempotent")
        # a file whose rollback copy already exists is refused, not overwritten
        (self.orgs() / "beta.json").write_text("different")
        with self.assertRaisesRegex(ImportRefused, "refusing to overwrite a rollback copy"):
            pgimport.complete_cutover(self.root)
        self.assertEqual(tree_digest(self.root / pgimport.ROLLBACK_DIR), before)

    def test_nothing_moves_without_the_record(self) -> None:
        self.ready()
        with self.assertRaisesRegex(ImportRefused, "no cutover record"):
            pgimport.complete_cutover(self.root)
        self.assertTrue((self.orgs() / "acme.db").exists())

    def test_cutover_needs_markers_and_a_servable_root(self) -> None:
        _, dry, full = self.ready()
        (self.orgs() / "beta.pg").unlink()
        with self.assertRaisesRegex(ImportRefused, "no PostgreSQL marker for \\['beta'\\]"):
            pgimport.write_cutover(self.root, dry, full)
        pgimport.import_root(self.root, self.sink())  # a rerun writes the marker again
        (self.root / pgimport.PROTOTYPE_MARKER).unlink()
        with self.assertRaisesRegex(ImportRefused, "neither a prototype marker nor the product binding"):
            pgimport.write_cutover(self.root, dry, full)
        self.assertFalse((self.root / pgimport.CUTOVER_FILE).exists())
        (self.root / pgimport.PRODUCT_BINDING).write_text("{}")
        pgimport.write_cutover(self.root, dry, full)
        self.assertTrue((self.root / pgimport.CUTOVER_FILE).exists())

    def test_the_cutover_record_is_what_the_engine_bracket_reads(self) -> None:
        _, dry, full = self.ready()
        pgimport.write_cutover(self.root, dry, full)
        repo = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location("_pg_process_for_test", repo / "engine" / "pg_process.py")
        if spec is None or not (repo / "engine" / "pg_process.py").exists():
            self.skipTest("engine/pg_process.py (PG-1) is not on this branch")
        pp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pp)
        self.assertEqual(pp.chosen_backend(self.root, {}), "postgres")
        self.assertEqual(pp.CUTOVER_FILE, pgimport.CUTOVER_FILE)
        self.assertEqual(pp.CUTOVER_SCHEMA, pgimport.CUTOVER_SCHEMA)
        self.assertEqual(pp.PRODUCT_FILE, pgimport.PRODUCT_BINDING)


if __name__ == "__main__":
    unittest.main()
