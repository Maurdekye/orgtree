"""PYPG PG-1 drills: engine/pg_process.py with the REAL pg-custodian and a
real PostgreSQL, on disposable prototype roots under %TEMP%.

Not a ``test_*`` module on purpose: it starts real PostgreSQL clusters, so it
runs only explicitly, under the P03 run lock, via the safe runner:

    set ORGTREE_PG_CUSTODIAN=<abs path to pg-custodian.exe>
    set ORGTREE_P03_PG_BIN=<...>\\artifacts\\p03-postgresql\\18.6-4\\bin
    python tools/run-python-verification.py tests/pg_process_drill.py

Without those variables it FAILS (never skips): a drill that did not run is not
a drill result. Each drill prints one ``PYPG-PG1-DRILL {json}`` line.

MIGRATIONS. PG-0's ``orgtree.pgstore.migrate`` is not published yet, so the
drills pass a STAND-IN migrator that applies two SQL files through
``pg-custodian psql`` (admin role) and grants the runtime role. The bracket's
own contract (admin conninfo in, folder + applied out, checksums recorded) is
what is drilled; PG-0's migrations are not.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine import pg_process as bracket

MIGRATIONS = {
    "0001_drill.sql": "CREATE TABLE IF NOT EXISTS drill_rows (id bigserial PRIMARY KEY, note text NOT NULL);",
    "0002_grant.sql": "GRANT SELECT, INSERT ON drill_rows TO orgtree_runtime; GRANT USAGE ON SEQUENCE drill_rows_id_seq TO orgtree_runtime;",
}

# The engine stand-in: arms the REAL guardian Job (process_lifetime), then the
# bracket, exactly in launch.py's order; prints one line and waits to be killed.
ENGINE = textwrap.dedent('''
    import json, os, sys, time
    from pathlib import Path
    # This checkout's backend FIRST: the bundled runtime's ._pth would
    # otherwise supply the main checkout's (tests/import_provenance.py).
    sys.path.insert(0, sys.argv[3])
    sys.path.insert(0, sys.argv[2])
    sys.path.insert(0, os.path.join(sys.argv[2], "engine", "backend"))
    import pg_process_drill as drill
    from engine.process_lifetime import arm_process_lifetime
    from engine import pg_process as bracket
    root = Path(sys.argv[1])
    guardian = arm_process_lifetime(root)
    env = dict(os.environ)
    owned = bracket.start_for_engine(root, env, drill.StandIn(root))
    print(json.dumps({"action": owned.database["action"], "guardian": guardian,
                      "postmaster": owned.database["runtime"]["postmaster_pid"],
                      "conninfo": env[bracket.CONNINFO_ENV]}), flush=True)
    time.sleep(900)  # killed by the drill
''')


def report(drill: str, outcome: str, detail: dict) -> None:
    print("PYPG-PG1-DRILL " + json.dumps({"drill": drill, "outcome": outcome, "detail": detail}), flush=True)


def pid_alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return f'"{pid}"' in out


def custodian_json(*args: str) -> dict:
    out = subprocess.run([os.environ[bracket.CUSTODIAN_ENV], *args, "--pg-bin", os.environ["ORGTREE_P03_PG_BIN"]],
                         capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=900)
    return json.loads(out.stdout)


class StandIn:
    """The PG-0 stand-in (see the module docstring)."""

    def __init__(self, root: Path) -> None:
        self.folder = root / "drill-migrations"
        self.folder.mkdir(exist_ok=True)
        for name, sql in MIGRATIONS.items():
            (self.folder / name).write_text(sql + "\n", encoding="utf-8")
        self.root = root
        self.seen_conninfo = ""

    def __call__(self, conninfo: str) -> dict:
        self.seen_conninfo = conninfo
        applied = []
        for name in sorted(MIGRATIONS):
            r = custodian_json("psql", "--root", str(self.root), "--db", "orgtree", "--sql", MIGRATIONS[name])
            if not r.get("ok"):
                raise RuntimeError(f"stand-in migration {name} failed: {r.get('code')}: {r.get('message')}")
            applied.append(name)
        return {"folder": str(self.folder), "applied": applied, "stand_in": True}


def runtime_sql(conninfo: str, sql: str) -> str:
    """Connect exactly as the engine would: the runtime role, SCRAM, the passfile."""
    psql = Path(os.environ["ORGTREE_P03_PG_BIN"]) / "psql.exe"
    out = subprocess.run([str(psql), conninfo, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
                         capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60,
                         env={k: v for k, v in os.environ.items() if not k.startswith("PG")})
    if out.returncode != 0:
        raise AssertionError(f"runtime connection failed: {out.stderr.strip()}")
    return out.stdout.strip()


class Drills(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for name in (bracket.CUSTODIAN_ENV, "ORGTREE_P03_PG_BIN"):
            if not os.environ.get(name):
                raise AssertionError(f"{name} must be set: this drill never skips silently")
        cls.tmp = Path(tempfile.mkdtemp(prefix="orgtree-pypg-drill-"))
        cls.roots: list[Path] = []

    @classmethod
    def tearDownClass(cls) -> None:
        for root in cls.roots:
            for args in (("stop", "--root", str(root), "--immediate"), ("destroy", "--root", str(root))):
                try:
                    custodian_json(*args)
                except Exception:  # noqa: BLE001  best-effort cleanup of a disposable root
                    pass
            shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh_root(self, tag: str) -> Path:
        root = Path(tempfile.gettempdir()) / f"orgtree-p03-pg1-{tag}-{os.getpid()}-{time.monotonic_ns() % 100000}"
        r = custodian_json("init-root", "--root", str(root))
        self.assertTrue(r["ok"], r)
        self.roots.append(root)
        return root

    def env(self) -> dict:
        return {**os.environ, bracket.STORE_ENV: "postgres"}

    def test_first_launch_then_normal_shutdown(self) -> None:
        root = self.fresh_root("first")
        env = self.env()
        stand_in = StandIn(root)
        owned = bracket.start_for_engine(root, env, stand_in)
        self.assertEqual(owned.database["action"], "initialized+started")
        self.assertIn("user=orgtree_admin", stand_in.seen_conninfo)
        conn = env[bracket.CONNINFO_ENV]
        self.assertNotIn("password", conn.lower())
        who = runtime_sql(conn, "INSERT INTO drill_rows(note) VALUES ('first') RETURNING current_user")
        self.assertEqual(who, "orgtree_runtime")
        self.assertEqual(custodian_json("status", "--root", str(root))["cluster"]["state"], "running")
        stopped = owned.stop()
        self.assertTrue(stopped["database_stop"]["ok"], stopped)
        self.assertEqual(custodian_json("status", "--root", str(root))["cluster"]["state"], "stopped")
        # Second launch: start (not init), migrations re-run idempotently, data kept.
        env2 = self.env()
        again = bracket.start_for_engine(root, env2, StandIn(root))
        self.assertEqual(again.database["action"], "started")
        rows = runtime_sql(env2[bracket.CONNINFO_ENV], "SELECT count(*) FROM drill_rows")
        again.stop()
        report("first launch, normal shutdown, relaunch", "passed",
               {"first": "initialized+started", "runtime_role_connected": who, "relaunch": "started",
                "rows_after_relaunch": int(rows), "migration": {"folder": owned.migration["folder"],
                                                                "checksums": owned.migration["checksums"],
                                                                "stand_in": True},
                "stop": stopped})
        self.assertEqual(int(rows), 1)

    def test_forced_engine_kill_takes_the_database_then_the_next_launch_recovers(self) -> None:
        root = self.fresh_root("abrupt")
        host = self.tmp / "engine_standin.py"
        host.write_text(ENGINE, encoding="utf-8")
        repo = str(Path(bracket.__file__).resolve().parents[1])
        tests = str(Path(__file__).resolve().parent)
        log = open(self.tmp / "engine.log", "wb")
        proc = subprocess.Popen([sys.executable, str(host), str(root), repo, tests], env=self.env(),
                                stdout=subprocess.PIPE, stderr=log, stdin=subprocess.DEVNULL)
        try:
            line = proc.stdout.readline()
            if not line:
                log.close()
                raise AssertionError("engine stand-in died: " + (self.tmp / "engine.log").read_text(errors="replace")[-3000:])
            started = json.loads(line)
            self.assertEqual(started["action"], "initialized+started")
            runtime_sql(started["conninfo"], "INSERT INTO drill_rows(note) VALUES ('before the kill')")
            postmaster = started["postmaster"]
            self.assertTrue(pid_alive(postmaster))
            # A FORCED engine kill: no finally runs. The guardian closes its Job.
            proc.kill()
            proc.wait(timeout=30)
        finally:
            log.close()
        deadline = time.monotonic() + 60
        while pid_alive(postmaster) and time.monotonic() < deadline:
            time.sleep(0.25)
        postmaster_followed = not pid_alive(postmaster)
        state_after_kill = custodian_json("status", "--root", str(root))["cluster"]["state"]
        # The next launch must bring it back WITH the committed row.
        env = self.env()
        owned = bracket.start_for_engine(root, env, StandIn(root))
        action = owned.database["action"]
        rows = runtime_sql(env[bracket.CONNINFO_ENV], "SELECT count(*) FROM drill_rows")
        stopped = owned.stop()
        report("forced engine kill, then relaunch", "passed" if postmaster_followed and int(rows) == 1 else "failed",
               {"postmaster_killed_with_engine_job": postmaster_followed, "state_after_kill": state_after_kill,
                "relaunch": action, "committed_rows_after_recovery": int(rows), "stop": stopped})
        self.assertTrue(postmaster_followed, "the database runs in the engine's Job and must not outlive a forced kill")
        self.assertIn(state_after_kill, ("stale_pid", "stopped"))
        self.assertEqual(action, "started")
        self.assertEqual(int(rows), 1, "a committed row must survive the crash")
        self.assertTrue(stopped["database_stop"]["ok"], stopped)

    def test_a_database_still_running_is_attached_not_duplicated(self) -> None:
        root = self.fresh_root("attach")
        env = self.env()
        first = bracket.start_for_engine(root, env, StandIn(root))
        pm = first.database["runtime"]["postmaster_pid"]
        # Simulate an engine that vanished without stopping it (no Job here).
        first.database = None
        env2 = self.env()
        second = bracket.start_for_engine(root, env2, StandIn(root))
        self.assertEqual(second.database["action"], "attached")
        self.assertEqual(second.database["runtime"]["postmaster_pid"], pm)
        self.assertEqual(runtime_sql(env2[bracket.CONNINFO_ENV], "SELECT 1"), "1")
        stopped = second.stop()
        self.assertTrue(stopped["database_stop"]["ok"], stopped)
        report("database left running, next launch attaches", "passed",
               {"action": "attached", "same_postmaster": True, "stop": stopped})


if __name__ == "__main__":
    unittest.main()
