"""Actual isolated copy/publication with reconnect and real-process crash controls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
import uuid
from unittest.mock import patch

# This fixture module binds a throwaway root BEFORE importing storage.
from tests.test_desktop_import import DesktopImportTests, fingerprint, imp, store
from engine.backend.orgtree import desktop_import_jobs as jobs
from engine.launch import TokenGate
from fastapi import FastAPI
from fastapi.testclient import TestClient


class ImportJobsTests(unittest.TestCase):
    setUp = DesktopImportTests.setUp
    fixture = DesktopImportTests.fixture

    def client(self):
        app = FastAPI()
        app.include_router(imp.router)
        imp.configure(on_imported=lambda slug: self.resumed.append(slug) or {"selected": []})
        return TestClient(TokenGate(app, "test-only-token"))

    headers = {"x-orgtree-desktop-token": "test-only-token"}

    def body(self, **changes):
        return dict(source_root=str(self.source), organizations=["acme"],
                    acknowledge_duplicate_work=True, request_id=str(uuid.uuid4()), **changes)

    def wait_job(self, identifier):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            job = jobs.get(identifier)
            if job["state"] not in jobs.ACTIVE:
                return job
            time.sleep(.01)
        self.fail("job did not finish within bounded fixture time")

    def test_long_real_copy_status_reconnect_and_duplicate_guard(self):
        self.fixture()
        before = fingerprint(self.source)
        entered, release = threading.Event(), threading.Event()
        real = imp._copy_file
        def delayed(source, destination):
            if source.name == "breadcrumbs.md":
                entered.set()
                if not release.wait(10):
                    raise AssertionError("fixture release missing")
            return real(source, destination)
        client, body = self.client(), self.body()
        with patch.object(imp, "_copy_file", delayed), patch.object(subprocess, "Popen", side_effect=AssertionError("No provider")):
            started = client.post("/api/desktop/import-v1/jobs", json=body, headers=self.headers)
            self.assertEqual(started.status_code, 202, started.text)
            try:
                self.assertTrue(entered.wait(5))
                acquired = store.DOC_LOCK.acquire(blocking=False)
                if acquired:
                    store.DOC_LOCK.release()
                self.assertFalse(acquired, "positive fixture must hold DOC_LOCK during copy")
                tick = time.monotonic()
                status = client.get("/api/desktop/import-v1/jobs/" + body["request_id"], headers=self.headers)
                self.assertLess(time.monotonic() - tick, 1)
                self.assertEqual(status.json()["job"]["phase"], "copying")
                from engine.backend.orgtree import desktop_maintenance as maintenance
                jobs._write(maintenance._path(), {"id": "test-maintenance", "state": "pending", "action": "restart"})
                self.assertTrue(jobs.active())
                self.assertEqual(maintenance.acknowledge("test-maintenance"), {"accepted": False})
                self.assertGreater(status.json()["job"]["files_copied"], 0)
                self.assertGreater(status.json()["job"]["bytes_copied"], 0)
                repeated = client.post("/api/desktop/import-v1/jobs", json=body, headers=self.headers)
                self.assertEqual(repeated.status_code, 202)
                self.assertEqual(repeated.json()["job"]["id"], body["request_id"])
                changed = dict(body, source_root=str(self.source / "different"))
                self.assertEqual(client.post("/api/desktop/import-v1/jobs", json=changed, headers=self.headers).status_code, 409)
                another = dict(body, request_id=str(uuid.uuid4()))
                competing = client.post("/api/desktop/import-v1/jobs", json=another, headers=self.headers)
                self.assertEqual(competing.status_code, 409)
                self.assertEqual(competing.json()["detail"], "An import is already running for this destination. Check its status.")
                self.assertEqual(client.get("/api/desktop/import-v1/jobs/current").status_code, 401)
                self.assertEqual(client.get("/api/desktop/import-v1/jobs/" + body["request_id"]).status_code, 401)
                self.assertEqual(client.post("/api/desktop/import-v1", json=body, headers=self.headers).status_code, 422)
                legacy = {key: value for key, value in body.items() if key != "request_id"}
                self.assertEqual(client.post("/api/desktop/import-v1", json=legacy, headers=self.headers).status_code, 409)
            finally:
                release.set()
                job = self.wait_job(body["request_id"])
        self.assertEqual(job["state"], "succeeded", job)
        self.assertTrue((self.dest / "orgs/acme.db").is_file())
        self.assertEqual(self.resumed, ["acme"])
        self.assertEqual(fingerprint(self.source), before)
        self.assertEqual(jobs.current()["id"], body["request_id"])
        self.assertEqual(jobs.start(imp.ImportJobBody(**body), self.resumed.append)["state"], "succeeded")
        self.assertEqual(self.resumed, ["acme"])
        self.assertEqual(jobs.get(body["request_id"])["result"], job["result"])
        self.assertFalse(jobs.active())
        self.assertEqual(maintenance.acknowledge("test-maintenance"), {"accepted": True})
        try:
            other = imp.ImportJobBody(**dict(body, request_id=str(uuid.uuid4())))
            with self.assertRaisesRegex(imp.ImportRefused, "reserved engine shutdown"):
                jobs.start(other, self.resumed.append)
        finally:
            self.assertTrue(maintenance.execution_failed("test-maintenance")["released"])

    def test_status_rereads_terminal_under_lease(self):
        root = jobs._root()
        identifier = str(uuid.uuid4())
        active = {"id": identifier, "state": "running", "phase": "publishing", "result": None, "publications": []}
        terminal = dict(active, state="succeeded", result={"imported": [{"slug": "acme"}]},
                        publications=[{"slug": "acme", "state": "published", "recovery": "returned"}])
        path = root / (identifier + ".json")
        jobs._write(path, active)
        real_lease = jobs._lease
        def completed_before_acquire(value):
            jobs._write(path, terminal)
            return real_lease(value)
        with patch.object(jobs, "_lease", completed_before_acquire):
            self.assertEqual(jobs.get(identifier), terminal)
        self.assertEqual(jobs._read(path), terminal)
        other = str(uuid.uuid4())
        jobs._write(root / (other + ".json"), dict(active, id=other))
        self.assertEqual(jobs.get(other)["state"], "interrupted")
        self.assertIn("No publication was recorded", jobs.get(other)["error"])

    def test_lease_excludes_and_release_reacquires(self):
        root = jobs._root()
        first = jobs._lease(root)
        self.assertIsNotNone(first)
        second = None
        try:
            second = jobs._lease(root)
            self.assertIsNone(second, "lease must exclude a competing handle")
        finally:
            jobs._release(second)
            jobs._release(first)
        third = jobs._lease(root)
        try:
            self.assertIsNotNone(third, "released lease must become available")
        finally:
            jobs._release(third)

    def test_current_missing_record_is_null_but_exact_is_404(self):
        root = jobs._root()
        identifier = str(uuid.uuid4())
        jobs._write(root / "current.json", {"id": identifier})
        self.assertIsNone(jobs.current())
        with self.assertRaises(imp.ImportRefused) as error:
            jobs.get(identifier)
        self.assertEqual(error.exception.status, 404)

    def test_source_refusal_terminal_and_unknown_get_no_work(self):
        self.fixture()
        client = self.client()
        unknown = str(uuid.uuid4())
        self.assertEqual(client.get("/api/desktop/import-v1/jobs/" + unknown, headers=self.headers).status_code, 404)
        body = self.body()
        body["source_root"] = str(self.dest)
        started = client.post("/api/desktop/import-v1/jobs", json=body, headers=self.headers)
        self.assertEqual(started.status_code, 202)
        job = self.wait_job(body["request_id"])
        self.assertEqual(job["state"], "failed")
        self.assertIn("must not overlap", job["error"])
        self.assertEqual(self.resumed, [])
        self.assertFalse((self.dest / "orgs/acme.db").exists())

    def test_progress_checkpointing_not_per_file(self):
        self.fixture()
        folder = self.source / "scratch/acme/worker/many-files"
        folder.mkdir()
        for index in range(100):
            (folder / f"{index}.txt").write_bytes(b"actual copied bytes")
        body = self.body()
        writes = []
        real_write = jobs._write
        def record(path, value):
            writes.append(path.name)
            return real_write(path, value)
        with patch.object(jobs, "_write", record), patch.object(subprocess, "Popen", side_effect=AssertionError("no provider")):
            jobs.start(imp.ImportJobBody(**body), self.resumed.append)
            job = self.wait_job(body["request_id"])
        self.assertEqual(job["state"], "succeeded")
        self.assertGreaterEqual(job["files_copied"], 100)
        self.assertGreater(job["bytes_copied"], 100 * len(b"actual copied bytes"))
        self.assertGreater(len(writes), 5)  # phase/publication/admission checkpoints really persist
        self.assertLess(len(writes), job["files_copied"] // 2)
        self.assertEqual(fingerprint(folder), fingerprint(self.dest / folder.relative_to(self.source)))

    def test_real_process_restart_before_and_after_publication_never_replays(self):
        self.fixture()
        before = fingerprint(self.source)
        script = r'''
import os,sys,time
from pathlib import Path
root=Path(sys.argv[1]).resolve(); root.mkdir(exist_ok=True)
os.environ.update(ORGTREE_DATA=str(root),HOME=str(root),USERPROFILE=str(root),ORGTREE_STORE='sqlite')
from engine.backend.orgtree import desktop_import as imp,desktop_import_jobs as jobs
import subprocess
subprocess.Popen=lambda *a,**k: (_ for _ in ()).throw(AssertionError('no provider'))
old=imp._progress
def progress(**event):
    old(**event)
    if (sys.argv[4]=='copy' and event.get('phase')=='copying') or (sys.argv[4]=='intent' and 'publication_intent' in event) or (sys.argv[4]=='published' and 'published' in event): os._exit(17)
imp._progress=progress
link=imp.os.link
def publish_link(*args,**kwargs):
    link(*args,**kwargs)
    if sys.argv[4]=='linked': os._exit(17)
imp.os.link=publish_link
def recover(slug):
    if sys.argv[4]=='recovery':
        (root/'recovery-recorder.txt').write_text(slug)
        os._exit(17)
    raise AssertionError('recovery must not run')
body=imp.ImportJobBody(source_root=sys.argv[2],organizations=['acme'],acknowledge_duplicate_work=True,request_id=sys.argv[3])
jobs.start(body,recover)
while True: time.sleep(.02)
'''
        for stage in ("copy", "intent", "linked", "published", "recovery"):
            with self.subTest(stage=stage):
                destination = self.root / ("crash-" + stage)
                identifier = str(uuid.uuid4())
                child = subprocess.run([sys.executable, "-c", script, str(destination), str(self.source), identifier, stage],
                                       cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=20)
                self.assertEqual(child.returncode, 17, child.stderr)
                with patch.object(store, "DATA_ROOT", str(destination)), patch.dict(os.environ, {"ORGTREE_DATA": str(destination)}):
                    job = jobs.get(identifier)
                    self.assertEqual(job["state"], "interrupted")
                    self.assertEqual(job["phase"], "copying" if stage == "copy" else "recovering" if stage == "recovery" else "publishing")
                    body = imp.ImportJobBody(source_root=str(self.source), organizations=["acme"], acknowledge_duplicate_work=True, request_id=identifier)
                    self.assertEqual(jobs.start(body, self.resumed.append)["state"], "interrupted")
                    self.assertEqual(self.resumed, [])
                    self.assertEqual((destination / "orgs/acme.db").exists(), stage in {"published", "linked", "recovery"})
                    if stage == "published":
                        self.assertEqual(job["result"]["imported"][0]["slug"], "acme")
                        self.assertEqual(job["publications"][0]["recovery"], "not_started")
                    if stage in {"intent", "linked"}:
                        self.assertEqual(job["publications"][0]["state"], "publishing")
                    if stage == "recovery":
                        self.assertEqual(job["publications"][0]["recovery"], "dispatching")
                        self.assertEqual((destination / "recovery-recorder.txt").read_text(), "acme")
        self.assertEqual(fingerprint(self.source), before)


if __name__ == "__main__":
    unittest.main()
