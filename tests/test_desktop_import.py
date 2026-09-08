"""Real filesystem/SQLite copy-import tests; never use or clean live data.

Every fixture lives below an explicit throwaway root, established BEFORE any
storage import. Fixtures are deliberately left behind (Windows junction rule).
"""
from __future__ import annotations

from contextlib import closing
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

# No store/provider import may precede this binding.
_TEST_ROOT = Path(tempfile.mkdtemp(prefix="orgtree-v2-import-tests-")).resolve()
os.environ["ORGTREE_DATA"] = str(_TEST_ROOT)
os.environ["ORGTREE_STORE"] = "sqlite"
os.environ["HOME"] = str(_TEST_ROOT)
os.environ["USERPROFILE"] = str(_TEST_ROOT)

from engine.backend.orgtree import desktop_import as imp, store
from engine.backend.orgtree.ledger import Org
from fastapi import FastAPI
from fastapi.testclient import TestClient
from engine.launch import TokenGate


def fingerprint(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file()}


def job_result(client, body, headers):
    body = dict(body, request_id=str(uuid.uuid4()))
    response = client.post("/api/desktop/import-v1/jobs", json=body, headers=headers)
    assert response.status_code == 202, response.text
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        response = client.get("/api/desktop/import-v1/jobs/" + body["request_id"], headers=headers)
        assert response.status_code == 200, response.text
        job = response.json()["job"]
        if job["state"] not in {"queued", "running"}:
            assert job["state"] == "succeeded", job
            return job["result"]
        time.sleep(.01)
    raise AssertionError("bounded import job fixture did not finish")


class DesktopImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(dir=_TEST_ROOT))
        self.source = self.root / "v1"
        self.dest = self.root / "v2"
        (self.source / "orgs").mkdir(parents=True)
        self.dest.mkdir()
        self.env = patch.dict(os.environ, {"ORGTREE_DATA": str(self.dest), "ORGTREE_STORE": "sqlite"})
        self.env.start()
        self.bound = patch.object(store, "DATA_ROOT", str(self.dest))
        self.bound.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.bound.stop)
        self.resumed = []

    def fixture(self, slug: str = "acme", *, sqlite: bool = True) -> dict:
        scratch = self.source / "scratch" / slug / "worker"
        workspace = self.source / "workspaces" / slug
        scratch.mkdir(parents=True)
        workspace.mkdir(parents=True)
        (scratch / "outbox").mkdir()
        (scratch / "outbox" / "page.html").write_bytes(b"<img src='image.svg'>")
        (scratch / "outbox" / "image.svg").write_bytes(b"<svg>copy me</svg>")
        (scratch / "breadcrumbs.md").write_text("Finished the first step.\n", encoding="utf-8")
        (workspace / "notes.md").write_text("shared organization notes", encoding="utf-8")
        journal = self.source / "journals" / "projects" / slug
        journal.mkdir(parents=True)
        (journal / "source-session.jsonl").write_text(
            '{"type":"user","message":{"role":"user","content":"do work"}}\n'
            '{"type":"assistant","message":{"role":"assistant","content":"step done"}}\n',
            encoding="utf-8")
        (journal / "source-session.views.ndjson").write_text('{"visible":"do work"}\n', encoding="utf-8")
        doc = Org.create(slug, workspace=str(workspace)).d
        node = {"session_id": "source-session", "model": "luna", "state": "live",
                "parent": None, "grant": 0, "title": "worker", "charter": "Work carefully",
                "created": "2026-01-01", "archived_at": None, "pid": 987654,
                "scope": {"add_dirs": [{"path": str(scratch), "mode": "rw"}],
                          "tools": {"bash": True, "edit": True, "web": False,
                                    "subagents": False, "mcp": []},
                          "org_visibility": "self", "permission_mode": "acceptEdits"},
                "generation": 0, "lineage": "worker", "predecessor": None,
                "successor": None, "bearer_state": None,
                "inflight": {"text": "finish work", "at": "2026-01-01"},
                "remote_controlled": {"pid": 987654}, "codex_thread": "source-session",
                "antigravity_conversation": "source-session", "cost_usd": 2.5}
        doc["nodes"] = {"worker": node, "idle": {**copy.deepcopy(node), "inflight": None},
                        "worker@0": {**copy.deepcopy(node), "state": "archived", "inflight": None}}
        doc["documents"] = [{"id": "doc-1", "node": "worker", "title": "Report", "body": "# kept"},
                            {"id": "doc-2", "node": "worker", "file": str(scratch / "outbox" / "page.html")}]
        doc["events"] = [{"id": "same-time-a", "at": "2026-01-01", "text": "one"},
                         {"id": "same-time-b", "at": "2026-01-01", "text": "two"}]
        doc["mail_log"] = {"worker": [{"id": "m1", "text": "kept"}], "idle": []}
        doc["op_receipts"] = [{"id": "uncertain", "outcome": "unknown"}]
        doc["work_items"] = [{"slug": "finish-job", "history": [{"text": "still active"}]}]
        doc["watchdogs"] = [{"id": "d1", "owner": "worker", "state": "armed", "kind": "file",
                            "target": str(scratch / "breadcrumbs.md")}]
        doc["auto_resume"] = True
        if sqlite:
            imp._write_candidate(self.source / "orgs" / f"{slug}.db", doc)
        else:
            (self.source / "orgs" / f"{slug}.json").write_text(json.dumps(doc), encoding="utf-8")
        return doc

    def run_import(self, slugs: list[str] | None = None, callback=None) -> dict:
        return imp.copy_import(str(self.source), slugs or ["acme"],
                               acknowledge_duplicate_work=True,
                               on_imported=callback or self.resumed.append)

    def _check_generated_lineage_ids(self, use_sqlite: bool) -> None:
        doc = self.fixture(sqlite=False)
        from engine.backend.orgtree.ledger import slugify
        long_id = slugify('long generated role ' * 8) + '@12@0'
        self.assertGreater(len(long_id),128)  # V1 slugify has no length cap.
        ids = ['inline-images@0@0','worker@12@3@0',long_id]
        for nid in ids:
            doc['nodes'][nid] = {**copy.deepcopy(doc['nodes']['worker@0']),
                                 'parent':'worker','predecessor':'worker@0','successor':None}
        doc['nodes']['worker@0']['successor']=ids[0]
        doc['mail_log'][ids[0]]=[{'id':'nested-mail','text':'retained lineage mail'}]
        doc['documents'].append({'id':'nested-doc','node':ids[0],'title':'Archived','body':'retained'})
        source_doc=self.source/'orgs/acme.json'
        source_doc.write_text(json.dumps(doc),encoding='utf-8')
        if use_sqlite:
            imp._write_candidate(self.source/'orgs/acme.db',doc)
            source_doc.unlink()  # Synthetic fixture only; select one source format.
        before=fingerprint(self.source)
        with patch.object(subprocess,'Popen',side_effect=AssertionError('No provider process')):
            preview=imp.preview_import(str(self.source))
            self.assertEqual(len(preview['organizations']),1)
            self.assertEqual(preview['organizations'][0]['slug'],'acme')
            self.assertEqual(preview['organizations'][0]['nodes'],len(doc['nodes']))
            self.assertIsNone(preview['organizations'][0]['conflict'])
            self.run_import()
        copied=self.read()
        self.assertEqual(set(copied['nodes']),set(doc['nodes']))
        for nid in ids:
            self.assertEqual(copied['nodes'][nid]['parent'],'worker')
            self.assertEqual(copied['nodes'][nid]['predecessor'],'worker@0')
        self.assertEqual(copied['nodes']['worker@0']['successor'],ids[0])
        self.assertEqual(copied['mail_log'][ids[0]],doc['mail_log'][ids[0]])
        self.assertEqual(copied['documents'][-1]['node'],ids[0])
        self.assertEqual(fingerprint(self.source),before)

    def test_sqlite_generated_lineage_ids_preview_and_copy(self):
        self._check_generated_lineage_ids(True)

    def test_json_generated_lineage_ids_preview_and_copy(self):
        self._check_generated_lineage_ids(False)

    def test_malformed_lineage_ids_remain_refused(self):
        doc=self.fixture(sqlite=False)
        for nid in ('worker@','worker@@0','worker@-1','worker@x','worker@0@',
                    '../worker','worker/child','worker\\child','C:worker',
                    'worker@0/../escape','worker\x00','worker@0\n',42):
            with self.subTest(nid=nid):
                malformed=copy.deepcopy(doc)
                malformed['nodes'][nid]=copy.deepcopy(doc['nodes']['worker'])
                with self.assertRaises(imp.ImportRefused):
                    imp._validate_document(malformed,'acme')

    def read(self, slug: str = "acme") -> dict:
        with closing(sqlite3.connect(self.dest / "orgs" / f"{slug}.db")) as conn:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            return store.reconstruct_full(conn)

    def native_fixture(self) -> tuple[dict, Path, dict]:
        doc = self.fixture(sqlite=False)
        sid = str(uuid.uuid4())
        node = doc["nodes"]["worker"]
        node.update(model="haiku", session_id=sid)
        node.pop("codex_thread", None)
        node.pop("antigravity_conversation", None)
        (self.source / "orgs/acme.json").write_text(json.dumps(doc), encoding="utf-8")
        profile = self.source / "configured-claude-profile"
        path = profile / "projects/source-project" / f"{sid}.jsonl"
        path.parent.mkdir(parents=True)
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        records = [
            {"type":"user", "uuid":first, "parentUuid":None, "sessionId":sid,
             "timestamp":"2026-09-07T20:00:00Z",
             "cwd":str(self.source / "scratch/acme/worker"), "message":{"role":"user", "content":"Remember the violet key"}},
            {"type":"assistant", "uuid":second, "parentUuid":first, "sessionId":sid,
             "timestamp":"2026-09-07T20:00:01Z",
             "message":{"role":"assistant", "content":[{"type":"text", "text":"I remember violet"}]}},
        ]
        path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        return doc, path, {"claude_profile":str(profile)}

    def test_native_claude_clone_preserves_context_and_rebinds_only_runtime_identity(self) -> None:
        from engine.backend.orgtree import desktop_native as native
        original, source_path, sources = self.native_fixture()
        before = fingerprint(self.source)
        preview = imp.preview_import(str(self.source), sources)
        row = next(r for r in preview["organizations"][0]["native_context"] if r["node"] == "worker")
        self.assertEqual(row["status"], "available")
        self.assertEqual(Path(row["source_path"]), source_path)
        imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                        on_imported=self.resumed.append, native_sources=sources)
        doc = self.read()
        node = doc["nodes"]["worker"]
        self.assertNotIn("session_unrun", node)
        self.assertNotIn("cheap_compacted", node)
        self.assertIsNone(native.native_hold_reason(doc, "worker"))
        target = Path(native.native_session_path(doc, "worker"))
        self.assertTrue(target.is_relative_to(self.dest))
        rows = [json.loads(v) for v in target.read_text().splitlines()]
        old = [json.loads(v) for v in source_path.read_text().splitlines()]
        self.assertEqual([r["message"] for r in rows], [r["message"] for r in old])
        self.assertEqual([(r["uuid"],r["parentUuid"]) for r in rows], [(r["uuid"],r["parentUuid"]) for r in old])
        self.assertEqual({r["sessionId"] for r in rows}, {node["session_id"]})
        self.assertNotEqual(node["session_id"], original["nodes"]["worker"]["session_id"])
        self.assertEqual(rows[0]["cwd"], str(self.dest / "scratch/acme/worker"))
        self.assertEqual((target.parent / "source.jsonl").read_bytes(), source_path.read_bytes())
        target.write_text(target.read_text() + '{"type":"new-destination-record"}\n')
        self.assertEqual(fingerprint(self.source), before)
        self.assertIsNotNone(native.native_hold_reason(doc, "idle"), "unsupported native context stays held")
        node["session_id"] = str(uuid.uuid4())
        self.assertIsNotNone(native.native_hold_reason(doc, "worker"), "stale binding is refused")

    def test_native_locator_conflicts_and_wrong_format_are_not_native_success(self) -> None:
        from engine.backend.orgtree import desktop_native as native
        doc, path, sources = self.native_fixture()
        with self.assertRaises(imp.ImportRefused):
            imp.preview_import(str(self.source), {"claude_profile":str(self.dest)})
        with self.assertRaises(imp.ImportRefused):
            imp.preview_import(str(self.source), {"sessions":{"acme/worker":"relative.jsonl"}})
        with self.assertRaises(imp.ImportRefused):
            imp.preview_import(str(self.source), {"credentials":"never allowed"})
        path.write_text('{"type":"assistant","message":{"role":"assistant","content":"display journal"}}\n')
        status = native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)
        self.assertEqual(status["status"], "held")
        path.write_text('{"partial":')
        self.assertIn("incomplete", native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)["reason"])

    def test_native_parent_integrity_source_mutation_and_exclusive_clone(self) -> None:
        from engine.backend.orgtree import desktop_native as native
        doc, path, sources = self.native_fixture()
        rows = [json.loads(v) for v in path.read_text().splitlines()]
        rows[1]["parentUuid"] = str(uuid.uuid4())
        with self.assertRaisesRegex(native.NativeHeld, "parent"):
            native.claude_records(rows, doc["nodes"]["worker"]["session_id"], str(uuid.uuid4()), str(self.dest))
        with patch.object(imp, "_digest", side_effect=["before","after"]):
            with self.assertRaisesRegex(native.NativeHeld, "changed"):
                native._read_native(path)
        stage = self.dest / "private-native-stage"
        stage.mkdir()
        fixed = uuid.UUID("11111111-1111-1111-1111-111111111111")
        with patch.object(native.uuid, "uuid4", return_value=fixed):
            first = native.prepare(self.source, self.dest, "acme", "worker", doc["nodes"]["worker"], sources, stage)
            second = native.prepare(self.source, self.dest, "acme", "worker", doc["nodes"]["worker"], sources, stage)
        self.assertEqual(first["status"], "ready")
        self.assertEqual(second["status"], "held", "existing clone is never overwritten")

    def test_native_inline_tool_cycle_is_preserved_and_external_dependencies_hold(self) -> None:
        from engine.backend.orgtree import desktop_native as native
        doc, path, sources = self.native_fixture()
        rows = [json.loads(v) for v in path.read_text().splitlines()]
        rows[1]["message"]["content"].append({"type":"tool_use", "id":"tool-1", "name":"Read", "input":{"file_path":"notes.md"}})
        rows.append({"type":"user", "uuid":str(uuid.uuid4()), "parentUuid":rows[1]["uuid"],
                     "timestamp":"2026-09-07T20:00:02Z", "sessionId":doc["nodes"]["worker"]["session_id"],
                     "message":{"role":"user", "content":[{"type":"tool_result", "tool_use_id":"tool-1", "content":"The recorded tool answer is violet."}]}})
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        self.assertEqual(native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)["status"], "available")
        clone = native.claude_records(rows, doc["nodes"]["worker"]["session_id"], str(uuid.uuid4()), str(self.dest))
        self.assertEqual(clone[-1]["message"], rows[-1]["message"])
        rows[-1]["toolUseResult"] = {"persistedOutputPath":"C:/source/tool-results/answer.txt"}
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        self.assertEqual(native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)["status"], "held")
        rows[-1].pop("toolUseResult")
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        sidecar = path.parent / path.stem / "subagents"
        sidecar.mkdir(parents=True)
        (sidecar / "agent-example.jsonl").write_text('{"kept":"source only"}\n')
        self.assertIn("sidecars", native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)["reason"])

    def test_real_ledger_successor_and_rename_preserve_predecessor_binding(self) -> None:
        from engine.backend.orgtree import desktop_native as native
        from engine.backend.orgtree.ledger import USER
        _, _, sources = self.native_fixture()
        imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                        on_imported=self.resumed.append, native_sources=sources)
        base = self.read()
        base["nodes"].pop("worker@0")
        base["nodes"]["worker"].pop("inflight", None)
        for operation in ("cheap", "switch", "compact", "rename"):
            with self.subTest(operation=operation):
                org = Org(copy.deepcopy(base))
                original = copy.deepcopy(org.nodes["worker"]["desktop_import"])
                if operation == "rename":
                    org.rename(USER, "worker", "renamed")
                    self.assertIsNone(native.native_hold_reason(org, "renamed"))
                    self.assertTrue(native.native_session_path(org, "renamed"))
                    continue
                if operation == "cheap":
                    pred = org.cheap_compact(USER, "worker")["bearer"]
                elif operation == "switch":
                    org.switch_model(USER, "worker", "luna")
                    pred = org.nodes["worker"]["predecessor"]
                else:
                    sid = str(uuid.uuid4())
                    from engine.backend.orgtree.ledger import LedgerError
                    with self.assertRaisesRegex(LedgerError, "no validated"):
                        Org(copy.deepcopy(base)).compact_split("worker", sid)
                    # A real native successor file is required, not just the
                    # ledger SID change; patch only lookup to this fixture.
                    old_path = Path(native.native_session_path(org, "worker"))
                    rows = [json.loads(v) for v in old_path.read_text().splitlines()]
                    for row in rows:
                        row["sessionId"] = sid
                    target = self.dest / f"{sid}.jsonl"
                    target.write_text("".join(json.dumps(r) + "\n" for r in rows))
                    from engine.backend.orgtree import supervisor
                    with patch.object(supervisor, "transcript_path", return_value=str(target)):
                        pred = org.compact_split("worker", sid)
                self.assertEqual(org.nodes["worker"]["desktop_import"]["native_continuity"]["status"], "transitioned")
                self.assertEqual(org.nodes[pred]["desktop_import"], original)
                self.assertIsNone(native.native_hold_reason(org, "worker"))
                self.assertIsNone(native.native_hold_reason(org, pred))
                org.nodes["worker"]["session_id"] = str(uuid.uuid4())
                self.assertIsNotNone(native.native_hold_reason(org, "worker"))

    def test_sqlite_copy_preserves_history_documents_files_and_independence(self) -> None:
        original = self.fixture()
        before = fingerprint(self.source)
        preview = imp.preview_import(str(self.source))
        self.assertEqual(preview["organizations"][0]["name"], "acme")
        self.assertIsNone(preview["organizations"][0]["conflict"])
        self.assertEqual(fingerprint(self.source), before)
        self.assertFalse((self.dest / "orgs" / "acme.db").exists())
        result = self.run_import()
        self.assertEqual(self.resumed, ["acme"])
        self.assertEqual(result["imported"][0]["active_nodes"], ["worker"])
        doc = self.read()
        for section in ("events", "mail_log", "op_receipts", "work_items"):
            self.assertEqual(doc[section], original[section])
        self.assertEqual(list(doc["nodes"]), list(original["nodes"]))
        self.assertTrue(doc["auto_resume"])
        self.assertEqual(doc["watchdogs"][0]["state"], "armed")
        self.assertEqual(doc["documents"][0], original["documents"][0])
        self.assertEqual(Path(doc["documents"][1]["file"]).read_bytes(), b"<img src='image.svg'>")
        self.assertEqual((self.dest / "scratch/acme/worker/outbox/image.svg").read_bytes(), b"<svg>copy me</svg>")
        self.assertEqual(doc["workspace"], str(self.dest / "workspaces/acme"))
        self.assertEqual(doc["nodes"]["worker"]["scope"]["add_dirs"][0]["path"],
                         str(self.dest / "scratch/acme/worker"))
        self.assertEqual(json.loads((self.dest / "imports/acme/original.json").read_text()), original)
        history = Path(imp.imported_history_path(doc, "worker"))
        self.assertIn("step done", history.read_text())
        for node in doc["nodes"].values():
            self.assertNotEqual(node["session_id"], "source-session")
            self.assertTrue(node["session_unrun"])
            self.assertNotIn("codex_thread", node)
            self.assertNotIn("antigravity_conversation", node)
            self.assertNotIn("remote_controlled", node)
            self.assertIsNone(node["pid"])
        self.assertIn("reconcile completed/uncertain", doc["nodes"]["worker"]["inflight"]["text"])
        self.assertEqual(fingerprint(self.source), before)
        (self.dest / "scratch/acme/worker/outbox/image.svg").write_text("changed")
        history.write_text("destination history changed")
        with closing(sqlite3.connect(self.dest / "orgs/acme.db")) as conn:
            conn.execute("UPDATE doc SET val=? WHERE key='name'", ('"new name"',))
            conn.commit()
        self.assertEqual(fingerprint(self.source), before)

    def test_live_wal_snapshot_is_included_without_source_sidecar_writes(self) -> None:
        self.fixture()
        db = self.source / "orgs/acme.db"
        with closing(sqlite3.connect(db)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("UPDATE doc SET val=? WHERE key='name'", ('"WAL-only name"',))
            writer.commit()
            self.assertGreater(Path(str(db) + "-wal").stat().st_size, 0)
            before = fingerprint(self.source)
            self.run_import()
            self.assertEqual(self.read()["name"], "WAL-only name")
            self.assertEqual(fingerprint(self.source), before)

    def test_json_source_copies_to_sqlite_without_migrating_source(self) -> None:
        self.fixture(sqlite=False)
        before = fingerprint(self.source)
        self.run_import()
        self.assertEqual(self.read()["name"], "acme")
        self.assertEqual(fingerprint(self.source), before)
        self.assertFalse((self.source / "orgs/acme.db").exists())

    def test_overlap_relative_missing_root_and_bound_store_mismatch(self) -> None:
        for source in (str(self.dest), str(self.root), str(self.dest / "child"), "relative"):
            with self.subTest(source=source), self.assertRaises(imp.ImportRefused):
                imp.preview_import(source)
        with patch.dict(os.environ, {"ORGTREE_DATA": str(self.source)}):
            with self.assertRaisesRegex(imp.ImportRefused, "different data root"):
                imp.preview_import(str(self.source))
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(imp.ImportRefused, "explicit absolute"):
                imp.preview_import(str(self.source))

    def test_conflict_and_acknowledgement_refuse_before_publication(self) -> None:
        self.fixture()
        with self.assertRaisesRegex(imp.ImportRefused, "Acknowledge"):
            imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=False,
                            on_imported=self.resumed.append)
        self.run_import()
        before = fingerprint(self.dest)
        with self.assertRaisesRegex(imp.ImportRefused, "already contains"):
            self.run_import()
        self.assertEqual(fingerprint(self.dest), before)
        self.assertEqual(self.resumed, ["acme"])

    def test_malformed_and_ambiguous_source_refused(self) -> None:
        bad = self.source / "orgs/acme.json"
        for content in ("{", "[]", '{"slug":"wrong","name":"x","nodes":{}}',
                        '{"slug":"acme","name":"x","nodes":[]}'):
            bad.write_text(content)
            with self.assertRaises((imp.ImportRefused, ValueError)):
                self.run_import()
            self.assertFalse((self.dest / "orgs/acme.db").exists())
        self.fixture()
        with self.assertRaisesRegex(imp.ImportRefused, "ambiguous"):
            self.run_import()
        self.assertEqual(self.resumed, [])

    def test_cyclic_hierarchy_and_malformed_logs_refused(self) -> None:
        doc = self.fixture(sqlite=False)
        doc["nodes"]["worker"]["parent"] = "idle"
        doc["nodes"]["idle"]["parent"] = "worker"
        path = self.source / "orgs/acme.json"
        path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(imp.ImportRefused, "cyclic"):
            self.run_import()
        doc["nodes"]["worker"]["parent"] = None
        doc["mail_log"] = {"worker": "not a list"}
        path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(imp.ImportRefused, "malformed history"):
            self.run_import()

    def test_source_mutation_during_copy_refused(self) -> None:
        self.fixture()
        original_copy = imp._copy_file
        def mutate(source, dest):
            result = original_copy(source, dest)
            if source.name == "acme.db":
                with closing(sqlite3.connect(source)) as conn:
                    conn.execute("UPDATE doc SET val=? WHERE key='name'", ('"changed"',))
                    conn.commit()
            return result
        with patch.object(imp, "_copy_file", side_effect=mutate):
            with self.assertRaisesRegex(imp.ImportRefused, "changed while copying"):
                self.run_import()
        self.assertFalse((self.dest / "orgs/acme.db").exists())
        self.assertEqual(self.resumed, [])

    def test_transaction_and_publication_failure_never_resume_or_publish_partial_org(self) -> None:
        self.fixture()
        before = fingerprint(self.source)
        write = store._write_doc
        def failed_write(conn, doc, lazy):
            write(conn, doc, lazy)
            raise RuntimeError("injected transaction failure")
        with patch.object(store, "_write_doc", side_effect=failed_write):
            with self.assertRaisesRegex(RuntimeError, "transaction failure"):
                self.run_import()
        candidates = list((self.dest / ".import-staging").glob("*/acme/candidate.db"))
        self.assertEqual(len(candidates), 1)
        with closing(sqlite3.connect(candidates[0])) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM nodes").fetchone(), (0,))
        with patch.object(store, "verify_migration", side_effect=RuntimeError("injected rollback")):
            with self.assertRaisesRegex(RuntimeError, "injected rollback"):
                self.run_import()
        self.assertFalse((self.dest / "orgs/acme.db").exists())
        self.assertFalse((self.dest / "scratch/acme").exists())
        with patch.object(imp.os, "link", side_effect=OSError("injected publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.run_import()
        self.assertFalse((self.dest / "orgs/acme.db").exists())
        self.assertEqual(self.resumed, [])
        self.assertEqual(fingerprint(self.source), before)

    def test_disabled_features_and_account_registry_are_reported_and_archived(self) -> None:
        doc = self.fixture(sqlite=False)
        doc.update(kiosk={"enabled": True}, sandbox={"enabled": True},
                   net_identity={"slug": "source-identity", "secret": "fixture-secret"})
        (self.source / "accounts.json").write_text('{"fallback":"fixture-only"}')
        (self.source / "orgs/acme.json").write_text(json.dumps(doc))
        before = fingerprint(self.source)
        result = self.run_import()
        imported = self.read()
        for key in ("kiosk", "sandbox", "net_identity"):
            self.assertNotIn(key, imported)
        self.assertFalse((self.dest / "accounts.json").exists())
        warnings = " ".join(result["imported"][0]["warnings"])
        for word in ("accounts.json skipped", "kiosk", "sandbox", "network identity"):
            self.assertIn(word, warnings)
        self.assertEqual(json.loads((self.dest / "imports/acme/original.json").read_text()), doc)
        self.assertEqual(fingerprint(self.source), before)

    def test_invalid_authority_and_unknown_sqlite_schema_refused(self) -> None:
        doc = self.fixture(sqlite=False)
        path = self.source / "orgs/acme.json"
        for field, value in (("grant", -1), ("grant", float("inf")), ("model", "missing-tier")):
            changed = copy.deepcopy(doc)
            changed["nodes"]["worker"][field] = value
            path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(imp.ImportRefused, "invalid agent grant or model"):
                self.run_import()
        changed = copy.deepcopy(doc)
        changed["nodes"]["worker"]["scope"]["permission_mode"] = "anything"
        path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(imp.ImportRefused, "invalid permission mode"):
            self.run_import()
        # Preserve the fixture JSON; move only this verified regular file.
        path.rename(path.with_suffix(".fixture-original"))
        db = self.source / "orgs/acme.db"
        imp._write_candidate(db, doc)
        with closing(sqlite3.connect(db)) as conn:
            conn.execute("UPDATE meta SET val='999' WHERE key='schema_version'")
            conn.commit()
        with self.assertRaisesRegex(imp.ImportRefused, "unsupported SQLite schema"):
            self.run_import()
        self.assertFalse((self.dest / "orgs/acme.db").exists())

    def test_runtime_path_normalization_preserves_historical_paths(self) -> None:
        doc = self.fixture(sqlite=False)
        spelling = str(self.source / "scratch" / ".." / "workspaces" / "acme")
        doc["workspace"] = spelling
        doc["events"][0]["text"] = spelling
        doc["nodes"]["worker"]["turns"] = [{"evidence": spelling}]
        (self.source / "orgs/acme.json").write_text(json.dumps(doc))
        self.run_import()
        imported = self.read()
        self.assertEqual(imported["workspace"], str(self.dest / "workspaces/acme"))
        self.assertEqual(imported["events"][0]["text"], spelling)
        self.assertEqual(imported["nodes"]["worker"]["turns"][0]["evidence"], spelling)

    def test_recovery_failure_reports_committed_copy_without_retry(self) -> None:
        self.fixture()
        def failed(slug):
            self.assertEqual(self.read(slug)["name"], "acme")
            raise RuntimeError("recovery failed")
        result = self.run_import(callback=failed)
        self.assertTrue(result["imported"][0]["recovery_pending"])
        self.assertTrue(any("Copy committed" in w for w in result["imported"][0]["warnings"]))
        self.assertTrue((self.dest / "orgs/acme.db").exists())

    def test_multi_org_partial_publication_reports_completed_copy(self) -> None:
        self.fixture("acme")
        self.fixture("beta")
        publish = imp._publish
        def fail_second(dest, slug, stage):
            if slug == "beta":
                raise OSError("second publication failed")
            return publish(dest, slug, stage)
        with patch.object(imp, "_publish", side_effect=fail_second):
            result = self.run_import(["acme", "beta"])
        self.assertEqual([r["slug"] for r in result["imported"]], ["acme"])
        self.assertEqual(result["failed"][0]["slug"], "beta")
        self.assertEqual(self.resumed, ["acme"])

    def test_authenticated_route_and_strict_payload_controls(self) -> None:
        self.fixture()
        app = FastAPI()
        app.include_router(imp.router)
        imp.configure(on_imported=self.resumed.append)
        client = TestClient(TokenGate(app, "fixture-only-secret"))
        headers = {"x-orgtree-desktop-token": "fixture-only-secret"}
        body = {"source_root": str(self.source)}
        self.assertEqual(client.post("/api/desktop/import-v1/preview", json=body).status_code, 401)
        good = client.post("/api/desktop/import-v1/preview", json=body, headers=headers)
        self.assertEqual(good.status_code, 200, good.text)
        self.assertEqual(good.json()["organizations"][0]["slug"], "acme")
        body.update(organizations=["acme"], acknowledge_duplicate_work="yes")
        self.assertEqual(client.post("/api/desktop/import-v1", json=body, headers=headers).status_code, 422)
        body["acknowledge_duplicate_work"] = True
        result = job_result(client, body, headers)
        self.assertEqual(result["imported"][0]["slug"], "acme")
        self.assertEqual(self.resumed, ["acme"])

    def make_directory_link(self, link: Path, target: Path) -> None:
        link.parent.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                           check=True, capture_output=True)
        else:
            link.symlink_to(target, target_is_directory=True)
        info = link.lstat()
        self.assertTrue(link.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400)

    def test_dependency_junctions_skipped_with_api_warnings_and_ordinary_files_kept(self) -> None:
        self.fixture()
        scratch = self.source / "scratch/acme/worker"
        ordinary = scratch / "project/node_modules/ordinary/keep.txt"
        ordinary.parent.mkdir(parents=True)
        ordinary.write_bytes(b"keep ordinary dependency")
        target = self.root / "external-dependencies"
        target.mkdir()
        (target / "secret.txt").write_bytes(b"never read target")
        before = fingerprint(self.source)
        target_before = fingerprint(target)
        links = [scratch / "project/node_modules/.bin", scratch / "other/NoDe_MoDuLeS"]
        for link in links:
            self.make_directory_link(link, target)
        real_iterdir = Path.iterdir
        def guarded_iterdir(path):
            if any(path == link or path.is_relative_to(link) for link in links) or path == target:
                raise AssertionError("Skipped junction target was traversed")
            return real_iterdir(path)
        app = FastAPI()
        app.include_router(imp.router)
        imp.configure(on_imported=self.resumed.append)
        client = TestClient(TokenGate(app, "fixture-only-secret"))
        with patch.object(Path, "iterdir", guarded_iterdir), patch.object(subprocess, "Popen", side_effect=AssertionError("No provider")):
            result = job_result(client, {"source_root": str(self.source), "organizations": ["acme"],
                                        "acknowledge_duplicate_work": True},
                                {"x-orgtree-desktop-token": "fixture-only-secret"})
        row = result["imported"][0]
        warnings = [value for value in row["warnings"] if value.startswith("Skipped linked dependency:")]
        self.assertEqual(len(warnings), 2)
        for link in links:
            relative = link.relative_to(self.source)
            self.assertTrue(any(relative.as_posix() in value and "Reinstall dependencies" in value for value in warnings))
            self.assertFalse((self.dest / relative).exists())
            self.assertTrue(link.exists())
        self.assertEqual((self.dest / ordinary.relative_to(self.source)).read_bytes(), ordinary.read_bytes())
        self.assertTrue((self.dest / "orgs/acme.db").is_file())
        store._POOL.close_all("acme")
        self.assertEqual(store.load_org("acme").d["desktop_import"]["warnings"], row["warnings"])
        self.assertEqual(self.resumed, ["acme"])
        self.assertEqual({name: hashlib.sha256((self.source / name).read_bytes()).hexdigest() for name in before}, before)
        self.assertEqual(fingerprint(target), target_before)

    def test_non_dependency_and_substring_junctions_still_refused(self) -> None:
        self.fixture()
        target = self.root / "external-working-files"
        target.mkdir()
        (target / "keep.txt").write_bytes(b"unchanged")
        for name in ("working-link", "not_node_modules", "node_modules_backup"):
            with self.subTest(name=name):
                src = self.root / ("isolated-" + name)
                src.mkdir()
                link = src / name
                self.make_directory_link(link, target)
                omissions = imp._DependencyOmissions()
                with self.assertRaisesRegex(imp.ImportRefused, "Links and reparse"):
                    imp._copy_tree(src, self.root / ("out-" + name), dependency_omissions=omissions)
                self.assertEqual(omissions.warnings(), [])
        self.assertEqual((target / "keep.txt").read_bytes(), b"unchanged")

    def test_node_modules_org_name_does_not_exempt_working_links(self) -> None:
        doc = self.fixture("node_modules", sqlite=False)
        doc["slug"] = "node_modules"  # Valid imported slug; Org.create normalizes underscores.
        (self.source / "orgs/node_modules.json").write_text(json.dumps(doc), encoding="utf-8")
        target = self.root / "external-working-files"
        target.mkdir()
        (target / "keep.txt").write_bytes(b"unchanged")
        self.make_directory_link(self.source / "scratch/node_modules/worker/working-link", target)
        with self.assertRaisesRegex(imp.ImportRefused, "Links and reparse"):
            self.run_import(["node_modules"])
        self.assertFalse((self.dest / "orgs/node_modules.db").exists())
        self.assertEqual(self.resumed, [])
        self.assertEqual((target / "keep.txt").read_bytes(), b"unchanged")

    def test_many_dependency_links_report_bounded_examples_and_exact_total(self) -> None:
        self.fixture()
        target = self.root / "external-dependencies"
        target.mkdir()
        (target / "keep.txt").write_bytes(b"unchanged")
        base = self.source / "scratch/acme/worker/node_modules"
        for index in range(40):
            self.make_directory_link(base / f"link-{index:02}", target)
        ordinary = base / "ordinary/keep.txt"
        ordinary.parent.mkdir()
        ordinary.write_bytes(b"ordinary survives")
        result = self.run_import()
        rows = [row for row in result["imported"][0]["warnings"] if row.startswith("Skipped")]
        self.assertEqual(len(rows), 21)
        self.assertIn("40 linked dependencies in total; 20 additional paths", rows[-1])
        self.assertTrue(all("Reinstall dependencies" in row for row in rows))
        self.assertEqual((self.dest / ordinary.relative_to(self.source)).read_bytes(), b"ordinary survives")
        store._POOL.close_all("acme")
        saved = store.load_org("acme").d["desktop_import"]["warnings"]
        self.assertEqual([row for row in saved if row.startswith("Skipped")], rows)
        # Mirror: the same number of ordinary dependency directories emits no omissions.
        normal = self.root / "normal"
        for index in range(40):
            path = normal / "node_modules" / f"plain-{index:02}" / "keep.txt"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"retained")
        omissions = imp._DependencyOmissions()
        output = self.root / "normal-copy"
        imp._copy_tree(normal, output, dependency_omissions=omissions)
        self.assertEqual(omissions.count, 0)
        self.assertEqual(omissions.warnings(), [])
        self.assertEqual(fingerprint(normal), fingerprint(output))
        self.assertEqual((target / "keep.txt").read_bytes(), b"unchanged")

    def test_reparse_positive_control_is_refused_without_following(self) -> None:
        self.fixture()
        # Test the Windows lstat bit directly; no junction creation/cleanup and
        # no vacuous OS skip. The same guard rejects real symlinks on POSIX.
        path = self.source / "scratch/acme/worker"
        real = Path.lstat
        def marked(value):
            result = real(value)
            if value == path:
                from types import SimpleNamespace
                return SimpleNamespace(st_mode=result.st_mode, st_file_attributes=0x400)
            return result
        with patch.object(Path, "lstat", marked):
            with self.assertRaisesRegex(imp.ImportRefused, "reparse"):
                self.run_import()
        self.assertFalse((self.dest / "orgs/acme.db").exists())
        self.assertEqual(self.resumed, [])


class AssembledImportTests(unittest.TestCase):
    def test_launcher_authenticated_copy_recovery_and_real_history(self) -> None:
        script = r'''
import hashlib, json, os, sys
from pathlib import Path
from unittest.mock import patch
root = Path(sys.argv[1]).resolve()
home, source, dest = root / 'home', root / 'v1', root / 'v2'
for path in (home, source / 'orgs', dest):
    path.mkdir(parents=True)
for key in list(os.environ):
    if key.startswith('ORGTREE_'):
        os.environ.pop(key)
os.environ.update(ORGTREE_DATA=str(dest), ORGTREE_STORE='sqlite',
                  ORGTREE_V2_TOKEN='fixture-desktop-token', HOME=str(home), USERPROFILE=str(home))
def hashes():
    return {str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in source.rglob('*') if p.is_file()}
with patch('subprocess.Popen', side_effect=AssertionError('provider/process launch forbidden in fixture')):
    from engine import launch
    app, token, _, _, _ = launch.load_app()
    from orgtree import store, ledger, supervisor, desktop_import, desktop_recovery, agentauth
    from fastapi.testclient import TestClient
    assert Path(store.DATA_ROOT).resolve() == dest
    org = ledger.Org.create('acme', workspace=str(source / 'workspaces/acme'))
    for nid in ('active', 'idle'):
        org.hire(ledger.USER, None, 'haiku', 0, nid)
    old_sid = org.nodes['active']['session_id']
    org.nodes['active']['inflight'] = {'text':'continue the exact unfinished work', 'view':'original visible prompt'}
    org.post_mail(ledger.USER, 'idle', 'queued, but was not active')
    org.d['documents'] = [{'id':'report', 'node':'active', 'title':'Retained report', 'body':'document survives'}]
    org.d['auto_resume'] = True
    org.d['watchdogs'] = [
        {'id':wid, 'name':wid, 'owner':'active', 'state':state, 'kind':'file',
         'target':str(source / 'scratch/acme/active/output.txt'), 'pattern':'DONE'}
        for wid,state in [('enabled','armed'),('disabled','paused')]]
    org.d['op_receipts'] = [{'id':'original-uncertain-effect', 'outcome':'unknown'}]
    scratch = source / 'scratch/acme/active'
    scratch.mkdir(parents=True)
    (scratch / 'output.txt').write_text('DONE\n', encoding='utf-8')
    journal = source / 'journals/projects/acme'
    journal.mkdir(parents=True)
    (journal / (old_sid + '.jsonl')).write_text(
        '{"type":"assistant","message":{"role":"assistant","content":"copied original history"}}\n', encoding='utf-8')
    desktop_import._write_candidate(source / 'orgs/acme.db', org.d)
    before = hashes()
    auth = store.create_org('authority')
    auth.hire(ledger.USER, None, 'haiku', 0, 'caller')
    store.save_org(auth)
    agent_token = agentauth.child_env('authority', 'caller')['ORGTREE_AGENT_TOKEN']
    client = TestClient(app)
    headers = {'x-orgtree-desktop-token':token}
    payload = {'source_root':str(source)}
    for invalid in ({}, {'x-orgtree-agent-token':agent_token}):
        assert client.post('/api/desktop/import-v1/preview',json=payload,headers=invalid).status_code == 401
    preview = client.post('/api/desktop/import-v1/preview',json=payload,headers=headers)
    assert preview.status_code == 200, preview.text
    assert preview.json()['organizations'][0]['slug'] == 'acme'
    assert not (dest / 'orgs/acme.db').exists()
    admitted = []
    def record(slug, nid, text, **kwargs):
        persisted = store.load_org(slug)
        assert not persisted.nodes[nid].get('inflight'), 'release must be durable before admission'
        assert persisted.nodes[nid]['session_id'] != old_sid
        assert hashes() == before
        admitted.append((nid, text, kwargs))
        return {'accepted':True,'queued':0}  # This recorder models admission, not native validation.
    import uuid
    payload.update(organizations=['acme'],acknowledge_duplicate_work=True,request_id=str(uuid.uuid4()))
    import threading
    entered, release = threading.Event(), threading.Event()
    copy_file = desktop_import._copy_file
    def slow_copy(src,dst):
        if src.name == 'output.txt':
            entered.set()
            assert release.wait(10), 'fixture did not release copy'
        return copy_file(src,dst)
    from orgtree import desktop_maintenance
    desktop_maintenance._write({'id':'copy-maintenance','state':'pending','action':'restart'})
    idle_control = client.get('/api/desktop/status',headers=headers).json()
    assert idle_control['idle'] is True and idle_control['importActive'] is False, idle_control
    with patch.object(supervisor, 'send_message', side_effect=record), patch.object(desktop_import, '_copy_file', slow_copy):
        import time
        started = client.post('/api/desktop/import-v1/jobs',json=payload,headers=headers)
        assert started.status_code == 202, started.text
        try:
            assert entered.wait(5), 'actual copy did not reach delay'
            tick=time.monotonic()
            copying=client.get('/api/desktop/status',headers=headers)
            assert time.monotonic()-tick<1, 'desktop status blocked behind copy'
            assert copying.json()['idle'] is False and copying.json()['importActive'] is True, copying.text
            ack=client.post('/api/desktop/maintenance/ack',json={'id':'copy-maintenance'},headers=headers)
            assert ack.json()=={'accepted':False}, ack.text
        finally:
            release.set()
        deadline = time.monotonic()+15
        while time.monotonic()<deadline:
            result = client.get('/api/desktop/import-v1/jobs/'+payload['request_id'],headers=headers)
            job = result.json()['job']
            if job['state'] not in {'queued','running'}: break
            time.sleep(.01)
        assert job['state']=='succeeded', job
        imported = job['result']['imported'][0]
        assert imported['recovery_pending'] is False, result.text
        assert [row[0] for row in admitted] == ['active'], admitted
        assert 'continue the exact unfinished work' in admitted[0][1]
        assert 'reconcile completed/uncertain' in admitted[0][1]
        assert admitted[0][2]['view'] == 'original visible prompt'
        assert desktop_recovery.resume_import('acme')['already_reconciled']
        assert len(admitted) == 1
    copied = store.load_org('acme')
    assert copied.waking_mail('idle')
    assert copied.d['documents'][0]['body'] == 'document survives'
    assert copied.d['watchdogs'][0]['state'] == 'armed' and copied.d['auto_resume']
    assert copied.d['op_receipts'][0]['id'] == 'original-uncertain-effect'
    fired = []
    with patch.object(supervisor, '_wd_fire', side_effect=lambda slug,wid,name,lines: fired.append(wid)):
        supervisor._wd_tick()
    assert fired == ['enabled'], fired
    assert supervisor.transcript_path(copied.nodes['active']['session_id']) is None
    chat_url = '/api/orgs/acme/nodes/active/chat'
    chat_before = client.get(chat_url,headers=headers)
    assert chat_before.status_code == 200, chat_before.text
    archive_before = [row for row in chat_before.json()['messages'] if row.get('imported_history')]
    assert len(archive_before) == 1 and archive_before[0]['text'] == 'copied original history', chat_before.text
    native = dest / 'journals/projects/acme' / (copied.nodes['active']['session_id'] + '.jsonl')
    native.write_text('{"type":"assistant","message":{"role":"assistant","content":"new native history"}}\n', encoding='utf-8')
    chat_after = client.get(chat_url,headers=headers)
    assert chat_after.status_code == 200, chat_after.text
    archive_after = [row for row in chat_after.json()['messages'] if row.get('imported_history')]
    assert archive_after[0]['event_id'] == archive_before[0]['event_id']
    assert any(row.get('text') == 'new native history' for row in chat_after.json()['messages']), chat_after.text
    assert hashes() == before, 'assembled route or recovery mutated V1'
    for slug in ('acme', 'authority'):
        store._POOL.close_all(slug)
    print(json.dumps({'authenticated_route':True,'agent_token_refused':True,'active_only':['active'],
                      'idle_mail_preserved':True,'copied_history_before_after_native':True,
                      'source_hashes_unchanged':True,'enabled_automation_only':fired,'provider_processes':0}))
'''
        root = Path(tempfile.mkdtemp(prefix="assembled-", dir=_TEST_ROOT))
        result = subprocess.run([sys.executable, "-c", script, str(root)],
                                cwd=Path(__file__).resolve().parents[1],
                                text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('"copied_history_before_after_native": true', result.stdout)


if __name__ == "__main__":
    unittest.main()
