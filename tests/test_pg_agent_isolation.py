"""PG-1 review B1 / plan decision 35: the engine's live database never reaches
an agent.

After a cutover the engine runs with ORGTREE_STORE=postgres and
ORGTREE_PG_CONNINFO (its runtime role, passfile inside the live data root) in
its own environment. Two guards keep that away from agents, their tests and
their probes:

1. ``devguard.child_env`` - which every agent/shell spawn goes through
   (``supervisor.clean_env``, ``codexrun.child_env``) - drops the store
   variables and libpq's PG* variables.
2. ``pgstore.connect`` refuses, in an agent context, a connection aimed at
   the live data root's own cluster (its passfile, or its recorded port).

No database is contacted: the connection itself is replaced by a recorder.

    ORGTREE_TEST_PYDEPS   a folder holding psycopg (guard 2 parses conninfo
                          with libpq's rules); without it those tests skip
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

DEPS = os.environ.get("ORGTREE_TEST_PYDEPS", "").strip()
if DEPS:
    sys.path.insert(0, DEPS)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import devguard  # noqa: E402

try:
    import psycopg  # noqa: F401
    HAVE_PSYCOPG = True
except ImportError:
    HAVE_PSYCOPG = False

#: Decision 35's list, written out here so a name dropped from the module's
#: tuple fails this test rather than silently leaking.
REQUIRED = ("ORGTREE_STORE", "ORGTREE_PG_CONNINFO", "ORGTREE_PG_URL", "PGHOST", "PGPORT",
            "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGSERVICE")
LIVE_CONNINFO = ("host=127.0.0.1 port=59999 dbname=orgtree user=orgtree_runtime "
                 "passfile='C:\\\\LIVE\\\\pg\\\\cluster\\\\secrets\\\\pgpass.conf' require_auth=scram-sha-256")


def _engine_env(**extra: str) -> dict[str, str]:
    env = {k: f"engine-{k}" for k in REQUIRED}
    env["ORGTREE_PG_CONNINFO"] = LIVE_CONNINFO
    env.update(extra)
    return env


class SpawnEnvironmentTests(unittest.TestCase):
    def test_the_list_is_decision_35s(self) -> None:
        self.assertEqual(set(devguard.ENGINE_STORE_VARS), set(REQUIRED))

    def test_child_env_drops_every_engine_database_variable(self) -> None:
        child = devguard.child_env({**_engine_env(), "KEEP": "1"}, parent={})
        for key in REQUIRED:
            self.assertNotIn(key, child, key)
        self.assertEqual(child["KEEP"], "1", "nothing else is dropped")

    def test_child_env_drops_them_for_desktop_children_too(self) -> None:
        parent = {"ORGTREE_DESKTOP_MANAGED": "1", "ORGTREE_DATA": tempfile.gettempdir()}
        child = devguard.child_env(_engine_env(), parent=parent)
        self.assertFalse(set(REQUIRED) & set(child))
        self.assertIn(devguard.LIVE, child, "the agent tag is still added")

    def test_an_agent_spawned_by_the_supervisor_gets_none_of_them(self) -> None:
        from orgtree import supervisor
        with mock.patch.dict(os.environ, _engine_env()):
            env = supervisor.clean_env()
        self.assertFalse(set(REQUIRED) & set(env), sorted(set(REQUIRED) & set(env)))

    def test_a_codex_child_gets_none_of_them(self) -> None:
        from orgtree import codexrun
        with mock.patch.dict(os.environ, _engine_env()):
            env = codexrun.child_env(None, None)
        self.assertFalse(set(REQUIRED) & set(env), sorted(set(REQUIRED) & set(env)))


@unittest.skipUnless(HAVE_PSYCOPG, "needs psycopg (set ORGTREE_TEST_PYDEPS)")
class LiveClusterRefusalTests(unittest.TestCase):
    def setUp(self) -> None:
        from orgtree import pgstore
        self.pgstore = pgstore
        self.tmp = Path(tempfile.mkdtemp(prefix="orgtree-pg-isolation-"))
        self.live = self.tmp / "live"
        (self.live / "pg" / "cluster").mkdir(parents=True)
        (self.live / "pg" / "cluster" / "runtime.json").write_text(
            json.dumps({"host": "127.0.0.1", "port": 59999}), encoding="utf-8")
        self.passfile = self.live / "pg" / "cluster" / "secrets" / "pgpass.conf"
        self.opened: list[str] = []
        fake = mock.Mock()
        fake.connect.side_effect = lambda target, autocommit: self.opened.append(target) or "conn"
        patcher = mock.patch.object(pgstore, "_psycopg", return_value=fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def agent(self, **extra: str) -> dict[str, str]:
        clean = {k: v for k, v in os.environ.items() if k not in REQUIRED and k not in (devguard.LIVE, devguard.LEGACY)}
        return {**clean, devguard.LIVE: str(self.live), **extra}

    def conninfo(self, port: int = 59999, passfile: Path | None = None, host: str = "127.0.0.1") -> str:
        pf = str(passfile or self.passfile).replace("\\", "\\\\")
        return f"host={host} port={port} dbname=orgtree user=orgtree_runtime passfile='{pf}'"

    def test_the_live_passfile_is_refused_from_an_agent(self) -> None:
        with mock.patch.dict(os.environ, self.agent(), clear=True):
            with self.assertRaisesRegex(self.pgstore.LiveClusterRefused, "belongs to the live data root"):
                self.pgstore.connect(self.conninfo(port=41000))
        self.assertEqual(self.opened, [], "nothing was opened")

    def test_the_live_port_is_refused_from_an_agent(self) -> None:
        other = self.tmp / "mine" / "pgpass.conf"
        with mock.patch.dict(os.environ, self.agent(), clear=True):
            for host in ("127.0.0.1", "localhost", "::1"):
                with self.assertRaisesRegex(self.pgstore.LiveClusterRefused, "port 59999"):
                    self.pgstore.connect(self.conninfo(passfile=other, host=host))
            with self.assertRaisesRegex(self.pgstore.LiveClusterRefused, "port 59999"):
                self.pgstore.connect("postgresql://dev:pw@localhost:59999/orgtree")
        self.assertEqual(self.opened, [])

    def test_a_leaked_engine_conninfo_is_refused_through_url(self) -> None:
        env = self.agent(ORGTREE_STORE="postgres", ORGTREE_PG_CONNINFO=self.conninfo())
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(self.pgstore.LiveClusterRefused):
                self.pgstore.connect()
        self.assertEqual(self.opened, [])

    def test_the_legacy_variable_counts_as_an_agent_context(self) -> None:
        env = self.agent()
        env[devguard.LEGACY] = env.pop(devguard.LIVE)
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(self.pgstore.LiveClusterRefused):
                self.pgstore.connect(self.conninfo())

    def test_an_agents_own_database_is_allowed(self) -> None:
        mine = self.tmp / "mine" / "pg" / "cluster" / "secrets" / "pgpass.conf"
        with mock.patch.dict(os.environ, self.agent(), clear=True):
            self.assertEqual(self.pgstore.connect(self.conninfo(port=41000, passfile=mine)), "conn")
            # same port number, but not on this machine's loopback
            self.assertEqual(self.pgstore.connect(self.conninfo(port=59999, passfile=mine, host="10.0.0.5")), "conn")
        self.assertEqual(len(self.opened), 2)

    def test_the_engine_itself_is_not_an_agent(self) -> None:
        clean = {k: v for k, v in os.environ.items() if k not in (devguard.LIVE, devguard.LEGACY)}
        with mock.patch.dict(os.environ, clean, clear=True):
            self.assertEqual(self.pgstore.connect(self.conninfo()), "conn")
        self.assertEqual(self.opened, [self.conninfo()])


if __name__ == "__main__":
    unittest.main()
