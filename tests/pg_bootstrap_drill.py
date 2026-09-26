"""PYPG PG-1 bootstrap drills: a FRESH root under ``ORGTREE_PG_BOOTSTRAP=1``
with the REAL pg-custodian, a real PostgreSQL, PG-0's real migrations and the
real store, on disposable product roots under %TEMP%.

Not a ``test_*`` module on purpose: it starts real PostgreSQL clusters, so it
runs only explicitly, under the P03 run lock, via the safe runner:

    set ORGTREE_PG_CUSTODIAN=<abs path to pg-custodian.exe>
    set ORGTREE_P03_PG_BIN=<...>\\artifacts\\p03-postgresql\\18.6-4\\bin
    set ORGTREE_TEST_PYDEPS=<folder holding psycopg>
    python tools/run-python-verification.py tests/pg_bootstrap_drill.py

Without those variables it FAILS (never skips). Each drill prints one
``PYPG-PG1-BOOT-DRILL {json}`` line.
"""

from __future__ import annotations

import hashlib
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

DEPS = os.environ.get("ORGTREE_TEST_PYDEPS", "").strip()
if DEPS:
    sys.path.insert(0, DEPS)

REPO = Path(__file__).resolve().parents[1]
from engine import pg_process as bracket  # noqa: E402

# The store as the ENGINE uses it, in a fresh process: create one org, then
# list and load it back.
ENGINE_STORE = textwrap.dedent('''
    import json, os, sys
    sys.path[:0] = [sys.argv[1], os.path.join(sys.argv[2], "engine", "backend"), sys.argv[2]]
    from orgtree import store
    store.claim_data_root()
    made = sys.argv[3]
    if made:
        store.create_org(made)
    slugs = sorted(o["slug"] for o in store.list_orgs())
    print(json.dumps({"backend": store.STORE_BACKEND, "store_file": store.__file__, "slugs": slugs,
                      "names": {s: store.load_org(s).d["name"] for s in slugs}}))
''')


def report(drill: str, outcome: str, detail: dict) -> None:
    print("PYPG-PG1-BOOT-DRILL " + json.dumps({"drill": drill, "outcome": outcome, "detail": detail}, default=str),
          flush=True)


def custodian_json(*args: str, env: dict) -> dict:
    out = subprocess.run([os.environ[bracket.CUSTODIAN_ENV], *args], capture_output=True, text=True,
                         stdin=subprocess.DEVNULL, timeout=900, env=env)
    return json.loads(out.stdout)


def digest(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): (hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else "dir")
            for p in sorted(root.rglob("*"))}


class Drills(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for name in (bracket.CUSTODIAN_ENV, "ORGTREE_P03_PG_BIN", "ORGTREE_TEST_PYDEPS"):
            if not os.environ.get(name):
                raise AssertionError(f"{name} must be set: this drill never skips silently")
        import psycopg  # noqa: F401  proves the dependency is really there
        cls.cleanup: list[tuple[Path, dict]] = []

    @classmethod
    def tearDownClass(cls) -> None:
        for root, env in cls.cleanup:
            try:
                custodian_json("stop", "--root", str(root), "--immediate", "--product", env=env)
            except Exception:  # noqa: BLE001  best-effort cleanup of a disposable root
                pass
            shutil.rmtree(root.parent, ignore_errors=True)

    def product_root(self, tag: str) -> tuple[Path, dict]:
        """A new engine data root and the environment the PACKAGED desktop
        gives the engine: ORGTREE_DATA = the root, the bootstrap switch on,
        no ORGTREE_STORE."""
        base = Path(tempfile.mkdtemp(prefix=f"orgtree-pg1-boot-{tag}-"))
        root = base / "data"
        root.mkdir()
        env = {k: v for k, v in os.environ.items() if k not in (bracket.STORE_ENV, bracket.CONNINFO_ENV)}
        env.update({"ORGTREE_DATA": str(root), bracket.BOOTSTRAP_ENV: "1"})
        self.cleanup.append((root, env))
        return root, env

    def engine_store(self, root: Path, env: dict, make: str = "") -> dict:
        tmp = Path(tempfile.mkdtemp(prefix="orgtree-pg1-boot-engine-"))
        try:
            script = tmp / "engine_store.py"
            script.write_text(ENGINE_STORE, encoding="utf-8")
            out = subprocess.run([sys.executable, str(script), DEPS, str(REPO), make], capture_output=True,
                                 text=True, env=env, timeout=300, stdin=subprocess.DEVNULL)
            if out.returncode != 0:
                raise AssertionError(f"engine store failed ({env.get(bracket.STORE_ENV)}): {out.stderr[-3000:]}")
            return json.loads(out.stdout.strip().splitlines()[-1])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_fresh_root_starts_on_postgres_and_stays_there(self) -> None:
        root, env = self.product_root("fresh")
        owned = bracket.start_for_engine(root, env)
        try:
            record = json.loads((root / bracket.CUTOVER_FILE).read_text(encoding="utf-8"))
            self.assertEqual((record["backend"], record["via"]), ("postgres", "fresh-bootstrap"))
            self.assertTrue(owned.product)
            self.assertEqual(owned.database["action"], "initialized+started")
            self.assertEqual(env[bracket.STORE_ENV], "postgres")
            self.assertEqual(sorted(owned.migration["checksums"]), ["0001_base.sql", "0002_runtime_grants.sql"])
            made = self.engine_store(root, env, "Fresh Drill")
            self.assertEqual(made["backend"], "postgres")
            self.assertTrue(Path(made["store_file"]).resolve().is_relative_to(REPO), made["store_file"])
            self.assertEqual(made["names"], {"fresh-drill": "Fresh Drill"})
            orgs = sorted(p.name for p in (root / "orgs").iterdir())
            self.assertEqual(orgs, ["fresh-drill.pg"], "the org lives in PostgreSQL, not in a SQLite file")
        finally:
            stopped = owned.stop()
        binding = (root / bracket.PRODUCT_FILE).read_bytes()
        record_bytes = (root / bracket.CUTOVER_FILE).read_bytes()
        # the next launch: the ordinary postgres path, same binding, same record, org still there
        env2 = {k: v for k, v in env.items() if k not in (bracket.STORE_ENV, bracket.CONNINFO_ENV)}
        again = bracket.start_for_engine(root, env2)
        try:
            self.assertEqual(again.database["action"], "started")
            self.assertEqual(again.migration["applied"], [])
            self.assertEqual((root / bracket.PRODUCT_FILE).read_bytes(), binding)
            self.assertEqual((root / bracket.CUTOVER_FILE).read_bytes(), record_bytes)
            back = self.engine_store(root, env2)
        finally:
            again.stop()
        self.assertEqual(back["slugs"], ["fresh-drill"])
        report("fresh root: bootstrap, org on PostgreSQL, relaunch", "passed",
               {"first": owned.database["action"] if owned.database else "initialized+started",
                "record": record, "orgs": orgs, "relaunch": "started", "stop": stopped})

    def test_a_bootstrap_stopped_after_the_bind_resumes(self) -> None:
        root, env = self.product_root("resume")
        bound = custodian_json("bind-product", "--root", str(root), env=env)
        self.assertTrue(bound.get("ok"), bound)
        binding = (root / bracket.PRODUCT_FILE).read_bytes()
        owned = bracket.start_for_engine(root, env)
        try:
            self.assertEqual(json.loads((root / bracket.CUTOVER_FILE).read_text(encoding="utf-8"))["backend"], "postgres")
            self.assertEqual((root / bracket.PRODUCT_FILE).read_bytes(), binding, "the existing binding is re-used")
            self.assertEqual(owned.database["action"], "initialized+started")
        finally:
            owned.stop()
        report("bootstrap stopped between bind and record, next launch resumes", "passed", {"binding_kept": True})

    def test_an_existing_sqlite_store_is_left_alone(self) -> None:
        root, env = self.product_root("existing")
        sqlite_env = {k: v for k, v in env.items() if k != bracket.BOOTSTRAP_ENV}
        made = self.engine_store(root, sqlite_env, "Old Org")  # a SQLite org, as 2.x left it
        self.assertEqual(made["backend"], "sqlite")
        before = digest(root)
        self.assertIsNone(bracket.start_for_engine(root, env))
        self.assertEqual(digest(root), before, "an existing store must not be touched")
        for name in (bracket.CUTOVER_FILE, bracket.PRODUCT_FILE, "pg"):
            self.assertFalse((root / name).exists(), name)
        report("existing SQLite store under the bootstrap switch", "passed",
               {"returned": None, "files_unchanged": len(before)})

    def test_an_ambiguous_root_refuses(self) -> None:
        root, env = self.product_root("ambiguous")
        (root / "orgs" / "leftover").mkdir(parents=True)
        before = digest(root)
        with self.assertRaisesRegex(bracket.BracketError, "neither a fresh root nor an existing org store"):
            bracket.start_for_engine(root, env)
        self.assertEqual(digest(root), before)
        report("ambiguous root (an empty folder in orgs/)", "passed", {"refused": True})


if __name__ == "__main__":
    unittest.main()
