"""WS1 G5 host-level drills: the service_host bracket with the REAL
pg-custodian and either WS2's real store service (built from WS2's branch and
named by ORGTREE_P03_STORE_SERVICE) or, without it, a stub. Each drill reports
which one it ran against.

Not a ``test_*`` module on purpose: it starts real PostgreSQL clusters, so it
runs only explicitly, under the P03 run lock, via the safe runner:

    set ORGTREE_P03_CUSTODIAN=<abs path to pg-custodian.exe>
    set ORGTREE_P03_PG_BIN=<...>\\artifacts\\p03-postgresql\\18.6-4\\bin
    set ORGTREE_P03_SCHEMA_DIR=<a checkout of engine\\native\\store-schema>
    set ORGTREE_P03_STORE_SERVICE=<WS2 orgtree-store-service.exe>   (optional: else a stub)
    python tools/run-python-verification.py tests/p03_host_drill.py

Without those variables it FAILS (never skips): a drill that did not run is not
a drill result. Each drill prints one ``P03-WS1-DRILL {json}`` line.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine import p03_custodian as bracket

STUB_STORE = textwrap.dedent('''
    import json, os, sys
    root = sys.argv[sys.argv.index("--root") + 1]
    desc = os.path.join(root, "p03-store-service.json")
    open(desc, "w").write(json.dumps({"pid": os.getpid()}))
    print(json.dumps({"type": "ready", "pid": os.getpid(), "port": 1, "service_incarnation": "stub", "descriptor": desc}), flush=True)
    sys.stdin.read()
    os.remove(desc)
''')

HOST = textwrap.dedent('''
    import json, os, sys, time
    sys.path.insert(0, sys.argv[2])
    from engine import p03_custodian as bracket
    owned = bracket.start_for_host(__import__("pathlib").Path(sys.argv[1]), dict(os.environ))
    print(json.dumps({"action": owned.database["action"], "store_pid": owned.store.proc.pid}), flush=True)
    time.sleep(600)  # killed by the drill
''')


def report(drill: str, outcome: str, detail: dict) -> None:
    print("P03-WS1-DRILL " + json.dumps({"drill": drill, "outcome": outcome, "detail": detail}), flush=True)


def pid_alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return f'"{pid}"' in out


class HostDrills(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for name in (bracket.CUSTODIAN_ENV, "ORGTREE_P03_PG_BIN", bracket.SCHEMA_DIR_ENV):
            if not os.environ.get(name):
                raise AssertionError(f"{name} must be set: this drill never skips silently")
        cls.custodian = Path(os.environ[bracket.CUSTODIAN_ENV])
        cls.tmp = Path(tempfile.mkdtemp(prefix="orgtree-p03-hostdrill-"))
        real = os.environ.get(bracket.STORE_SERVICE_ENV, "").strip()
        if real:
            cls.store, cls.store_kind = Path(real), "WS2 orgtree-store-service (real)"
        else:
            cls.store, cls.store_kind = cls.tmp / "store_stub.py", "stub"
            cls.store.write_text(STUB_STORE)

    def custodian_json(self, *args: str) -> dict:
        out = subprocess.run([str(self.custodian), *args, "--pg-bin", os.environ["ORGTREE_P03_PG_BIN"]],
                             capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=900)
        return json.loads(out.stdout)

    def fresh_root(self, tag: str) -> Path:
        root = Path(tempfile.gettempdir()) / f"orgtree p03 hostdrill-{tag} {os.getpid()}-{time.monotonic_ns() % 100000}"
        r = self.custodian_json("init-root", "--root", str(root))
        self.assertTrue(r["ok"], r)
        return root

    def env(self) -> dict:
        return {**os.environ, bracket.STORE_SERVICE_ENV: str(self.store)}

    def test_first_launch_then_normal_shutdown(self) -> None:
        root = self.fresh_root("first")
        owned = bracket.start_for_host(root, self.env())
        self.assertEqual(owned.database["action"], "initialized+started")
        owned_migration = owned.migration.get("applied_now")
        self.assertTrue(owned_migration, "the first launch must migrate the fresh database")
        owned_ready = {k: owned.store.ready.get(k) for k in ("type", "pid", "port")}
        self.assertTrue((root / bracket.STORE_DESCRIPTOR).is_file())
        status = self.custodian_json("status", "--root", str(root))
        self.assertEqual(status["cluster"]["state"], "running")
        stopped = owned.stop()
        self.assertTrue(stopped["store_service_exited"])
        self.assertTrue(stopped["database_stop"]["ok"], stopped)
        self.assertEqual(self.custodian_json("status", "--root", str(root))["cluster"]["state"], "stopped")
        self.assertTrue(self.custodian_json("destroy", "--root", str(root))["ok"])
        report("first launch (host bracket, real custodian)", "passed",
               {"database": "initialized+started", "migrated": owned_migration, "store_service": self.store_kind,
                "store_ready": owned_ready, "reverse_stop": stopped})

    def test_abrupt_host_exit_then_the_next_host_attaches(self) -> None:
        root = self.fresh_root("abrupt")
        host_py = self.tmp / "host.py"
        host_py.write_text(HOST)
        repo = str(Path(bracket.__file__).resolve().parents[1])
        log = open(self.tmp / "host.log", "wb")
        proc = subprocess.Popen([sys.executable, str(host_py), str(root), repo], env=self.env(),
                                stdout=subprocess.PIPE, stderr=log, stdin=subprocess.DEVNULL)
        line = proc.stdout.readline()
        started = json.loads(line)
        self.assertEqual(started["action"], "initialized+started")
        store_pid = started["store_pid"]
        # The host dies abruptly: no bracket teardown runs.
        proc.kill()
        proc.wait(timeout=30)
        deadline = time.monotonic() + 30
        while pid_alive(store_pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        store_followed = not pid_alive(store_pid)
        self.assertTrue(store_followed, "the store service must exit when its host dies (stdin EOF)")
        self.assertFalse((root / bracket.STORE_DESCRIPTOR).exists())
        # The database outlives the host (an engine/host restart is not a database restart)...
        self.assertEqual(self.custodian_json("status", "--root", str(root))["cluster"]["state"], "running")
        # ...and the next host ATTACHES instead of starting a second instance.
        owned = bracket.start_for_host(root, self.env())
        self.assertEqual(owned.database["action"], "attached")
        self.assertEqual(owned.migration.get("applied_now"), [], "an attached, already-migrated database needs nothing")
        stopped = owned.stop()
        self.assertTrue(stopped["database_stop"]["ok"], stopped)
        self.assertTrue(self.custodian_json("destroy", "--root", str(root))["ok"])
        report("abrupt host exit, then background-host attach", "passed",
               {"store_service": self.store_kind, "store_service_followed_host": store_followed, "database_survived_host": True,
                "next_host": "attached (no second instance)", "next_host_migrated": []})


if __name__ == "__main__":
    unittest.main()
