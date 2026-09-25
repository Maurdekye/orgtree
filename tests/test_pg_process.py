"""engine/pg_process.py: the engine's PostgreSQL bracket, without a database.

A stub executable stands in for pg-custodian and records every call, and a
fake migrator stands in for PG-0, so these tests prove ORDER, REFUSALS and the
connection handed to the engine; the real database path is exercised by
``tests/pg_process_drill.py`` under the P03 run lock.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine import pg_process as bracket
from engine.pg_process import BracketError


STUB_CUSTODIAN = textwrap.dedent('''
    import json, os, sys
    log = os.environ["STUB_LOG"]
    state_file = os.environ["STUB_STATE"]
    args = sys.argv[1:]
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"who": "custodian", "args": args,
                            "token": os.environ.get("ORGTREE_V2_TOKEN"),
                            "conninfo": os.environ.get("ORGTREE_PG_CONNINFO")}) + "\\n")
    state = open(state_file, encoding="utf-8").read().strip()
    cmd = args[0]
    if cmd == "status":
        print(json.dumps({"ok": True, "cluster": {"state": state}}))
    elif cmd == "init":
        open(state_file, "w").write("stopped"); print(json.dumps({"ok": True}))
    elif cmd == "start":
        if os.environ.get("STUB_START_FAILS"):
            print(json.dumps({"ok": False, "code": "start.low_memory", "message": "stub"})); sys.exit(1)
        open(state_file, "w").write("running"); print(json.dumps({"ok": True}))
    elif cmd == "attach":
        if os.environ.get("STUB_ATTACH_FAILS"):
            print(json.dumps({"ok": False, "code": "identity.mismatch", "message": "stub"})); sys.exit(1)
        rt = {"host": "127.0.0.1", "port": 45123, "admin_role": "orgtree_admin",
              "pgpass_file": os.environ["STUB_PGPASS"]}
        if os.environ.get("STUB_NO_ADMIN"):
            rt["admin_role"] = ""
        print(json.dumps({"ok": True, "runtime": rt}))
    elif cmd == "stop":
        open(state_file, "w").write("stopped"); print(json.dumps({"ok": True, "stop": {}}))
''')


class BracketTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="orgtree-pypg-bracket-"))
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
        self.migrations = self.tmp / "pg_migrations"
        self.migrations.mkdir()
        (self.migrations / "0001_init.sql").write_text("create table t (x int);\n")
        (self.migrations / "0002_more.sql").write_text("create table u (y int);\n")
        self.migrated: list[str] = []
        home = self.tmp / "home"
        self.env = {
            "USERPROFILE": str(home),
            "APPDATA": str(home / "AppData" / "Roaming"),
            "ORGTREE_AGENT_PARENT_DATA": str(home / "AppData" / "Roaming" / "Orgtree v2" / "data"),
            "SystemRoot": os.environ.get("SystemRoot", r"C:\Windows"),
            "PATH": os.environ.get("PATH", ""),
            "STUB_LOG": str(self.log),
            "STUB_STATE": str(self.state),
            "STUB_PGPASS": str(self.root / "pg" / "current" / "secrets" / "pgpass.conf"),
        }
        # No test may reach the real event log.
        patcher = mock.patch.object(bracket, "record_refusal", side_effect=self._refusal)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.refusals: list[str] = []

    def _refusal(self, reason: str, root: Path) -> bool:
        self.refusals.append(reason)
        return True

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def migrator(self, conninfo: str) -> dict:
        self.migrated.append(conninfo)
        return {"folder": str(self.migrations), "applied": [1, 2]}

    def calls(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(l) for l in self.log.read_text(encoding="utf-8").splitlines() if l.strip()]

    def cmds(self) -> list[str]:
        return [c["args"][0] for c in self.calls()]

    def configured(self, **extra: str) -> dict:
        return {**self.env, bracket.STORE_ENV: "postgres", bracket.CUSTODIAN_ENV: str(self.custodian), **extra}

    def mark(self, root: Path | None = None) -> None:
        ((root or self.root) / bracket.MARKER_FILE).write_text("{}")

    # -- when it acts

    def test_inert_unless_the_store_is_postgres(self) -> None:
        for store in (None, "sqlite", "json", ""):
            env = {**self.env, bracket.CUSTODIAN_ENV: str(self.custodian), bracket.CONNINFO_ENV: "stale"}
            if store is not None:
                env[bracket.STORE_ENV] = store
            self.assertIsNone(bracket.start_for_engine(self.root, env, self.migrator))
            self.assertNotIn(bracket.CONNINFO_ENV, env, "a parent's connection string must not leak into a non-postgres engine")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.refusals, [])

    def test_postgres_is_case_and_space_insensitive(self) -> None:
        self.mark()
        owned = bracket.start_for_engine(self.root, self.configured(ORGTREE_STORE=" Postgres "), self.migrator)
        self.assertIsNotNone(owned)
        owned.stop()

    def test_an_unmarked_root_is_refused_before_anything_runs(self) -> None:
        with self.assertRaisesRegex(BracketError, "neither a disposable prototype root"):
            bracket.start_for_engine(self.root, self.configured(), self.migrator)
        self.assertEqual(self.calls(), [])
        self.assertEqual(len(self.refusals), 1, "every refusal writes the event-log line")

    def test_a_missing_or_relative_custodian_is_refused(self) -> None:
        self.mark()
        for value in ("", "pg-custodian.exe", str(self.tmp / "nope.exe")):
            with self.assertRaisesRegex(BracketError, bracket.CUSTODIAN_ENV):
                bracket.start_for_engine(self.root, self.configured(ORGTREE_PG_CUSTODIAN=value), self.migrator)
        self.assertEqual(self.calls(), [])

    def test_a_root_inside_live_data_is_refused_before_anything_runs(self) -> None:
        live_root = Path(self.env["ORGTREE_AGENT_PARENT_DATA"]) / "proto"
        live_root.mkdir()
        self.mark(live_root)
        with self.assertRaisesRegex(BracketError, "overlaps protected location"):
            bracket.start_for_engine(live_root, self.configured(), self.migrator)
        self.assertEqual(self.calls(), [])

    def test_the_real_appdata_root_is_refused_even_with_a_marker(self) -> None:
        real = Path(self.env["APPDATA"]) / "Orgtree v2" / "data"
        self.mark(real)
        with self.assertRaisesRegex(BracketError, "overlaps protected location"):
            bracket.start_for_engine(real, self.configured(), self.migrator)
        self.assertEqual(self.calls(), [])

    def test_a_root_that_contains_live_data_is_refused(self) -> None:
        home = self.tmp / "home"
        self.mark(home)
        with self.assertRaisesRegex(BracketError, "overlaps protected location"):
            bracket.start_for_engine(home, self.configured(), self.migrator)
        self.assertEqual(self.calls(), [])

    def test_unc_and_device_roots_are_refused_without_being_touched(self) -> None:
        touched: list[Path] = []
        real_is_file = Path.is_file
        with mock.patch.object(Path, "is_file", autospec=True,
                               side_effect=lambda p: touched.append(p) or real_is_file(p)):
            for unc in (r"\\server\share\proto", r"\\?\UNC\server\share\p", r"\\.\C:\p", "//server/share/p"):
                with self.assertRaisesRegex(BracketError, "UNC and device"):
                    bracket.start_for_engine(Path(unc), self.configured(), self.migrator)
        self.assertEqual([p for p in touched if bracket.MARKER_FILE in str(p)], [],
                         "a UNC root must not even be checked for a marker")
        self.assertEqual(self.calls(), [])

    def test_the_live_list_is_the_shared_file(self) -> None:
        spec = json.loads(bracket.LIVE_LOCATIONS.read_text(encoding="utf-8"))
        self.assertEqual(spec["schema"], "orgtree.p03.live-locations/v1")
        labels = [label for label, _ in bracket.live_locations(self.env)]
        self.assertIn("%APPDATA%\\Orgtree v2", labels)
        self.assertNotIn("ORGTREE_DATA", labels, "ORGTREE_DATA is the served root, judged by its marker")

    # -- order and the connection

    def test_first_launch_inits_starts_attaches_migrates_and_stops(self) -> None:
        self.mark()
        env = self.configured(ORGTREE_V2_TOKEN="secret-token")
        owned = bracket.start_for_engine(self.root, env, self.migrator)
        self.assertEqual(owned.database["action"], "initialized+started")
        self.assertEqual(self.cmds(), ["status", "init", "start", "attach"])
        # Migrations ran once, as the ADMIN role, before the engine got its runtime connection.
        self.assertEqual(len(self.migrated), 1)
        self.assertIn("user=orgtree_admin", self.migrated[0])
        conn = env[bracket.CONNINFO_ENV]
        self.assertIn("user=orgtree_runtime", conn)
        self.assertIn("port=45123", conn)
        self.assertIn("dbname=orgtree", conn)
        self.assertIn("require_auth=scram-sha-256", conn)
        self.assertIn("passfile='" + self.env["STUB_PGPASS"].replace("\\", "\\\\") + "'", conn)
        self.assertNotIn("password", conn.lower())
        # The migration record names the folder and every file's checksum.
        self.assertEqual(owned.migration["folder"], str(self.migrations.resolve()))
        self.assertEqual(sorted(owned.migration["checksums"]), ["0001_init.sql", "0002_more.sql"])
        self.assertEqual(len(owned.migration["checksums"]["0001_init.sql"]), 64)
        # The engine's token never reaches the custodian.
        self.assertTrue(all(c["token"] is None for c in self.calls()))
        report = owned.stop()
        self.assertTrue(report["database_stop"]["ok"])
        self.assertEqual(self.cmds()[-1], "stop")
        self.assertEqual(owned.stop(), {}, "stop is idempotent")
        self.assertEqual(self.cmds().count("stop"), 1)

    def test_a_running_database_is_attached_not_started_again(self) -> None:
        self.mark()
        self.state.write_text("running")
        owned = bracket.start_for_engine(self.root, self.configured(), self.migrator)
        self.assertEqual(owned.database["action"], "attached")
        self.assertEqual(self.cmds(), ["status", "attach"])
        owned.stop()

    def test_a_stale_lock_is_started_not_attached(self) -> None:
        self.mark()
        self.state.write_text("stale_pid")
        owned = bracket.start_for_engine(self.root, self.configured(), self.migrator)
        self.assertEqual(owned.database["action"], "started")
        self.assertEqual(self.cmds(), ["status", "start", "attach"])
        owned.stop()

    def test_an_unidentified_holder_is_refused_and_nothing_is_signalled(self) -> None:
        self.mark()
        self.state.write_text("unidentified")
        with self.assertRaisesRegex(BracketError, "the database is unidentified"):
            bracket.start_for_engine(self.root, self.configured(), self.migrator)
        self.assertEqual(self.cmds(), ["status"])
        self.assertEqual(self.migrated, [])

    def test_a_failed_start_is_a_visible_refusal(self) -> None:
        self.mark()
        env = self.configured(STUB_START_FAILS="1")
        with self.assertRaisesRegex(BracketError, "start refused: start.low_memory"):
            bracket.start_for_engine(self.root, env, self.migrator)
        self.assertNotIn(bracket.CONNINFO_ENV, env)
        self.assertEqual(len(self.refusals), 1)
        self.assertIn("start.low_memory", self.refusals[0])

    def test_a_failed_attach_refuses_without_migrating(self) -> None:
        self.mark()
        self.state.write_text("running")
        env = self.configured(STUB_ATTACH_FAILS="1")
        with self.assertRaisesRegex(BracketError, "attach refused: identity.mismatch"):
            bracket.start_for_engine(self.root, env, self.migrator)
        self.assertEqual(self.migrated, [])
        self.assertNotIn(bracket.CONNINFO_ENV, env)

    def test_a_failed_migration_stops_the_database_and_gives_no_connection(self) -> None:
        self.mark()
        env = self.configured()

        def broken(conninfo: str) -> dict:
            raise RuntimeError("checksum mismatch in 0002")

        with self.assertRaisesRegex(BracketError, "migrations failed: RuntimeError: checksum mismatch"):
            bracket.start_for_engine(self.root, env, broken)
        self.assertEqual(self.cmds()[-1], "stop", "the database must be stopped when the bracket fails")
        self.assertNotIn(bracket.CONNINFO_ENV, env)

    def test_a_migration_report_without_its_folder_is_refused(self) -> None:
        self.mark()
        with self.assertRaisesRegex(BracketError, "names no existing folder"):
            bracket.start_for_engine(self.root, self.configured(), lambda c: {"applied": []})
        self.assertEqual(self.cmds()[-1], "stop")

    def test_no_admin_role_is_refused(self) -> None:
        self.mark()
        with self.assertRaisesRegex(BracketError, "no admin_role"):
            bracket.start_for_engine(self.root, self.configured(STUB_NO_ADMIN="1"), self.migrator)
        self.assertEqual(self.migrated, [])
        self.assertEqual(self.cmds()[-1], "stop")

    def test_without_pg0_the_default_migrator_refuses_rather_than_skips(self) -> None:
        self.mark()
        with mock.patch.dict(sys.modules, {"orgtree.pgstore": None}):
            with self.assertRaisesRegex(BracketError, "orgtree.pgstore"):
                bracket.start_for_engine(self.root, self.configured())
        self.assertEqual(self.cmds()[-1], "stop")

    def test_a_stale_parent_connection_is_not_passed_to_the_custodian(self) -> None:
        self.mark()
        env = self.configured(ORGTREE_PG_CONNINFO="host=elsewhere")
        owned = bracket.start_for_engine(self.root, env, self.migrator)
        self.assertTrue(all(c["conninfo"] is None for c in self.calls()))
        self.assertIn("port=45123", env[bracket.CONNINFO_ENV])
        owned.stop()


    # -- plan decision 18.1: ORGTREE_STORE, else <root>/store-backend.json,
    #    else SQLite; the engine's own root served only after the cutover

    def cutover(self, root: Path, backend: str = "postgres", **extra: object) -> None:
        record = {"schema": bracket.CUTOVER_SCHEMA, "backend": backend, **extra}
        (root / bracket.CUTOVER_FILE).write_text(json.dumps(record), encoding="utf-8")

    def unset_store(self, **extra: str) -> dict:
        env = self.configured(**extra)
        env.pop(bracket.STORE_ENV)
        return env

    # -- the choice

    def test_no_record_and_no_variable_is_sqlite_and_nothing_runs(self) -> None:
        self.mark()
        env = self.unset_store(ORGTREE_PG_CONNINFO="stale")
        self.assertIsNone(bracket.start_for_engine(self.root, env, self.migrator))
        self.assertEqual(self.calls(), [])
        self.assertNotIn(bracket.CONNINFO_ENV, env)
        self.assertNotIn(bracket.STORE_ENV, env)
        self.assertEqual(bracket.chosen_backend(self.root, env), "sqlite")

    def test_a_record_choosing_postgres_runs_the_bracket_and_tells_the_store(self) -> None:
        self.mark()
        self.cutover(self.root)
        env = self.unset_store()
        owned = bracket.start_for_engine(self.root, env, self.migrator)
        self.assertIsNotNone(owned)
        self.assertEqual(env[bracket.STORE_ENV], "postgres", "the store must follow the record")
        self.assertIn(bracket.CONNINFO_ENV, env)
        owned.stop()

    def test_a_record_choosing_sqlite_is_inert(self) -> None:
        self.mark()
        self.cutover(self.root, "sqlite")
        self.assertIsNone(bracket.start_for_engine(self.root, self.unset_store(), self.migrator))
        self.assertEqual(self.calls(), [])

    def test_the_variable_wins_over_the_record(self) -> None:
        self.mark()
        self.cutover(self.root)
        self.assertIsNone(bracket.start_for_engine(self.root, self.configured(ORGTREE_STORE="sqlite"), self.migrator))
        self.assertEqual(self.calls(), [])

    def test_a_record_that_is_not_ours_refuses_rather_than_guessing(self) -> None:
        self.mark()
        for text, why in (("{not json", "not valid JSON"),
                          (json.dumps({"backend": "postgres"}), "is not a orgtree.store-backend/v1"),
                          (json.dumps({"schema": bracket.CUTOVER_SCHEMA, "backend": "mysql"}), "unknown backend"),
                          ("[]", "is not a orgtree.store-backend/v1")):
            (self.root / bracket.CUTOVER_FILE).write_text(text, encoding="utf-8")
            with self.assertRaisesRegex(BracketError, why):
                bracket.start_for_engine(self.root, self.unset_store(), self.migrator)
        self.assertEqual(self.calls(), [])
        self.assertEqual(len(self.refusals), 4, "every refusal writes the event-log line")

    # -- product mode

    def product_root(self) -> tuple[Path, dict]:
        """The engine's own data root, in a non-agent environment, cut over
        and bound."""
        root = Path(self.env["APPDATA"]) / "Orgtree v2" / "data"
        self.cutover(root)
        (root / bracket.PRODUCT_FILE).write_text("{}", encoding="utf-8")
        env = self.unset_store(ORGTREE_DATA=str(root))
        env.pop("ORGTREE_AGENT_PARENT_DATA")
        return root, env

    def test_the_engines_own_root_is_served_in_product_mode_after_the_cutover(self) -> None:
        root, env = self.product_root()
        owned = bracket.start_for_engine(root, env, self.migrator)
        self.assertTrue(owned.product)
        self.assertEqual(self.cmds(), ["status", "init", "start", "attach"])
        self.assertTrue(all("--product" in c["args"] for c in self.calls()), self.calls())
        owned.stop()
        self.assertEqual(self.calls()[-1]["args"][:1] + self.calls()[-1]["args"][-1:], ["stop", "--product"])

    def test_a_prototype_root_is_never_run_with_product(self) -> None:
        self.mark()
        owned = bracket.start_for_engine(self.root, self.configured(), self.migrator)
        self.assertFalse(owned.product)
        owned.stop()
        self.assertTrue(all("--product" not in c["args"] for c in self.calls()))

    def test_the_engines_own_root_is_refused_without_a_cutover_record(self) -> None:
        root, env = self.product_root()
        (root / bracket.CUTOVER_FILE).unlink()
        env[bracket.STORE_ENV] = "postgres"
        with self.assertRaisesRegex(BracketError, "no cutover record choosing it"):
            bracket.start_for_engine(root, env, self.migrator)
        self.assertEqual(self.calls(), [])

    def test_the_engines_own_root_is_refused_without_the_binding(self) -> None:
        root, env = self.product_root()
        (root / bracket.PRODUCT_FILE).unlink()
        with self.assertRaisesRegex(BracketError, "no product binding"):
            bracket.start_for_engine(root, env, self.migrator)
        self.assertEqual(self.calls(), [])

    def test_product_mode_is_refused_in_an_agent_session(self) -> None:
        root, env = self.product_root()
        for var, value in (("ORGTREE_AGENT_PARENT_DATA", root), ("ORGTREE_AGENT_LEGACY_DATA", root.parent)):
            with self.assertRaisesRegex(BracketError, "overlaps protected location " + var):
                bracket.start_for_engine(root, {**env, var: str(value)}, self.migrator)
        self.assertEqual(self.calls(), [])

    def test_product_mode_is_refused_inside_the_installed_app(self) -> None:
        pf = self.tmp / "pf"
        root = pf / "Orgtree" / "data"
        root.mkdir(parents=True)
        self.cutover(root)
        (root / bracket.PRODUCT_FILE).write_text("{}", encoding="utf-8")
        env = self.unset_store(ORGTREE_DATA=str(root), ProgramFiles=str(pf))
        with self.assertRaisesRegex(BracketError, "overlaps protected location %ProgramFiles%"):
            bracket.start_for_engine(root, env, self.migrator)
        self.assertEqual(self.calls(), [])

    def test_a_cut_over_root_that_is_not_orgtree_data_is_refused(self) -> None:
        root, env = self.product_root()
        env["ORGTREE_DATA"] = str(self.root)
        with self.assertRaisesRegex(BracketError, "nor the engine's own ORGTREE_DATA"):
            bracket.start_for_engine(root, env, self.migrator)
        self.assertEqual(self.calls(), [])

    def test_the_deny_list_is_the_rust_guards(self) -> None:
        rust = (Path(bracket.__file__).resolve().parent / "native" / "prototype-guard" / "src" / "product.rs").read_text(encoding="utf-8")
        start = rust.index("pub const PRODUCT_DENY")
        body = rust[rust.index("[", rust.index("=", start)):rust.index("];", start)]
        labels = tuple(x.replace("\\\\", "\\") for x in __import__("re").findall(r'"((?:[^"\\]|\\.)*)"', body))
        self.assertEqual(labels, bracket.PRODUCT_DENY)


class RefusalLineTests(unittest.TestCase):
    def test_the_refusal_line_uses_the_shared_helper_and_never_raises(self) -> None:
        spec_module = bracket.REFUSAL_MODULE
        self.assertTrue(spec_module.is_file())
        import importlib.util
        spec = importlib.util.spec_from_file_location("_probe_refusal", spec_module)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        text = module.payload("p03_bracket", "no database", data_root="C:\\x", store="postgres")
        record = json.loads(text)
        self.assertEqual(record["schema"], "orgtree.p03.refusal/v1")
        self.assertEqual(record["component"], "p03_bracket")
        # A broken writer returns False; record_refusal never raises.
        with mock.patch.object(bracket, "REFUSAL_MODULE", Path("Z:/does/not/exist.py")):
            self.assertFalse(bracket.record_refusal("x", Path("C:/r")))

    def test_a_refusal_still_raises_when_the_event_log_write_fails(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="orgtree-pypg-refusal-"))
        try:
            env = {bracket.STORE_ENV: "postgres", "APPDATA": str(tmp / "a")}
            with mock.patch.object(bracket, "REFUSAL_MODULE", tmp / "missing.py"):
                with self.assertRaisesRegex(BracketError, "neither a disposable prototype root"):
                    bracket.start_for_engine(tmp, env)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class LaunchWiringTests(unittest.TestCase):
    """The bracket sits between root ownership and the API import, and the
    database is stopped at interpreter exit. Reads launch.py's source and
    calls its helper with the bracket stubbed; it boots no engine."""

    def test_launch_orders_lifetime_database_then_api(self) -> None:
        source = (Path(bracket.__file__).resolve().parent / "launch.py").read_text(encoding="utf-8")
        main = source[source.index("def main()"):source.index("def _own_database(")]
        lifetime = main.index("arm_process_lifetime(data")
        database = main.index("_own_database(data)")
        api = main.index("= load_app()")
        self.assertLess(lifetime, database)
        self.assertLess(database, api)

    def test_the_helper_registers_the_stop_and_is_inert_otherwise(self) -> None:
        import engine.launch as launch
        registered: list = []

        class Owned:
            def stop(self) -> dict:
                return {}

        owned = Owned()
        with mock.patch("atexit.register", side_effect=registered.append),              mock.patch("engine.pg_process.start_for_engine", return_value=owned) as started:
            launch._own_database(Path("C:/root"))
        self.assertEqual(registered, [owned.stop])
        self.assertEqual(started.call_args.args, (Path("C:/root"), os.environ))
        registered.clear()
        with mock.patch("atexit.register", side_effect=registered.append),              mock.patch("engine.pg_process.start_for_engine", return_value=None):
            launch._own_database(Path("C:/root"))
        self.assertEqual(registered, [], "nothing to stop when the store is not postgres")

    def test_a_refusal_propagates_out_of_the_helper(self) -> None:
        import engine.launch as launch
        with mock.patch("engine.pg_process.start_for_engine", side_effect=BracketError("no database")):
            with self.assertRaisesRegex(BracketError, "no database"):
                launch._own_database(Path("C:/root"))


if __name__ == "__main__":
    unittest.main()
