"""A window that stops reading its websocket cannot grow engine memory without bound.

Measured 2026-09-25 (mem-leak-probe): every frame used to wait in its own
`Hub._send` coroutine for a socket that was not being read, so the engine grew
~1 MB/s at 100 frames/s against a stalled window and by GB per hour live. The
hub now gives each socket a bounded queue with one writer; a socket that fills
it, or whose single write stalls past `_WS_SEND_TIMEOUT`, has its connection
aborted so the renderer's `onclose` reconnects and refetches (App.tsx).

These tests serve the REAL `api.app` websocket route on a real uvicorn server
and drive frames exactly as `api.stream` does (`run_coroutine_threadsafe` of
`hub._send` from another thread). Each arm counts what it did — frames sent,
frames received, the peak queue depth — and asserts on those counts, so an
arm that did no work cannot pass.
"""
import asyncio
import base64
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix="orgtree-ws-backlog-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

import uvicorn  # noqa: E402

from orgtree import api  # noqa: E402

SLUG = "wsbound"
FRAME_TEXT = "x" * 16_000          # ~16 KB per frame: fills socket buffers fast


class _Server:
    """`api.app` on an ephemeral port, lifespan off (no supervisor, no agents)."""

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

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(10)


def _stalled_client(port: int) -> socket.socket:
    """Handshake, then never read again — a renderer whose main thread is busy
    or hung. A small receive buffer makes the stall bite quickly."""
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16_384)
    s.connect(("127.0.0.1", port))
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /api/orgs/{SLUG}/ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
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


def _room() -> set:
    return set(api.hub.rooms.get(SLUG, set()))


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


def _connection_ended(s: socket.socket, timeout: float = 15.0) -> bool:
    """Drain what the kernel buffered; True once the server has torn the
    connection down (EOF or reset) — what makes the renderer's onclose fire."""
    s.settimeout(0.5)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if not s.recv(1 << 16):
                return True
        except socket.timeout:
            continue
        except (ConnectionResetError, ConnectionAbortedError):
            return True
    return False


class WsBacklogBound(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.srv = _Server()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.srv.stop()

    def setUp(self) -> None:
        self.saved = (api._WS_QUEUE_MAX, api._WS_SEND_TIMEOUT)
        self.drops0 = dict(api.hub.drops)

    def tearDown(self) -> None:
        api._WS_QUEUE_MAX, api._WS_SEND_TIMEOUT = self.saved

    def _flood(self, ws, n: int) -> int:
        """Send n frames the way api.stream does; returns the peak queue depth
        observed for `ws` while sending."""
        peak = 0
        for i in range(n):
            self.srv.call(api.hub._send(SLUG, _frame(i)))
            peak = max(peak, api.hub.pending(ws))
        return peak

    def test_stalled_window_is_bounded_then_aborted(self) -> None:
        api._WS_SEND_TIMEOUT = 3600.0          # isolate the queue cap
        s = _stalled_client(self.srv.port)
        try:
            self.assertTrue(_wait(lambda: len(_room()) == 1), "socket never joined")
            (ws,) = _room()
            n = api._WS_QUEUE_MAX * 6          # ~24 MB: far beyond any socket buffer
            peak = self._flood(ws, n)
            # the control did work: the queue really filled
            self.assertGreaterEqual(peak, api._WS_QUEUE_MAX // 2,
                                    "the socket never backed up — the stall was not exercised")
            self.assertLessEqual(peak, api._WS_QUEUE_MAX, "the per-socket queue exceeded its cap")
            self.assertEqual(api.hub.drops["overflow"], self.drops0["overflow"] + 1)
            self.assertEqual(api.hub.drops["abort_failed"], self.drops0["abort_failed"],
                             "the transport could not be reached to abort it")
            self.assertNotIn(ws, _room())
            self.assertEqual(api.hub.pending(ws), 0, "the dropped socket's queue was kept")
            # no per-frame coroutines are left parked on the loop
            ntasks = self.srv.call(_count_tasks())
            self.assertLess(ntasks, 50, f"{ntasks} tasks still pending on the loop")
            # the window learns it must reconnect
            self.assertTrue(_connection_ended(s), "the stalled connection was never torn down")
        finally:
            s.close()

    def test_single_stalled_write_times_out(self) -> None:
        api._WS_SEND_TIMEOUT = 1.0
        api._WS_QUEUE_MAX = 10 ** 6             # isolate the write timeout
        s = _stalled_client(self.srv.port)
        try:
            self.assertTrue(_wait(lambda: len(_room()) == 1), "socket never joined")
            (ws,) = _room()
            self._flood(ws, 400)                # ~6 MB: enough to block a write
            self.assertTrue(_wait(lambda: api.hub.drops["stuck"] > self.drops0["stuck"], 15),
                            "a write stalled past the timeout was never dropped")
            self.assertEqual(api.hub.drops["abort_failed"], self.drops0["abort_failed"],
                             "the transport could not be reached to abort it")
            self.assertNotIn(ws, _room())
            self.assertTrue(_connection_ended(s), "the stalled connection was never torn down")
        finally:
            s.close()

    def test_reading_window_gets_every_frame_and_reconnect_works(self) -> None:
        from websockets.sync.client import connect
        api._WS_SEND_TIMEOUT = 15.0
        # a fresh connection after the drops above is served normally — the
        # renderer's reconnect path — and a window that reads is never dropped
        with connect(f"ws://127.0.0.1:{self.srv.port}/api/orgs/{SLUG}/ws",
                     max_size=None) as c:
            self.assertTrue(_wait(lambda: len(_room()) == 1), "socket never joined")
            n = api._WS_QUEUE_MAX * 4
            got = [0]

            def read() -> None:
                while got[0] < n:
                    c.recv(timeout=20)
                    got[0] += 1
            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            (ws,) = _room()
            self._flood(ws, n)
            reader.join(60)
            self.assertEqual(got[0], n, "the reading window lost frames")
            self.assertEqual(api.hub.drops, self.drops0, "a reading window was dropped")


async def _count_tasks() -> int:
    await asyncio.sleep(0.2)
    return len(asyncio.all_tasks())


if __name__ == "__main__":
    unittest.main()
