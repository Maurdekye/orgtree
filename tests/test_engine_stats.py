"""The engine debug view's numbers are the engine's real numbers.

GET /api/diagnostics/engine-stats feeds the desktop's Developer › engine debug
view (about 1 Hz, only while its toggle is on). These tests serve the REAL
`api.app` on a real uvicorn server, stall a websocket exactly as a hung window
does, and check what the endpoint reports against what was actually queued —
frame count and exact encoded bytes — then against the drop and the window's
reconnect; and the docket-list counters against real 200 and 304 answers.
"""
import base64
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
import urllib.request

_root = tempfile.TemporaryDirectory(prefix="orgtree-engine-stats-", ignore_cleanup_errors=True)
_data = Path(_root.name) / "data"
_home = Path(_root.name) / "home"
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_STORE_BACKEND="sqlite")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

import asyncio  # noqa: E402
import threading  # noqa: E402

import uvicorn  # noqa: E402

from orgtree import api, ledger, store  # noqa: E402

SLUG = "engstats"
FRAME_TEXT = "é" * 8_000            # non-ASCII: bytes != characters


class _Server:
    def __init__(self) -> None:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        self.server = uvicorn.Server(uvicorn.Config(
            api.app, host="127.0.0.1", port=self.port, lifespan="off",
            access_log=False, log_level="warning"))
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        deadline = time.time() + 20
        while not self.server.started:
            if time.time() > deadline:
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.02)

    def _run(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.server.serve())

    def call(self, coro, timeout: float = 10):
        assert self.loop is not None
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def get(self, path: str, headers: dict | None = None) -> tuple[int, bytes, dict]:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def stats(self) -> dict:
        status, body, _ = self.get("/api/diagnostics/engine-stats")
        assert status == 200, (status, body[:300])
        return json.loads(body)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(10)


def _stalled_client(port: int, win: str) -> socket.socket:
    """Handshake as window `win`, then never read again."""
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16_384)
    s.connect(("127.0.0.1", port))
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /api/orgs/{SLUG}/ws?win={win} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise AssertionError("handshake refused")
        buf += chunk
    assert b" 101 " in buf.split(b"\r\n", 1)[0], buf[:200]
    return s


def _wait(pred, timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


def _frame(i: int) -> dict:
    return {"type": "node_stream", "org": SLUG, "node": "n", "rev": i,
            "kind": "delta", "text": FRAME_TEXT}


def _frame_bytes(i: int) -> int:
    return len(json.dumps(_frame(i), separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _rows(stats: dict, win: str) -> list[dict]:
    return [r for r in stats["websockets"]["sockets"] if r["window"] == win]


class EngineStats(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.srv = _Server()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.srv.stop()

    def setUp(self) -> None:
        self.saved = (api._WS_QUEUE_MAX, api._WS_SEND_TIMEOUT)

    def tearDown(self) -> None:
        api._WS_QUEUE_MAX, api._WS_SEND_TIMEOUT = self.saved

    def test_stalled_socket_backlog_drop_and_reconnect_are_reported(self) -> None:
        api._WS_SEND_TIMEOUT = 3600.0          # only the cap may drop it
        api._WS_QUEUE_MAX = 10 ** 6            # first: let it back up freely
        win = "w" + os.urandom(3).hex()
        s = _stalled_client(self.srv.port, win)
        try:
            self.assertTrue(_wait(lambda: len(_rows(self.srv.stats(), win)) == 1),
                            "the socket never appeared in the stats")
            (row,) = _rows(self.srv.stats(), win)
            self.assertEqual(row["org"], SLUG)
            self.assertEqual(row["window_connects"], 1)
            self.assertEqual(row["pending"], 0)
            n = 1500                           # ~24 MB: far beyond any socket buffer
            for i in range(n):
                self.srv.call(api.hub._send(SLUG, _frame(i)))
            time.sleep(0.5)                    # let the writer block on the full socket
            (row,) = _rows(self.srv.stats(), win)
            # the control did work: the stall really backed frames up
            self.assertGreater(row["pending"], n // 4, row)
            # the reported bytes are the exact encoded size of what is queued
            # (the queued frames are the LAST `pending` ones sent)
            expect = sum(_frame_bytes(i) for i in range(n - row["pending"], n))
            self.assertEqual(row["pending_bytes"], expect)
            # one frame may be in flight: popped, not yet written
            self.assertIn(row["sent"] + row["pending"], (n - 1, n))
            drops0 = self.srv.stats()["websockets"]["drops"]["overflow"]

            # now tighten the cap: the next frame drops the socket
            api._WS_QUEUE_MAX = 16
            self.srv.call(api.hub._send(SLUG, _frame(n)))
            st = self.srv.stats()
            self.assertEqual(st["websockets"]["queue_max"], 16)
            self.assertEqual(st["websockets"]["drops"]["overflow"], drops0 + 1)
            self.assertEqual(_rows(st, win), [], "a dropped socket is still listed")
        finally:
            s.close()

        # the same window reconnects: its counts carry across sockets
        api._WS_QUEUE_MAX = self.saved[0]
        s2 = _stalled_client(self.srv.port, win)
        try:
            self.assertTrue(_wait(lambda: len(_rows(self.srv.stats(), win)) == 1))
            (row,) = _rows(self.srv.stats(), win)
            self.assertEqual(row["window_connects"], 2)
            self.assertEqual(row["window_drops"], 1)
            self.assertEqual(row["pending"], 0)
            self.assertEqual(row["pending_bytes"], 0)
        finally:
            s2.close()

    def test_engine_memory_is_reported(self) -> None:
        mem = self.srv.stats()["memory"]
        self.assertIsInstance(mem["rss_bytes"], int)
        self.assertGreater(mem["rss_bytes"], 10 * 2 ** 20)
        if sys.platform == "win32":
            self.assertIsInstance(mem["private_bytes"], int)
            self.assertGreater(mem["private_bytes"], 10 * 2 ** 20)

    def test_docket_list_answers_are_counted(self) -> None:
        slug = "es-" + os.urandom(3).hex()
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.work_create("boss", title="stat-item", objective="stat-item: the problem.", owner="boss")
        store.save_org(org)
        url = f"/api/orgs/{slug}/work-items?archived=1&backlogged=1"
        before = self.srv.stats()["work_list"]
        status, body, headers = self.srv.get(url)
        self.assertEqual(status, 200, body[:300])
        etag = headers.get("ETag") or headers.get("etag")
        status2, body2, _ = self.srv.get(url, {"If-None-Match": etag})
        self.assertEqual(status2, 304)
        self.assertEqual(body2, b"")
        after = self.srv.stats()["work_list"]
        self.assertEqual(after["full_200"] - before["full_200"], 1)
        self.assertEqual(after["not_modified_304"] - before["not_modified_304"], 1)
        self.assertEqual(after["bytes_200"] - before["bytes_200"], len(body))
        self.assertGreaterEqual(after["cached_bodies"], 1)
        self.assertGreaterEqual(after["cached_bytes"], len(body))
        self.assertEqual(after["window_s"], 60)

    def test_public_callers_are_refused(self) -> None:
        from fastapi.testclient import TestClient

        async def as_public(scope, receive, send):
            scope = dict(scope)
            scope["state"] = {**(scope.get("state") or {}), "public_slug": "kiosk"}
            await api.app(scope, receive, send)
        r = TestClient(as_public).get("/api/diagnostics/engine-stats")
        self.assertEqual(r.status_code, 403)


if __name__ == "__main__":
    unittest.main()
