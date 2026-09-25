"""engine/p03_custodian.py: the P03 host bracket, without a database.

Stub executables stand in for pg-custodian and the store service, and record
every call, so these tests prove ORDER and REFUSALS; the real database path
is exercised by the WS1 drills under the P03 run lock.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine import p03_custodian as bracket
from engine.p03_custodian import BracketError


STUB_CUSTODIAN = textwrap.dedent('''
    import json, os, sys
    log = os.environ["STUB_LOG"]
    state_file = os.environ["STUB_STATE"]
    args = sys.argv[1:]
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"who": "custodian", "args": args}) + "\\n")
    state = open(state_file, encoding="utf-8").read().strip()
    cmd = args[0]
    if cmd == "status":
        print(json.dumps({"ok": True, "cluster": {"state": state}}))
    elif cmd == "init":
        open(state_file, "w").write("stopped"); print(json.dumps({"ok": True}))
    elif cmd == "start":
        open(state_file, "w").write("running"); print(json.dumps({"ok": True}))
    elif cmd == "attach":
        if os.environ.get("STUB_ATTACH_FAILS"):
            print(json.dumps({"ok": False, "code": "identity.mismatch", "message": "stub"})); sys.exit(1)
        print(json.dumps({"ok": True, "runtime": {"port": 1}}))
    elif cmd == "migrate":
        if os.environ.get("STUB_MIGRATE_FAILS"):
            print(json.dumps({"ok": False, "code": "migrate.checksum_mismatch", "message": "stub"})); sys.exit(1)
        print(json.dumps({"ok": True, "migrate": {"applied_now": []}}))
    elif cmd == "stop":
        open(state_file, "w").write("stopped"); print(json.dumps({"ok": True, "stop": {}}))
''')

STUB_STORE = textwrap.dedent('''
    import json, os, sys
    root = sys.argv[sys.argv.index("--root") + 1]
    log = os.environ["STUB_LOG"]
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"who": "store", "event": "start"}) + "\\n")
    if os.environ.get("STUB_STORE_FAILS"):
        sys.stderr.write("stub store: refusing\\n"); sys.exit(3)
    desc = os.path.join(root, "p03-store-service.json")
    open(desc, "w").write("{}")
    pid = os.getpid() + (1 if os.environ.get("STUB_STORE_WRONG_PID") else 0)
    print(json.dumps({"type": "ready", "pid": pid, "port": 1, "service_incarnation": "x", "descriptor": desc}), flush=True)
    sys.stdin.read()  # exits on EOF, like the real service
    os.remove(desc)
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"who": "store", "event": "stdin-eof-exit"}) + "\\n")
''')


class BracketTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="orgtree-p03-bracket-"))
        self.root = self.tmp / "roots" / "proto"
        self.root.mkdir(parents=True)
        (self.tmp / "home" / "AppData" / "Roaming" / "Orgtree v2" / "data").mkdir(parents=True)
        self.log = self.tmp / "calls.jsonl"
        self.state = self.tmp / "state.txt"
        self.state.write_text("absent")
        stub_py = self.tmp / "stub_custodian.py"
        stub_py.write_text(STUB_CUSTODIAN)
        self.custodian = self.tmp / "pg-custodian.cmd"
        self.custodian.write_text(f'@"{sys.executable}" "{stub_py}" %*\r\n')
        self.store = self.tmp / "store_stub.py"
        self.store.write_text(STUB_STORE)
        home = self.tmp / "home"
        self.env = {
            "USERPROFILE": str(home),
            "APPDATA": str(home / "AppData" / "Roaming"),
            "ORGTREE_AGENT_PARENT_DATA": str(home / "AppData" / "Roaming" / "Orgtree v2" / "data"),
            "SystemRoot": os.environ.get("SystemRoot", r"C:\Windows"),
            "PATH": os.environ.get("PATH", ""),
            "STUB_LOG": str(self.log),
            "STUB_STATE": str(self.state),
            "ORGTREE_P03_SCHEMA_DIR": str(self.tmp),
        }

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def calls(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(l) for l in self.log.read_text(encoding="utf-8").splitlines() if l.strip()]

    def configured(self) -> dict:
        return {**self.env, bracket.CUSTODIAN_ENV: str(self.custodian), bracket.STORE_SERVICE_ENV: str(self.store)}

    def mark(self) -> None:
        (self.root / bracket.MARKER_FILE).write_text("{}")

    # -- when it acts

    def test_inert_on_an_ordinary_root(self) -> None:
        self.assertIsNone(bracket.start_for_host(self.root, self.env))
        self.assertEqual(self.calls(), [])

    def test_variables_without_a_marker_are_refused(self) -> None:
        with self.assertRaisesRegex(BracketError, "not a P03 prototype root"):
            bracket.start_for_host(self.root, self.configured())
        self.assertEqual(self.calls(), [], "nothing may run on an unmarked root")

    def test_a_marker_without_the_variables_is_refused(self) -> None:
        self.mark()
        with self.assertRaisesRegex(BracketError, bracket.CUSTODIAN_ENV):
            bracket.start_for_host(self.root, self.env)

    def test_relative_or_missing_executables_are_refused(self) -> None:
        self.mark()
        env = {**self.configured(), bracket.CUSTODIAN_ENV: "pg-custodian.exe"}
        with self.assertRaisesRegex(BracketError, "not an existing absolute file"):
            bracket.start_for_host(self.root, env)

    def test_a_root_inside_live_data_is_refused_before_anything_runs(self) -> None:
        live_root = Path(self.env["ORGTREE_AGENT_PARENT_DATA"]) / "proto"
        live_root.mkdir()
        (live_root / bracket.MARKER_FILE).write_text("{}")
        with self.assertRaisesRegex(BracketError, "overlaps protected location"):
            bracket.start_for_host(live_root, self.configured())
        self.assertEqual(self.calls(), [])

    def test_a_root_that_contains_live_data_is_refused(self) -> None:
        home = self.tmp / "home"
        (home / bracket.MARKER_FILE).write_text("{}")
        with self.assertRaisesRegex(BracketError, "overlaps protected location"):
            bracket.start_for_host(home, self.configured())
        self.assertEqual(self.calls(), [])

    def test_the_live_list_is_the_shared_file(self) -> None:
        spec = json.loads(bracket.LIVE_LOCATIONS.read_text(encoding="utf-8"))
        self.assertEqual(spec["schema"], "orgtree.p03.live-locations/v1")
        labels = [label for label, _ in bracket.live_locations(self.env)]
        self.assertIn("%APPDATA%\\Orgtree v2", labels)
        self.assertNotIn("ORGTREE_DATA", labels, "ORGTREE_DATA is the served root, judged by its marker")

    # -- order

    def test_first_launch_inits_starts_attaches_then_store_and_stops_in_reverse(self) -> None:
        self.mark()
        owned = bracket.start_for_host(self.root, self.configured())
        self.assertIsNotNone(owned)
        self.assertEqual(owned.database["action"], "initialized+started")
        self.assertTrue((self.root / bracket.STORE_DESCRIPTOR).is_file())
        report = owned.stop()
        self.assertTrue(report["store_service_exited"])
        self.assertTrue(report["database_stop"]["ok"])
        seq = [(c["who"], c.get("args", [c.get("event")])[0]) for c in self.calls()]
        self.assertEqual(seq, [("custodian", "status"), ("custodian", "init"), ("custodian", "start"),
                               ("custodian", "attach"), ("custodian", "migrate"), ("store", "start"), ("store", "stdin-eof-exit"),
                               ("custodian", "stop")])
        # The engine's token never reaches either child.
        self.assertFalse((self.root / bracket.STORE_DESCRIPTOR).exists())

    def test_a_running_database_is_attached_not_started_again(self) -> None:
        self.mark()
        self.state.write_text("running")
        owned = bracket.start_for_host(self.root, self.configured())
        self.assertEqual(owned.database["action"], "attached")
        owned.stop()
        cmds = [c["args"][0] for c in self.calls() if c["who"] == "custodian"]
        self.assertNotIn("start", cmds)
        self.assertNotIn("init", cmds)

    def test_a_failed_attach_refuses_and_starts_no_store_service(self) -> None:
        self.mark()
        self.state.write_text("running")
        env = {**self.configured(), "STUB_ATTACH_FAILS": "1"}
        with self.assertRaisesRegex(BracketError, "attach refused: identity.mismatch"):
            bracket.start_for_host(self.root, env)
        self.assertFalse(any(c["who"] == "store" for c in self.calls()))

    def test_a_store_service_that_never_gets_ready_takes_the_database_down(self) -> None:
        self.mark()
        env = {**self.configured(), "STUB_STORE_FAILS": "1"}
        with self.assertRaisesRegex(BracketError, "store service did not report ready"):
            bracket.start_for_host(self.root, env)
        cmds = [c["args"][0] for c in self.calls() if c["who"] == "custodian"]
        self.assertEqual(cmds[-1], "stop", "the database must be stopped when the bracket fails")

    def test_a_ready_line_from_another_pid_is_refused(self) -> None:
        self.mark()
        env = {**self.configured(), "STUB_STORE_WRONG_PID": "1"}
        with self.assertRaisesRegex(BracketError, "readiness is wrong"):
            bracket.start_for_host(self.root, env)
        cmds = [c["args"][0] for c in self.calls() if c["who"] == "custodian"]
        self.assertEqual(cmds[-1], "stop")

    def test_a_failed_migration_starts_no_store_service_and_stops_the_database(self) -> None:
        self.mark()
        env = {**self.configured(), "STUB_MIGRATE_FAILS": "1"}
        with self.assertRaisesRegex(BracketError, "migrate refused"):
            bracket.start_for_host(self.root, env)
        self.assertFalse(any(c["who"] == "store" for c in self.calls()))
        cmds = [c["args"][0] for c in self.calls() if c["who"] == "custodian"]
        self.assertEqual(cmds[-1], "stop")

    def test_no_schema_folder_is_a_refusal(self) -> None:
        self.mark()
        env = {**self.configured(), "ORGTREE_P03_SCHEMA_DIR": str(self.tmp / "nope")}
        with self.assertRaisesRegex(BracketError, "no store schema"):
            bracket.start_for_host(self.root, env)

    def test_the_engine_token_is_not_passed_on(self) -> None:
        self.mark()
        env = {**self.configured(), "ORGTREE_V2_TOKEN": "secret-token"}
        owned = bracket.start_for_host(self.root, env)
        self.assertNotIn("ORGTREE_V2_TOKEN", owned.env)
        owned.stop()


if __name__ == "__main__":
    unittest.main()
