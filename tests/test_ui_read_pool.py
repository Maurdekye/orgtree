"""#5 (scale gate): the desk's polled reads do not starve behind agent traffic.

The org list, the org tree and the docket list are plain sync handlers, so
FastAPI ran them on the shared 40-worker pool. Writers parked on DOC_LOCK can
fill that pool, and then a read that needs no lock at all waits for a worker:
measured in-process at ~3.5 s per read with the pool full (and 60 s p50 by
mem-leak-probe under real agent load). They now borrow workers from their own
limiter (`api._run_ui_read`), as the chat read already did.

What this pins, on a real uvicorn server over a disposable SQLite root:
  * with DOC_LOCK held and more writers than the shared pool has workers
    (proved full: 40 borrowed and more waiting), each of the three reads
    still answers in well under the hold time;
  * a CONTROL in the same run: one more writer request, on the shared pool,
    does wait — so the saturation is real and the reads' speed is the limiter;
  * the routes answer exactly what the functions they wrap return, including
    the docket list's conditional 304.

Run:  python tools/run-python-verification.py tests/test_ui_read_pool.py
"""
from __future__ import annotations

import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix="orgtree-ui-read-pool-", ignore_cleanup_errors=True)
for _k in [k for k in os.environ if k.startswith("ORGTREE_")]:
    os.environ.pop(_k)
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name,
                  ORGTREE_STORE="sqlite", ORGTREE_WARM="0", ORGTREE_V2_TOKEN="operator")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from orgtree import api, ledger, store  # noqa: E402

H = {"X-Orgtree-Desktop-Token": "operator"}
SLUG = "ui-read-pool"
HOLD = 6.0
WRITERS = 60


@api.app.get("/__test_pool_stats")
async def _pool_stats():
    import anyio.to_thread
    lim = anyio.to_thread.current_default_thread_limiter()
    return {"total": lim.total_tokens, "borrowed": lim.borrowed_tokens,
            "waiting": lim.statistics().tasks_waiting}


def setUpModule():
    global BASE, SERVER, NAMES
    store.claim_data_root()
    org = store.create_org(SLUG)
    org.d["max_top_grant"] = 0
    NAMES = []
    for i in range(30):
        parent = None if i == 0 else NAMES[(i - 1) // 8]
        org.hire(ledger.USER, parent, "opus", 0, f"a{i:02d}", add_dirs=[],
                 tools={"bash": False, "edit": False, "web": False, "subagents": False,
                        "mcp": []})
        NAMES.append(f"a{i:02d}")
    for i in range(5):
        org.work_create(NAMES[i], f"item {i}", objective="Problem: x. Solution: y.",
                        owner=NAMES[i])
    store.save_org(org)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    SERVER = uvicorn.Server(uvicorn.Config(api.app, host="127.0.0.1", port=port,
                                           log_level="warning", lifespan="off"))
    threading.Thread(target=SERVER.run, daemon=True).start()
    deadline = time.time() + 20
    while not SERVER.started and time.time() < deadline:
        time.sleep(0.05)
    BASE = f"http://127.0.0.1:{port}"


def tearDownModule():
    SERVER.should_exit = True


READS = {"orgs_list": "/api/orgs", "org_tree": f"/api/orgs/{SLUG}",
         "work_items": f"/api/orgs/{SLUG}/work-items"}


class ReadsDoNotStarve(unittest.TestCase):
    def test_reads_answer_while_writers_fill_the_shared_pool(self):
        held, release = threading.Event(), threading.Event()

        def hold():
            with store.DOC_LOCK:
                held.set()
                release.wait(HOLD)
        h = threading.Thread(target=hold, daemon=True)
        h.start()
        self.assertTrue(held.wait(5))
        done: list[int] = []

        def writer(i: int) -> None:
            with httpx.Client() as c:
                r = c.post(f"{BASE}/api/orgs/{SLUG}/nodes/{NAMES[1 + i % 7]}/reorder",
                           json={"after": NAMES[1 + (i + 1) % 7]}, headers=H, timeout=60)
                done.append(r.status_code)
        ws = [threading.Thread(target=writer, args=(i,), daemon=True) for i in range(WRITERS)]
        for t in ws:
            t.start()
        try:
            deadline = time.time() + 5
            stats = {}
            while time.time() < deadline:
                stats = httpx.get(BASE + "/__test_pool_stats", timeout=10).json()
                if stats["borrowed"] >= stats["total"] and stats["waiting"] > 0:
                    break
                time.sleep(0.05)
            # the saturation the reads must survive is real
            self.assertEqual(stats["borrowed"], stats["total"], stats)
            self.assertGreater(stats["waiting"], 0, stats)
            got: dict[str, tuple[float, int]] = {}

            def read(name: str, path: str) -> None:
                with httpx.Client() as c:
                    a = time.perf_counter()
                    r = c.get(BASE + path, headers=H, timeout=60)
                    got[name] = (time.perf_counter() - a, r.status_code)
            rs = [threading.Thread(target=read, args=kv) for kv in READS.items()]
            for t in rs:
                t.start()
            for t in rs:
                t.join(30)
            # CONTROL, still inside the hold: a writer on the shared pool waits
            self.assertLess(len(done), WRITERS, "the writers were not held")
        finally:
            release.set()
            h.join(10)
            for t in ws:
                t.join(60)
        for name in READS:
            self.assertEqual(got[name][1], 200, name)
            self.assertLess(got[name][0], 2.0, f"{name} waited {got[name][0]:.2f}s for a worker")
        self.assertEqual(set(done), {200})
        self.assertEqual(len(done), WRITERS)


class RoutesAnswerWhatTheFunctionsReturn(unittest.TestCase):
    def test_same_payloads_and_the_docket_304(self):
        with httpx.Client() as c:
            listed = c.get(BASE + READS["orgs_list"], headers=H, timeout=30)
            tree = c.get(BASE + READS["org_tree"], headers=H, timeout=30)
            items = c.get(BASE + READS["work_items"] + "?archived=1&backlogged=1",
                          headers=H, timeout=30)
            self.assertEqual((listed.status_code, tree.status_code, items.status_code),
                             (200, 200, 200))
            self.assertIn(SLUG, [o.get("slug") for o in listed.json()])
            self.assertTrue(all(f'"{n}"' in tree.text for n in NAMES))
            self.assertEqual(len(items.json()["items"]), 5)
            etag = items.headers.get("etag")
            self.assertTrue(etag)
            again = c.get(BASE + READS["work_items"] + "?archived=1&backlogged=1",
                          headers={**H, "If-None-Match": etag}, timeout=30)
            self.assertEqual(again.status_code, 304)


if __name__ == "__main__":
    unittest.main()
