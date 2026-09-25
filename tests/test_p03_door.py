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
import subprocess
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


class SharedGuardRules(Base):
    """The hook uses WS1's shared list and rules (lead ruling 2026-09-25)."""

    def test_the_live_list_is_the_shared_json(self):
        spec = json.loads(p03_door.LIVE_LOCATIONS_FILE.read_text(encoding="utf-8"))
        self.assertEqual(spec["schema"], p03_door.LIVE_LOCATIONS_SCHEMA)
        env = dict(self.env, ORGTREE_AGENT_PARENT_DATA=str(self.base / "parent"),
                   ORGTREE_AGENT_LEGACY_DATA=str(self.base / "legacy"))
        labels = [label for label, _ in p03_door.live_locations(env)]
        want = [loc["label"] for loc in spec["locations"] if loc["unconditional"]]
        self.assertEqual(labels, want)
        self.assertGreaterEqual(len(labels), 7)

    def test_a_missing_list_fails_closed(self):
        proto = self.base / "proto"
        self.mark(proto)
        saved = p03_door.LIVE_LOCATIONS_FILE
        p03_door.LIVE_LOCATIONS_FILE = self.base / "nope.json"
        try:
            with self.assertRaises(p03_door.LiveRootRefused):
                self.install(proto, proto)
        finally:
            p03_door.LIVE_LOCATIONS_FILE = saved

    def test_a_junction_under_the_root_is_refused(self):
        proto = self.base / "proto"
        self.mark(proto)
        target = self.base / "elsewhere"
        target.mkdir()
        link = proto / "sub" / "j"
        link.parent.mkdir()
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, f"could not create the junction, so this control did not run: {r.stdout}{r.stderr}")
        with self.assertRaises(p03_door.LiveRootRefused):
            self.install(proto, proto)

    def test_forbidden_characters_are_refused(self):
        with self.assertRaises(p03_door.LiveRootRefused):
            p03_door.refuse_live(str(self.base / "bad|name"), self.env)


class NonDriveRefusal(Base):
    """Review N1, R1-R3: only absolute drive-letter paths (plain or ``\\\\?\\``)
    may name a prototype or data root, typed OR resolved, as WS1's Rust guard
    rules (Disk and VerbatimDisk prefixes only). An admin-share alias reaches
    the live folder under a name no prefix comparison sees."""

    def admin_share(self, p: Path, host: str) -> str:
        drive, rest = os.path.splitdrive(str(p))
        self.assertTrue(drive.endswith(":"), f"test folder {p} is not on a drive letter")
        return f"\\\\{host}\\{drive[0]}${rest}"

    def test_the_admin_share_alias_of_live_data_is_refused(self):
        live = self.base / "appdata" / "Orgtree v2" / "data"
        self.mark(live)
        for host in ("localhost", "127.0.0.1"):
            alias = self.admin_share(live, host)
            with self.subTest(alias=alias):
                with self.assertRaises(p03_door.LiveRootRefused):
                    self.install(alias, alias)

    def test_r2_a_non_drive_data_root_alone_is_refused(self):
        # the prototype root is benign and valid, so only the data-root check
        # can refuse (review R2: isolate it)
        proto = self.base / "proto"
        self.mark(proto)
        self.assertTrue(self.install(proto, proto)[0], "control: the benign pair installs")
        live = self.base / "appdata" / "Orgtree v2" / "data"
        live.mkdir(parents=True)
        for data in (self.admin_share(live, "localhost"), self.admin_share(proto, "127.0.0.1")):
            with self.subTest(data=data):
                with self.assertRaises(p03_door.LiveRootRefused):
                    self.install(proto, data)

    def test_r2_a_non_drive_prototype_root_alone_is_refused(self):
        proto = self.base / "proto"
        self.mark(proto)
        with self.assertRaises(p03_door.LiveRootRefused):
            self.install(self.admin_share(proto, "localhost"), proto)

    def test_r3_every_non_drive_form_is_refused(self):
        proto = self.base / "proto"
        self.mark(proto)
        drive, rest = os.path.splitdrive(str(proto))
        d = drive[0]
        for form in (
            self.admin_share(proto, "localhost"),
            "\\\\server\\share\\proto",
            "//localhost/" + d + "$" + rest.replace("\\", "/"),
            "\\\\?\\UNC\\localhost\\" + d + "$" + rest,
            "\\\\.\\" + str(proto),
            "\\\\?\\GLOBALROOT\\Device\\Mup\\localhost\\" + d + "$" + rest,
            "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3" + rest,
            "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}" + rest,
            "proto",  # relative
            "\\proto",  # rooted but driveless
        ):
            with self.subTest(form=form):
                with self.assertRaises(p03_door.LiveRootRefused):
                    p03_door.refuse_live(form, self.env)

    def test_r1_the_resolved_form_is_checked_too(self):
        # A drive-letter path that RESOLVES somewhere else (a symlink or mapped
        # drive to a share) must be refused through its resolved form alone.
        proto = self.base / "proto"
        self.mark(proto)
        to_share = lambda p: self.admin_share(Path(p), "localhost")
        with self.assertRaises(p03_door.LiveRootRefused):
            p03_door.refuse_non_drive(str(proto), resolve=to_share)
        with self.assertRaises(p03_door.LiveRootRefused):
            p03_door.refuse_non_drive(str(proto), resolve=lambda p: "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x")
        # control: the same path with an honest resolver passes
        p03_door.refuse_non_drive(str(proto), resolve=lambda p: str(p))
        p03_door.refuse_non_drive(str(proto))

    def test_a_verbatim_drive_path_is_still_accepted(self):
        proto = self.base / "proto"
        self.mark(proto)
        verbatim = "\\\\?\\" + str(proto)
        ok, app = self.install(verbatim, verbatim)
        self.assertTrue(ok, "a \\\\?\\C:\\ path is a drive-letter path")
        self.assertEqual(len(app.installed), 1)


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
