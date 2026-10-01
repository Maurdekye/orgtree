"""The local org websocket does not negotiate permessage-deflate, and frames
still flow.

N1000 engprof (2026-09-28): compressing every org-websocket frame cost 0.083
cores on the already-starved event-loop thread, for a loopback connection
that gains nothing from it. Chromium always offers the extension, so the
server must decline it: `api.LOCAL_UVICORN_OPTIONS` sets
`ws_per_message_deflate=False`, and the desktop engine (engine/launch.py) and
`api.main` both build their local listener with it.

The REAL `api.app` websocket route is served on a real uvicorn server, and a
`websockets` client that OFFERS permessage-deflate (as Chromium does) connects.
What this proves:
  * with the production options no extension is negotiated, and a frame sent
    the way `api.stream` sends it arrives uncompressed and intact;
  * NEGATIVE CONTROL: the same server with uvicorn's default options DOES
    negotiate permessage-deflate for the same client, so the check can fail;
  * engine/launch.py passes LOCAL_UVICORN_OPTIONS to its uvicorn.Config.

Run:  python tools/run-python-verification.py tests/test_ws_no_deflate.py
"""
import ast
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix="orgtree-ws-deflate-")
os.environ["ORGTREE_DATA"] = _root.name
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import uvicorn  # noqa: E402
from websockets.sync.client import connect  # noqa: E402

from orgtree import api  # noqa: E402

SLUG = "wsdeflate"


class _Server:
    def __init__(self, **options) -> None:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        self.server = uvicorn.Server(uvicorn.Config(
            api.app, host="127.0.0.1", port=self.port, lifespan="off",
            access_log=False, log_level="warning", **options))
        self.loop = None
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

    def send(self, frame) -> None:
        asyncio.run_coroutine_threadsafe(api.hub._send(SLUG, frame), self.loop).result(10)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(10)


def _joined(timeout=10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if api.hub.rooms.get(SLUG):
            return True
        time.sleep(0.02)
    return False


class WsNoDeflate(unittest.TestCase):
    def roundtrip(self, **options):
        srv = _Server(**options)
        try:
            # compression="deflate" is the websockets default; stated so the
            # offer is explicit: this client asks for it, as Chromium does
            with connect(f"ws://127.0.0.1:{srv.port}/api/orgs/{SLUG}/ws",
                         compression="deflate", max_size=None) as c:
                negotiated = c.response.headers.get("Sec-WebSocket-Extensions")
                self.assertTrue(_joined(), "socket never joined the room")
                frame = {"type": "node_stream", "org": SLUG, "node": "n", "rev": 1,
                         "kind": "delta", "text": "hello " * 500}
                srv.send(frame)
                got = json.loads(c.recv(timeout=10))
                self.assertEqual(got, frame)
                return negotiated
        finally:
            srv.stop()

    def test_local_listener_declines_deflate_and_frames_flow(self) -> None:
        self.assertEqual(api.LOCAL_UVICORN_OPTIONS.get("ws_per_message_deflate"), False)
        self.assertIsNone(self.roundtrip(**api.LOCAL_UVICORN_OPTIONS))

    def test_negative_control_default_options_negotiate_deflate(self) -> None:
        negotiated = self.roundtrip()
        self.assertIsNotNone(negotiated)
        self.assertIn("permessage-deflate", negotiated)

    def test_desktop_launcher_uses_the_local_options(self) -> None:
        tree = ast.parse((REPO / "engine/launch.py").read_text(encoding="utf-8"))
        configs = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                   and ast.unparse(n.func) == "uvicorn.Config"]
        self.assertEqual(len(configs), 1, "expected the one desktop listener")
        spread = [ast.unparse(k.value) for k in configs[0].keywords if k.arg is None]
        self.assertEqual(spread, ["LOCAL_UVICORN_OPTIONS"])


if __name__ == "__main__":
    unittest.main()
