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
import unittest
from unittest.mock import patch

# No store/provider import may precede this binding.
_TEST_ROOT = Path(tempfile.mkdtemp(prefix="orgtree-v2-import-tests-")).resolve()
os.environ["ORGTREE_DATA"] = str(_TEST_ROOT)
os.environ["ORGTREE_STORE"] = "sqlite"

from engine.backend.orgtree import desktop_import as imp, store
from engine.backend.orgtree.ledger import Org
from fastapi import FastAPI
from fastapi.testclient import TestClient
from engine.launch import TokenGate


def fingerprint(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file()}


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

    def read(self, slug: str = "acme") -> dict:
        with closing(sqlite3.connect(self.dest / "orgs" / f"{slug}.db")) as conn:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            return store.reconstruct_full(conn)

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
        response = client.post("/api/desktop/import-v1", json=body, headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.resumed, ["acme"])

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
    payload.update(organizations=['acme'],acknowledge_duplicate_work=True)
    with patch.object(supervisor, 'send_message', side_effect=record):
        result = client.post('/api/desktop/import-v1',json=payload,headers=headers)
        assert result.status_code == 200, result.text
        imported = result.json()['imported'][0]
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
