"""The local listener keeps idle HTTP connections open for 30 s, not 5 s.

uvicorn closes an idle keep-alive connection after 5 s by default. A client
that also expires idle connections at 5 s can reuse the connection at the
same moment the server closes it, and the request fails with WinError 10054
(measured by n1-review-astra under GIL load). The desktop's undici expires at
4 s, a thin margin. `api.LOCAL_UVICORN_OPTIONS` sets `timeout_keep_alive=30`,
and engine/launch.py and `api.main` build the local listener with it
(tests/test_ws_no_deflate.py checks that launch.py passes the options).

What this proves, on a real uvicorn server:
  * uvicorn.Config built with the production options carries the 30 s value;
  * a connection left idle for 6 s still answers a second request;
  * NEGATIVE CONTROL: with uvicorn's default options the server has closed
    the same idle connection by then, so the check can fail.

Run:  python tools/run-python-verification.py tests/test_local_keepalive.py
"""
import asyncio
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix="orgtree-keepalive-")
os.environ["ORGTREE_DATA"] = _root.name
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import uvicorn  # noqa: E402

from orgtree import api  # noqa: E402

IDLE_S = 6  # past uvicorn's 5 s default, well inside 30 s
REQUEST = b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"


async def _ok(scope, receive, send) -> None:
    if scope["type"] != "http":
        return
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-length", b"2")]})
    await send({"type": "http.response.body", "body": b"ok"})


class _Server:
    def __init__(self, **options) -> None:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        # only the keep-alive option matters here; a tiny app keeps the
        # timing free of the real app's work
        self.server = uvicorn.Server(uvicorn.Config(
            _ok, host="127.0.0.1", port=self.port, lifespan="off",
            access_log=False, log_level="warning", **options))
        self.thread = threading.Thread(
            target=lambda: asyncio.run(self.server.serve()), daemon=True)
        self.thread.start()
        deadline = time.time() + 20
        while not self.server.started:
            if time.time() > deadline:
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.02)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(10)


def _read_response(c: socket.socket) -> bytes:
    data = b""
    while not data.endswith(b"ok"):
        chunk = c.recv(4096)
        if not chunk:
            break
        data += chunk
    return data


class LocalKeepAlive(unittest.TestCase):
    def reused_after_idle(self, **options) -> bool:
        """True when a second request on the same connection, sent after
        IDLE_S seconds of silence, gets an answer."""
        srv = _Server(**options)
        try:
            with socket.create_connection(("127.0.0.1", srv.port), timeout=10) as c:
                c.sendall(REQUEST)
                self.assertTrue(_read_response(c).startswith(b"HTTP/1.1 200"))
                time.sleep(IDLE_S)
                try:
                    c.sendall(REQUEST)
                    return _read_response(c).startswith(b"HTTP/1.1 200")
                except OSError:  # reset by the server that already closed
                    return False
        finally:
            srv.stop()

    def test_option_is_set_and_uvicorn_takes_it(self) -> None:
        self.assertEqual(api.LOCAL_UVICORN_OPTIONS.get("timeout_keep_alive"), 30)
        config = uvicorn.Config(_ok, **api.LOCAL_UVICORN_OPTIONS)
        self.assertEqual(config.timeout_keep_alive, 30)
        self.assertEqual(uvicorn.Config(_ok).timeout_keep_alive, 5,
                         "uvicorn's default changed; revisit the reason for 30")

    def test_local_listener_keeps_an_idle_connection(self) -> None:
        self.assertTrue(self.reused_after_idle(**api.LOCAL_UVICORN_OPTIONS))

    def test_negative_control_default_closes_the_idle_connection(self) -> None:
        self.assertFalse(self.reused_after_idle())


if __name__ == "__main__":
    unittest.main()
