"""The P03 door hook (``engine/backend/orgtree/p03_door.py``): inert unless a
marked prototype root is set, and never installable on live data.

Every path is a fresh temporary folder, and the "live" locations come from an
explicit fake environment passed to the hook, so no test reads or touches the
real Orgtree data. The client test talks to an in-process fake store service.
"""
from __future__ import annotations

import json
import os
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import p03_door

REPO = Path(__file__).resolve().parents[1]


class FakeApp:
    """Records middleware registrations the way FastAPI's decorator does."""

    def __init__(self) -> None:
        self.installed: list[object] = []

    def middleware(self, kind: str):
        assert kind == "http"

        def deco(fn):
            self.installed.append(fn)
            return fn

        return deco


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="p03-door-")
        self.base = Path(self._tmp.name)
        self.env = {
            "APPDATA": str(self.base / "appdata"),
            "USERPROFILE": str(self.base / "home"),
            "LOCALAPPDATA": str(self.base / "local"),
            "ProgramFiles": str(self.base / "pf"),
        }

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def mark(self, root: Path, **over) -> None:
        root.mkdir(parents=True, exist_ok=True)
        m = {"schema": p03_door.MARKER_SCHEMA, "root_id": "0123456789abcdef0123456789abcdef",
             "root_path": p03_door._norm(root), "disposable": True, "created_at_unix": 1, "created_by": "test"}
        m.update(over)
        (root / p03_door.MARKER_FILE).write_text(json.dumps(m), encoding="utf-8")

    def install(self, proto, data) -> tuple[bool, FakeApp]:
        env = dict(self.env)
        if proto is not None:
            env[p03_door.ENV_VAR] = str(proto)
        app = FakeApp()
        return p03_door.install(app, data, env), app


class Inert(Base):
    def test_without_the_variable_nothing_is_installed(self):
        ok, app = self.install(None, self.base / "anything")
        self.assertFalse(ok)
        self.assertEqual(app.installed, [])

    def test_without_the_variable_even_live_data_is_left_alone(self):
        # production: the backend runs on live data and the hook is simply off
        live = self.base / "appdata" / "Orgtree v2" / "data"
        ok, app = self.install(None, live)
        self.assertFalse(ok)
        self.assertEqual(app.installed, [])

    def test_a_prototype_root_that_is_not_the_data_root_is_inert(self):
        proto = self.base / "proto"
        self.mark(proto)
        ok, app = self.install(proto, self.base / "other")
        self.assertFalse(ok)
        self.assertEqual(app.installed, [])

    def test_an_unmarked_or_mismarked_root_is_inert(self):
        proto = self.base / "proto"
        proto.mkdir()
        self.assertEqual(self.install(proto, proto)[0], False)
        for bad in ({"disposable": False}, {"schema": "x"}, {"root_id": "short"},
                    {"root_path": "c:\\somewhere\\else"}):
            self.mark(proto, **bad)
            ok, app = self.install(proto, proto)
            self.assertFalse(ok, bad)
            self.assertEqual(app.installed, [], bad)


class Active(Base):
    def test_all_conditions_install_the_router_once(self):
        proto = self.base / "proto"
        self.mark(proto)
        ok, app = self.install(proto, proto)
        self.assertTrue(ok)
        self.assertEqual(len(app.installed), 1)

    def test_the_slice_is_empty_at_m1(self):
        self.assertEqual(p03_door.SLICE_TOOLS, frozenset())


class LiveRootRefusal(Base):
    """Fails if the live-root check is removed (lead ruling on CONTRACT-M1 §9)."""

    def test_a_data_root_inside_live_data_raises_whatever_the_marker_says(self):
        live = self.base / "appdata" / "Orgtree v2" / "data"
        self.mark(live)  # a perfectly valid marker, written for this exact folder
        with self.assertRaises(p03_door.LiveRootRefused):
            self.install(live, live)

    def test_every_live_location_and_spelling_is_refused(self):
        for live in (
            self.base / "appdata" / "Orgtree v2" / "data" / "deep",
            self.base / "appdata" / "Orgtree v2.",
            self.base / "home" / "AppData" / "Roaming" / "Orgtree v2" / "data",
            self.base / "home" / "orgtree",
            self.base / "pf" / "Orgtree" / "resources",
            self.base / "local" / "Programs" / "Orgtree",
            self.base / "appdata",  # a root ABOVE live data
        ):
            with self.subTest(live=str(live)):
                with self.assertRaises(p03_door.LiveRootRefused):
                    self.install(live, live)

    def test_a_live_data_root_is_refused_even_when_the_prototype_root_is_elsewhere(self):
        proto = self.base / "proto"
        self.mark(proto)
        with self.assertRaises(p03_door.LiveRootRefused):
            self.install(proto, self.base / "appdata" / "Orgtree v2" / "data")


class ApiEdit(unittest.TestCase):
    def test_api_calls_install_exactly_once_with_the_data_root(self):
        src = (REPO / "engine" / "backend" / "orgtree" / "api.py").read_text(encoding="utf-8")
        self.assertEqual(src.count("p03_door.install("), 1)
        self.assertIn("p03_door.install(app, store.DATA_ROOT)", src)


class FakeStore(threading.Thread):
    """One connection of the store-service protocol, in-process."""

    def __init__(self, token: str, qualification: bool) -> None:
        super().__init__(daemon=True)
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.token, self.qualification = token, qualification
        self.seen: list[dict] = []

    def run(self) -> None:
        try:
            self._serve()
        finally:
            self.srv.close()

    def _serve(self) -> None:
        conn, _ = self.srv.accept()
        with conn:
            hello = p03_door._recv(conn)
            if hello.get("hello") != self.token:
                return
            p03_door._send(conn, {"handshake": {"protocol": p03_door.PROTOCOL, "qualification": self.qualification}})
            req = p03_door._recv(conn)
            self.seen.append(req)
            p03_door._send(conn, {"ok": True, "verb": req["verb"]})


class Client(Base):
    def descriptor(self, root: Path, port: int, token: str) -> None:
        (root / p03_door.DESCRIPTOR_FILE).write_text(json.dumps(
            {"schema": p03_door.DESCRIPTOR_SCHEMA, "root_id": "0" * 32, "port": port, "token": token,
             "pid": os.getpid(), "service_incarnation": "x", "qualification": False}), encoding="utf-8")

    def run_one(self, qualification: bool) -> dict:
        srv = FakeStore("t0ken", qualification)
        srv.start()
        root = self.base / "proto"
        root.mkdir(exist_ok=True)
        self.descriptor(root, srv.port, "t0ken")
        c = p03_door.StoreClient(root, timeout=5)
        r = c.call("ping", "00000000-0000-0000-0000-000000000000",
                   {"principal_kind": "agent", "principal": None, "generation": None, "acting": None, "key": None},
                   {}, op_tag="tag-1")
        c.close()
        srv.join(5)
        self.assertEqual(r, {"ok": True, "verb": "ping"})
        return srv.seen[0]

    def test_op_tag_is_forwarded_only_to_a_qualification_build(self):
        self.assertIsNone(self.run_one(False)["binding"]["op_tag"])
        self.assertEqual(self.run_one(True)["binding"]["op_tag"], "tag-1")

    def test_a_wrong_token_is_refused(self):
        srv = FakeStore("right", False)
        srv.start()
        root = self.base / "proto"
        root.mkdir()
        self.descriptor(root, srv.port, "wrong")
        with self.assertRaises(ConnectionError):
            p03_door.StoreClient(root, timeout=5)
        srv.join(5)


if __name__ == "__main__":
    unittest.main()
